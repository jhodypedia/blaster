'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const pino     = require('pino');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const pool     = require('./db');

// ═══════════════════════════════════════════════════
// EXPRESS + SOCKET.IO SETUP
// ═══════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*' },
    pingTimeout:  60000,
    pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage untuk file target (.txt) dan file media blasting
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 }, // Ditambah menjadi 50 MB untuk menampung file video/dokumen besar
});

// ═══════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════
let sock          = null;
let isConnected   = false;
let isBlasting    = false;
let stopFlag      = false;
let reconnectTimer = null;
let reconnectCount = 0;
let lastQrCode    = null; 
const MAX_RECONNECT = 999; 

const log = pino({ level: 'silent' }); 
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════
// HELPER LOGIC
// ═══════════════════════════════════════════════════
function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\[([^\[\]]+)\]/g, (_, inner) => {
        const opts = inner.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

function emitLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('id-ID');
    io.emit('terminal-log', { ts, msg, type });
    const pfx = { info: '[ ]', ok: '[✓]', err: '[✗]', warn: '[!]' }[type] || '[ ]';
    console.log(`${pfx} ${ts} ${msg}`);
}

// Helper untuk menebak jenis mime-type file media blast
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimes = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return mimes[ext] || 'application/octet-stream';
}

// ═══════════════════════════════════════════════════
// INISIALISASI BAILEYS CORE FULL FEATURES
// ═══════════════════════════════════════════════════
async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version }          = await fetchLatestBaileysVersion();

        emitLog(`Baileys Core Engine v${version.join('.')} — Mengonfigurasi modul...`, 'info');

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, log),
            },
            logger:           log,
            printQRInTerminal: false,
            browser:          ['PANSA GROUP', 'Safari', '18.0'], // Profiling device pengetikan modern
            
            connectTimeoutMs:       60_000, 
            defaultQueryTimeoutMs:  60_000,
            keepAliveIntervalMs:    15_000, 
            syncFullHistory:        false,  // Ringankan beban sinkronisasi riwayat pesan awal
            markOnlineOnConnect:    true,   // Status online aktif saat mesin hidup
            
            retryRequestDelayMs:    3_000,
            maxMsgRetryCount:       5,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
        });

        sock.ev.on('creds.update', saveCreds);

        // FEATURE: Realtime Connection Updates, QR Supplier, & Crash Handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, reason: closeReason } = update;

            if (qr) {
                lastQrCode = qr;
                io.emit('wa-qr', { qr });
            }

            if (connection === 'connecting') {
                emitLog('Membangun jala komunikasi ke server WhatsApp...', 'info');
                io.emit('wa-status', { connected: false, status: 'connecting' });
            }

            if (connection === 'open') {
                reconnectCount = 0;
                isConnected    = true;
                lastQrCode     = null;
                const number   = sock.user?.id?.split(':')[0] || '—';
                emitLog(`WhatsApp Terhubung Sukses! Nomor: ${number}`, 'ok');
                io.emit('wa-status', { connected: true, status: 'connected', number });
            }

            if (connection === 'close') {
                isConnected = false;
                lastQrCode  = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason     = lastDisconnect?.error?.message || closeReason || 'Unknown';

                emitLog(`Jaringan Terputus. Status Code: ${statusCode} — ${reason}`, 'warn');
                io.emit('wa-status', { connected: false, status: 'disconnected' });

                // Sesi Kedaluwarsa / Logout Paksa dari HP
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    emitLog('Sesi kedaluwarsa atau dikeluarkan. Membersihkan repositori data auth...', 'err');
                    io.emit('wa-status', { connected: false, status: 'logged_out' });
                    try {
                        sock.ev.removeAllListeners('connection.update');
                        sock.end();
                    } catch (_) {}
                    fs.rmSync('auth_info', { recursive: true, force: true });
                    setTimeout(initWhatsApp, 3000);
                    return;
                }

                // Sesi Timeout saat Proses Tautkan Perangkat (Error 428 / 408)
                const isBelumLogin = !sock?.authState?.creds?.me;
                if (isBelumLogin && (statusCode === 428 || statusCode === 408 || reason.includes('Timed Out'))) {
                    emitLog('Timeout autentikasi terdeteksi. Melakukan penyegaran socket clean-state...', 'warn');
                    if (sock) {
                        try {
                            sock.ev.removeAllListeners('connection.update');
                            sock.end();
                            sock.ws.close();
                        } catch(_) {}
                    }
                    setTimeout(() => {
                        try { fs.rmSync('auth_info', { recursive: true, force: true }); } catch (e) {}
                        io.emit('wa-status', { connected: false, status: 'logged_out' });
                        setTimeout(initWhatsApp, 3000);
                    }, 1500);
                    return; 
                }

                if (statusCode === DisconnectReason.connectionReplaced) {
                    emitLog('Sesi digantikan oleh instansi perangkat lain.', 'warn');
                }

                scheduleReconnect();
            }
        });

        // FEATURE: Interactive Autoreply Chatbot & Read Status Automations
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const { messages, type } = chatUpdate;
                if (type !== 'notify') return;

                for (const msg of messages) {
                    if (msg.key.fromMe || !msg.message) continue;
                    
                    const fromJid = msg.key.remoteJid;
                    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    
                    // Otomatis tandai pesan masuk sebagai "Telah Dibaca" (Read Receipt)
                    await sock.readMessages([msg.key]);

                    // Fitur Chatbot Dasar Pendukung Operasional PANSA GROUP
                    if (textContent.toLowerCase() === 'p') {
                        // Simulasi indikasi mengetik (typing status)
                        await sock.sendPresenceUpdate('composing', fromJid);
                        await delay(1000);
                        await sock.sendMessage(fromJid, { text: 'Halo, ada yang bisa kami bantu? Ketik *Menu* untuk bantuan operasional.' });
                        await sock.sendPresenceUpdate('paused', fromJid);
                    }
                }
            } catch (err) {
                console.error('[INCOMING MESSAGE ERROR]', err);
            }
        });

    } catch (err) {
        emitLog(`Inisialisasi engine gagal fatal: ${err.message}`, 'err');
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (!sock?.authState?.creds?.me) return;

    const base   = Math.min(5000 * Math.pow(2, reconnectCount), 120_000);
    const wait   = base + Math.floor(Math.random() * 3000);

    reconnectCount++;
    emitLog(`Mencoba pemulihan jaringan ke-${reconnectCount} dalam ${Math.round(wait / 1000)} detik...`, 'info');

    reconnectTimer = setTimeout(async () => {
        try { sock?.ws?.close(); } catch (_) {}
        await initWhatsApp();
    }, wait);
}

