const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const pino     = require('pino');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const pool     = require('./db');

// ═══════════════════════════════════════════
// SETUP SERVER
// ═══════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// ═══════════════════════════════════════════
// STATE GLOBAL
// ═══════════════════════════════════════════
let sock        = null;
let isBlasting  = false;
let stopBlast   = false; // flag untuk stop manual

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════
// SPINTAX PARSER  →  [A|B|C] → acak per kirim
// ═══════════════════════════════════════════
function parseSpintax(text) {
    return text.replace(/\[([^\[\]]+)\]/g, (match, inner) => {
        const opts = inner.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

// ═══════════════════════════════════════════
// INISIALISASI SESI BAILEYS
// ═══════════════════════════════════════════
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth:             state,
        printQRInTerminal: false,
        logger:           pino({ level: 'silent' }),
        browser:          ['Ubuntu', 'Chrome', '111.0'],
        connectTimeoutMs: 30_000,
        retryRequestDelayMs: 2000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'open') {
            const num = sock.user?.id?.split(':')[0] || '—';
            console.log(`[WA] Terhubung sebagai ${num}`);
            io.emit('wa-status', { connected: true, number: num });
        }

        if (connection === 'close') {
            const code    = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            console.log(`[WA] Koneksi terputus. Kode: ${code} | Logout: ${loggedOut}`);
            io.emit('wa-status', { connected: false });

            if (!loggedOut) {
                console.log('[WA] Reconnect dalam 5 detik...');
                setTimeout(initWhatsApp, 5000);
            } else {
                console.log('[WA] Sesi logout. Hapus folder auth_info untuk login ulang.');
            }
        }
    });

    sock.ev.on('messages.upsert', () => {}); // listener kosong supaya event loop tidak blocked
}

// ═══════════════════════════════════════════
// API: STATUS WA (polling fallback)
// ═══════════════════════════════════════════
app.get('/api/wa-status', (req, res) => {
    const connected = !!(sock?.authState?.creds?.me);
    const number    = sock?.user?.id?.split(':')[0] || null;
    res.json({ connected, number });
});

