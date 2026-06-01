const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const multer = require('multer');
const fs = require('fs');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

let sock = null;
let isBlasting = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parser Spintax: Mengacak variasi pesan [A|B] secara dinamis per nomor target
const parseSpintax = (text) => {
    const matches = text.match(/\[([^\]]+)\]/g);
    if (!matches) return text;
    let result = text;
    matches.forEach(match => {
        const options = match.slice(1, -1).split('|');
        const randomOption = options[Math.floor(Math.random() * options.length)];
        result = result.replace(match, randomOption);
    });
    return result;
};

// Inisialisasi Sesi Baileys WhatsApp
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Ubuntu', 'Chrome', '111.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            io.emit('wa-status', { connected: true, number: sock.user.id.split(':')[0] });
        } else if (connection === 'close') {
            io.emit('wa-status', { connected: false });
            setTimeout(initWhatsApp, 5000);
        }
    });
}

// API: Meminta Kode Pairing Perangkat (Mendukung Nomor Global)
app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor WhatsApp wajib diisi' });
    try {
        if (!sock.authState.creds.me && !sock.authState.creds.registered) {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            const code = await sock.requestPairingCode(cleanPhone.trim());
            return res.json({ code });
        }
        res.json({ message: 'Sudah terhubung' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API TEMPLATE: Ambil Semua Template dari Database
app.get('/api/templates', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM templates ORDER BY id DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API TEMPLATE: Simpan Template Baru ke Database
app.post('/api/templates', async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Judul dan isi template wajib diisi' });
    try {
        await pool.query('INSERT INTO templates (title, content) VALUES (?, ?)', [title, content]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API TEMPLATE: Hapus Template dari Database
app.delete('/api/templates/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM templates WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API KAMPANYE: Upload File Target (.txt) & Parsing Gabungan dengan Template Terpilih
app.post('/api/upload-targets', upload.single('file'), async (req, res) => {
    const { messageTemplate, targetLink } = req.body;
    if (!req.file || !messageTemplate || !targetLink) {
        return res.status(400).json({ error: 'Komponen file, template, dan link wajib diisi' });
    }

    try {
        const fileContent = fs.readFileSync(req.file.path, 'utf-8');
        const lines = fileContent.split(/\r?\n/);
        
        // Pembersihan & Normalisasi Format Nomor Global Murni
        const numbers = lines.map(line => {
            let num = line.replace(/[\s\-\(\)]/g, '');
            if (num.startsWith('+')) num = num.slice(1);
            else if (num.startsWith('0')) num = '62' + num.slice(1);
            num = num.replace(/[^0-9]/g, '');
            return num;
        }).filter(num => num.length >= 10);

        if (numbers.length === 0) return res.status(400).json({ error: 'Tidak ada nomor target yang valid di file .txt' });

        // Ganti tag penanda [Link] dengan tautan promosi asli dari frontend
        const finalTemplate = messageTemplate.replace(/\[Link\]/gi, targetLink);

        // Reset antrean lama di DB, lalu masukkan kumpulan antrean kampanye baru
        await pool.query('DELETE FROM blast_targets');
        const values = numbers.map(num => [num, 'pending', finalTemplate]);
        await pool.query('INSERT INTO blast_targets (phone_number, status, message) VALUES ?', [values]);

        fs.unlinkSync(req.file.path);
        io.emit('blast-ready', { total: numbers.length });
        res.json({ success: true, total: numbers.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mesin Pemroses Utama Distribusi Pesan (Blast Engine)
async function startBlastEngine() {
    if (isBlasting) return;
    isBlasting = true;

    try {
        const [targets] = await pool.query('SELECT * FROM blast_targets WHERE status = "pending"');
        
        for (const target of targets) {
            if (!isBlasting) break;

            const jid = `${target.phone_number}@s.whatsapp.net`;
            let finalStatus = 'sent';

            try {
                // VALIDASI REAL-TIME GLOBAL: Lewati otomatis jika nomor tidak memiliki akun WhatsApp aktif
                const [result] = await sock.onWhatsApp(jid);

                if (!result || !result.exists) {
                    finalStatus = 'not_registered';
                } else {
                    // Eksekusi spintax acak tepat sebelum dikirim ke gateway WhatsApp
                    const finalMessageToSend = parseSpintax(target.message);
                    await sock.sendMessage(jid, { text: finalMessageToSend });
                }
            } catch (sendErr) {
                finalStatus = 'failed';
            }

            // Update status log ke tabel database MySQL
            await pool.query('UPDATE blast_targets SET status = ? WHERE id = ?', [finalStatus, target.id]);

            // Pancarkan log realtime ke UI Dashboard utama via WebSockets
            io.emit('blast-update', {
                id: target.id,
                phone_number: target.phone_number,
                status: finalStatus
            });

            // Delay Cerdas & Acak untuk Menghindari Deteksi Pola Bot (Anti-Banned)
            if (finalStatus === 'sent') {
                const randomDelayTime = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000; // Jeda aman 12-25 detik
                await delay(randomDelayTime);
            } else {
                await delay(2000); // Jeda cepat 2 detik untuk menghemat waktu jika nomor mati/tidak terdaftar
            }
        }
    } catch (err) {
        console.error('Mesin blast mengalami gangguan sistem:', err);
    } finally {
        isBlasting = false;
        io.emit('blast-finished', { message: 'Distribusi antrean kampanye selesai.' });
    }
}

// API: Trigger Menjalankan Mesin Blast
app.post('/api/start-blast', (req, res) => {
    if (!sock || !sock.authState.creds.me) return res.status(400).json({ error: 'Sesi WhatsApp belum terhubung' });
    if (isBlasting) return res.json({ message: 'Mesin blast sedang berjalan' });
    
    startBlastEngine();
    res.json({ success: true, message: 'Mesin blast berhasil diaktifkan.' });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server PANSA GROUP aktif di http://localhost:${PORT}`);
    initWhatsApp();
});