// ═══════════════════════════════════════════════════
// INSTANT INFRASTRUCTURE API ENDPOINTS
// ═══════════════════════════════════════════════════
app.get('/api/wa-status', (req, res) => {
    const number = sock?.user?.id?.split(':')[0] || null;
    res.json({ connected: isConnected, number, qr: lastQrCode });
});

app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor wajib diisi' });

    try {
        if (isConnected || sock?.authState?.creds?.me) {
            return res.json({ message: 'WhatsApp sudah terhubung.' });
        }
        if (!sock) return res.status(503).json({ error: 'Socket engine belum siap.' });

        const clean = phone.replace(/[^0-9]/g, '');
        if (clean.length < 8) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid' });

        emitLog(`Meminta pairing token transaksi untuk nomor ${clean}...`, 'info');
        await delay(1500);

        let code = await sock.requestPairingCode(clean);
        code = code?.replace(/-/g, '')?.match(/.{1,4}/g)?.join('-') || code;

        emitLog(`Pairing code berhasil didapat: ${code}`, 'ok');
        res.json({ code });
    } catch (err) {
        emitLog(`Pairing error: ${err.message}`, 'err');
        res.status(500).json({ error: 'Gagal memproses kode pairing dari server WhatsApp.' });
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        if (sock && isConnected) await sock.logout();
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.end();
        } catch (_) {}

        fs.rmSync('auth_info', { recursive: true, force: true });
        emitLog('Sesi otentikasi dibersihkan secara total.', 'warn');
        io.emit('wa-status', { connected: false, status: 'logged_out' });
        
        setTimeout(initWhatsApp, 3000);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// FEATURE: Fetch Metadata Profil & Avatar Menggunakan Method Asli Baileys