// ═══════════════════════════════════════════
// API: REQUEST PAIRING CODE
// ═══════════════════════════════════════════
app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor WhatsApp wajib diisi' });

    try {
        if (sock?.authState?.creds?.me) {
            return res.json({ message: 'Sudah terhubung' });
        }
        const clean = phone.replace(/[^0-9]/g, '');
        const code  = await sock.requestPairingCode(clean);
        return res.json({ code });
    } catch (err) {
        console.error('[PAIR]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════
// API: TEMPLATE — CRUD
// ═══════════════════════════════════════════
app.get('/api/templates', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM templates ORDER BY id DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Judul dan isi template wajib diisi' });
    try {
        await pool.query('INSERT INTO templates (title, content) VALUES (?, ?)', [title, content]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Judul dan isi wajib diisi' });
    try {
        await pool.query('UPDATE templates SET title=?, content=? WHERE id=?', [title, content, req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM templates WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════
// API: UPLOAD TARGET + SIAPKAN ANTREAN
// ═══════════════════════════════════════════
app.post('/api/upload-targets', upload.single('file'), async (req, res) => {
    const { messageTemplate, targetLink } = req.body;

    if (!req.file || !messageTemplate || !targetLink) {
        return res.status(400).json({ error: 'Komponen file, template, dan link wajib diisi' });
    }

    try {
        const raw   = fs.readFileSync(req.file.path, 'utf-8');
        const lines = raw.split(/\r?\n/);

        // Normalisasi nomor: strip spasi/tanda, handle 0xxx → 62xxx
        const numbers = lines
            .map(line => {
                let n = line.replace(/[\s\-\(\)\.]/g, '');
                if (n.startsWith('+')) n = n.slice(1);
                else if (n.startsWith('0')) n = '62' + n.slice(1);
                return n.replace(/[^0-9]/g, '');
            })
            .filter(n => n.length >= 8 && n.length <= 15);

        // Deduplikasi
        const unique = [...new Set(numbers)];

        if (unique.length === 0)
            return res.status(400).json({ error: 'Tidak ada nomor valid di file .txt' });

        // Ganti [Link] dengan URL asli
        const finalTemplate = messageTemplate.replace(/\[Link\]/gi, targetLink);

        // Reset antrean lama, masukkan batch baru
        await pool.query('DELETE FROM blast_targets');
        const values = unique.map(num => [num, 'pending', finalTemplate]);
        await pool.query(
            'INSERT INTO blast_targets (phone_number, status, message) VALUES ?',
            [values]
        );

        fs.unlinkSync(req.file.path);

        io.emit('blast-ready', { total: unique.length });
        res.json({ success: true, total: unique.length });
    } catch (err) {
        console.error('[UPLOAD]', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════
// API: AMBIL STATUS ANTREAN (untuk reload dashboard)
// ═══════════════════════════════════════════
app.get('/api/blast-targets', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, phone_number, status, created_at FROM blast_targets ORDER BY id ASC'
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════
// API: AMBIL STATISTIK RINGKAS
// ═══════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
    try {
        const [[row]] = await pool.query(`
            SELECT
                COUNT(*) AS total,
                SUM(status = 'sent')           AS sent,
                SUM(status = 'failed')         AS failed,
                SUM(status = 'not_registered') AS skipped,
                SUM(status = 'pending')        AS pending
            FROM blast_targets
        `);
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════
// BLAST ENGINE
// ═══════════════════════════════════════════
async function startBlastEngine() {
    if (isBlasting) return;
    isBlasting = true;
    stopBlast  = false;

    console.log('[BLAST] Mesin blast dimulai.');

    try {
        const [targets] = await pool.query(
            'SELECT * FROM blast_targets WHERE status = "pending" ORDER BY id ASC'
        );

        if (targets.length === 0) {
            io.emit('blast-finished', { message: 'Tidak ada target pending.' });
            return;
        }

        for (const target of targets) {
            if (stopBlast) {
                console.log('[BLAST] Dihentikan manual.');
                break;
            }

            const jid        = `${target.phone_number}@s.whatsapp.net`;
            let   finalStatus = 'failed';
            let   delayMs     = 2000;

            try {
                // Cek apakah nomor terdaftar di WA
                const [result] = await sock.onWhatsApp(jid);

                if (!result?.exists) {
                    finalStatus = 'not_registered';
                } else {
                    const msg = parseSpintax(target.message);
                    await sock.sendMessage(jid, { text: msg });
                    finalStatus = 'sent';
                    // Delay acak 12–25 detik untuk menghindari ban
                    delayMs = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000;
                }
            } catch (sendErr) {
                console.error(`[BLAST] Gagal kirim ke ${target.phone_number}:`, sendErr.message);
                finalStatus = 'failed';
            }

            // Update DB
            await pool.query(
                'UPDATE blast_targets SET status = ? WHERE id = ?',
                [finalStatus, target.id]
            );

            // Emit realtime ke frontend
            io.emit('blast-update', {
                id:           target.id,
                phone_number: target.phone_number,
                status:       finalStatus,
            });

            await delay(delayMs);
        }
    } catch (err) {
        console.error('[BLAST] Error kritis:', err);
        io.emit('blast-error', { message: err.message });
    } finally {
        isBlasting = false;
        io.emit('blast-finished', { message: 'Distribusi antrean kampanye selesai.' });
        console.log('[BLAST] Selesai.');
    }
}

// ═══════════════════════════════════════════
// API: START BLAST
// ═══════════════════════════════════════════
app.post('/api/start-blast', (req, res) => {
    if (!sock?.authState?.creds?.me)
        return res.status(400).json({ error: 'Sesi WhatsApp belum terhubung' });
    if (isBlasting)
        return res.json({ message: 'Mesin blast sedang berjalan' });

    startBlastEngine();
    res.json({ success: true, message: 'Mesin blast berhasil diaktifkan.' });
});

// ═══════════════════════════════════════════
// API: STOP BLAST
// ═══════════════════════════════════════════
app.post('/api/stop-blast', (req, res) => {
    if (!isBlasting)
        return res.json({ message: 'Mesin blast tidak sedang berjalan' });
    stopBlast = true;
    res.json({ success: true, message: 'Sinyal stop dikirim. Blast akan berhenti setelah target saat ini selesai.' });
});

// ═══════════════════════════════════════════
// API: RESET ANTREAN
// ═══════════════════════════════════════════
app.post('/api/reset-blast', async (req, res) => {
    if (isBlasting)
        return res.status(400).json({ error: 'Hentikan blast terlebih dahulu.' });
    try {
        await pool.query('DELETE FROM blast_targets');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════
// SOCKET.IO — CLIENT CONNECT
// ═══════════════════════════════════════════
io.on('connection', (socket) => {
    console.log('[SOCKET] Client connect:', socket.id);

    // Kirim status WA saat ini saat client baru konek
    const connected = !!(sock?.authState?.creds?.me);
    const number    = sock?.user?.id?.split(':')[0] || null;
    socket.emit('wa-status', { connected, number });

    socket.on('disconnect', () => {
        console.log('[SOCKET] Client disconnect:', socket.id);
    });
});

// ═══════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`\n╔══════════════════════════════════╗`);
    console.log(`║   PANSA BLASTER — port ${PORT}      ║`);
    console.log(`╚══════════════════════════════════╝\n`);
    await initWhatsApp();
});