app.get('/api/wa-profile', async (req, res) => {
    const { phone } = req.query;
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp belum aktif' });
    if (!phone) return res.status(400).json({ error: 'Query nomor telepon wajib dilampirkan' });

    try {
        const jid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        const profileUrl = await sock.profilePictureUrl(jid, 'image').catch(() => null);
        const statusMetadata = await sock.fetchStatus(jid).catch(() => null);

        res.json({
            jid,
            avatar_url: profileUrl || 'No Profile Picture Available',
            status_bio: statusMetadata?.status || 'No Bio Status Available',
            status_update_at: statusMetadata?.setAt || '—'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// FEATURE: Kirim Pesan Media Instan Tunggal (Gambar, Dokumen, Video, Audio)
app.post('/api/send-media', upload.single('media'), async (req, res) => {
    const { phone, caption, type } = req.body; // type: image | document | video | audio
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp belum terhubung' });
    if (!phone || !req.file || !type) return res.status(400).json({ error: 'Komponen file media atau nomor target tidak lengkap' });

    try {
        const jid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        const fileMime = getMimeType(req.file.path);
        const fileBuffer = fs.readFileSync(req.file.path);
        
        let payload = {};
        if (type === 'image') payload = { image: fileBuffer, caption: caption || '' };
        else if (type === 'video') payload = { video: fileBuffer, caption: caption || '' };
        else if (type === 'audio') payload = { audio: fileBuffer, ptt: false };
        else payload = { document: fileBuffer, mimetype: fileMime, fileName: req.file.originalname, caption: caption || '' };

        await sock.sendMessage(jid, payload);
        fs.unlinkSync(req.file.path); // Hapus file temporary di disk setelah dikirim
        res.json({ success: true, message: `Media ${type} berhasil dikirim.` });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// TEMPLATE & QUEUE CORE REST ARCHITECTURE
// ═══════════════════════════════════════════════════
app.get('/api/templates', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM templates ORDER BY id DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', async (req, res) => {
    const { title, content } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Judul dan isi wajib diisi' });
    try {
        const [r] = await pool.query('INSERT INTO templates (title, content) VALUES (?, ?)', [title.trim(), content.trim()]);
        res.json({ success: true, id: r.insertId });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', async (req, res) => {
    const { title, content } = req.body;
    if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Judul dan isi wajib diisi' });
    try {
        await pool.query('UPDATE templates SET title=?, content=? WHERE id=?', [title.trim(), content.trim(), req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM templates WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload-targets', upload.single('file'), async (req, res) => {
    const { messageTemplate, targetLink } = req.body;
    if (!req.file || !messageTemplate || !targetLink) return res.status(400).json({ error: 'Komponen data upload tidak lengkap' });

    try {
        const raw   = fs.readFileSync(req.file.path, 'utf-8');
        const lines = raw.split(/\r?\n/);

        const numbers = lines.map(line => {
            let n = line.replace(/[\s\-\(\)\.]/g, '');
            if (n.startsWith('+'))      n = n.slice(1);
            else if (n.startsWith('0')) n = '62' + n.slice(1);
            return n.replace(/[^0-9]/g, '');
        }).filter(n => n.length >= 8 && n.length <= 15);

        const unique = [...new Set(numbers)];
        if (!unique.length) return res.status(400).json({ error: 'Tidak ada nomor valid di file' });

        const finalTemplate = messageTemplate.replace(/\[Link\]/gi, targetLink);

        await pool.query('DELETE FROM blast_targets');
        const values = unique.map(n => [n, 'pending', finalTemplate]);
        await pool.query('INSERT INTO blast_targets (phone_number, status, message) VALUES ?', [values]);

        fs.unlinkSync(req.file.path);
        emitLog(`Upload sukses: ${unique.length} target dimuat`, 'ok');
        io.emit('blast-ready', { total: unique.length });
        res.json({ success: true, total: unique.length });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', async (req, res) => {
    try {
        const [[row]] = await pool.query(`
            SELECT
                COUNT(*)                        AS total,
                SUM(status = 'sent')            AS sent,
                SUM(status = 'failed')          AS failed,
                SUM(status = 'not_registered')  AS skipped,
                SUM(status = 'pending')         AS pending
            FROM blast_targets
        `);
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/blast-targets', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, phone_number, status, updated_at FROM blast_targets ORDER BY id DESC LIMIT 500');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// BLAST ENGINE AUTOMATION LOOPER
// ═══════════════════════════════════════════════════
async function startBlastEngine() {
    if (isBlasting) return;
    isBlasting = true;
    stopFlag   = false;

    emitLog('Mesin blast diaktifkan.', 'ok');
    io.emit('blast-started');

    try {
        const [targets] = await pool.query('SELECT * FROM blast_targets WHERE status = "pending" ORDER BY id ASC');
        if (!targets.length) {
            emitLog('Tidak ada target antrean berstatus pending.', 'warn');
            return;
        }

        emitLog(`Memproses pengiriman kampanye massal ke ${targets.length} target...`, 'info');

        for (const target of targets) {
            if (stopFlag) { emitLog('Proses blast dihentikan paksa manual.', 'warn'); break; }

            if (!isConnected) {
                emitLog('WhatsApp terputus, menahan iterasi antrean looper...', 'warn');
                while (!isConnected) { await delay(2000); }
                emitLog('Koneksi terjalin kembali, melanjutkan aktivitas blast.', 'info');
            }

            const jid = `${target.phone_number}@s.whatsapp.net`;
            let status = 'failed';
            let waitMs = 2000;

            try {
                // FEATURE: Sinkronisasi Status WhatsApp On-Network Berdasarkan Aturan Resmi Baileys
                const [check] = await sock.onWhatsApp(jid);
                if (!check?.exists) {
                    status = 'not_registered';
                } else {
                    const msg = parseSpintax(target.message);

                    // Simulasi Kehadiran Interaktif (Typing Status) Sebelum Mengirim Pesan Massal (Mencegah Banned Heuristik Meta)
                    await sock.sendPresenceUpdate('composing', jid);
                    await delay(Math.floor(Math.random() * 2000) + 1000);
                    await sock.sendPresenceUpdate('paused', jid);

                    await sock.sendMessage(jid, { text: msg });
                    status = 'sent';
                    
                    // Delay acak pelindung algoritma anti-banned (12-25 Detik)
                    waitMs = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000; 
                }
            } catch (err) {
                emitLog(`Gagal memproses pengiriman kontak ${target.phone_number}: ${err.message}`, 'err');
                status = 'failed';
                waitMs = 4000;
            }

            await pool.query('UPDATE blast_targets SET status = ? WHERE id = ?', [status, target.id]);
            io.emit('blast-update', { id: target.id, phone_number: target.phone_number, status });

            await delay(waitMs);
        }
    } catch (err) {
        emitLog(`Blast engine fatal crash: ${err.message}`, 'err');
    } finally {
        isBlasting = false;
        io.emit('blast-finished', { message: 'Pendistribusian kampanye massal selesai.' });
        emitLog('Mesin blast kembali ke mode idle.', 'ok');
    }
}

app.post('/api/start-blast', (req, res) => {
    if (!isConnected) return res.status(400).json({ error: 'WhatsApp belum terhubung' });
    if (isBlasting) return res.json({ message: 'Blast sedang berjalan' });
    startBlastEngine();
    res.json({ success: true });
});

app.post('/api/stop-blast', (req, res) => {
    if (!isBlasting) return res.json({ message: 'Blast tidak sedang berjalan' });
    stopFlag = true;
    res.json({ success: true, message: 'Sinyal interupsi ditransmisikan.' });
});

app.post('/api/reset-blast', async (req, res) => {
    if (isBlasting) return res.status(400).json({ error: 'Hentikan mesin blast terlebih dahulu.' });
    try {
        await pool.query('DELETE FROM blast_targets');
        io.emit('blast-reset');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// SOCKET INTERCONNECTION HANDSHAKE
// ═══════════════════════════════════════════════════
io.on('connection', (socket) => {
    const number = sock?.user?.id?.split(':')[0] || null;
    socket.emit('wa-status', {
        connected: isConnected,
        status:    isConnected ? 'connected' : 'disconnected',
        number,
        qr: lastQrCode
    });
    socket.emit('blast-state', { isBlasting });

    // Menyediakan sinkronisasi QR Code jika di-request instan dari client
    if (lastQrCode && !isConnected) {
        socket.emit('wa-qr', { qr: lastQrCode });
    }
});

// ═══════════════════════════════════════════════════
// INITIALIZE SERVERS
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log(`║   PANSA GROUP BLASTER → Port ${PORT}    ║`);
    console.log('╚══════════════════════════════════════╝\n');
    await initWhatsApp();
});
