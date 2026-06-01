'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
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
// EXPRESS + SOCKET.IO
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

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 10 * 1024 * 1024 }, // maks 10 MB
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
const MAX_RECONNECT = 999; 

const log = pino({ level: 'silent' }); 
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════
// HELPER: SPINTAX  [A|B|C] → random per kirim
// ═══════════════════════════════════════════════════
function parseSpintax(text) {
    return text.replace(/\[([^\[\]]+)\]/g, (_, inner) => {
        const opts = inner.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

// ═══════════════════════════════════════════════════
// HELPER: EMIT LOG KE SEMUA CLIENT
// ═══════════════════════════════════════════════════
function emitLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('id-ID');
    io.emit('terminal-log', { ts, msg, type });
    const pfx = { info: '[ ]', ok: '[✓]', err: '[✗]', warn: '[!]' }[type] || '[ ]';
    console.log(`${pfx} ${ts} ${msg}`);
}

// ═══════════════════════════════════════════════════
// INISIALISASI BAILEYS CORE
// ═══════════════════════════════════════════════════
async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version }          = await fetchLatestBaileysVersion();

        emitLog(`Baileys Engine v${version.join('.')} — menginisialisasi...`, 'info');

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, log),
            },
            logger:           log,
            printQRInTerminal: false,
            browser:          ['PANSA BLASTER', 'Chrome', '120.0'],
            
            connectTimeoutMs:       60_000, 
            defaultQueryTimeoutMs:  60_000,
            keepAliveIntervalMs:    10_000, 
            syncFullHistory:        false,  
            
            retryRequestDelayMs:    2_000,
            maxMsgRetryCount:       3,
            markOnlineOnConnect:    false,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, reason: closeReason } = update;

            if (connection === 'connecting') {
                emitLog('Menghubungkan ke WhatsApp...', 'info');
                io.emit('wa-status', { connected: false, status: 'connecting' });
            }

            if (connection === 'open') {
                reconnectCount = 0;
                isConnected    = true;
                const number   = sock.user?.id?.split(':')[0] || '—';
                emitLog(`WhatsApp terhubung: ${number}`, 'ok');
                io.emit('wa-status', { connected: true, status: 'connected', number });
            }

            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason     = lastDisconnect?.error?.message || closeReason || 'Unknown';

                emitLog(`Koneksi terputus. Code: ${statusCode} — ${reason}`, 'warn');
                io.emit('wa-status', { connected: false, status: 'disconnected' });

                // 1. HANDLER JIKA LOGOUT PERMANEN (ERROR 401 / MANUAL LOGOUT)
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    emitLog('Sesi di-terminate atau logout permanen oleh server WhatsApp.', 'err');
                    io.emit('wa-status', { connected: false, status: 'logged_out' });
                    
                    try {
                        sock.ev.removeAllListeners('connection.update');
                        sock.end();
                    } catch (_) {}
                    
                    fs.rmSync('auth_info', { recursive: true, force: true });
                    return;
                }

                // 2. AUTOMATIC CLEAN RE-GENERATE UNTUK PAIRING TIMEOUT (ERROR 428 / 408)
                const isBelumLogin = !sock?.authState?.creds?.me;
                if (isBelumLogin && (statusCode === 428 || statusCode === 408 || reason.includes('Timed Out'))) {
                    emitLog('Pairing timeout terdeteksi. Mematikan socket secara aman...', 'warn');
                    
                    if (sock) {
                        try {
                            sock.ev.removeAllListeners('connection.update');
                            sock.end();
                            sock.ws.close();
                        } catch(_) {}
                    }
                    
                    // Jeda I/O operasi file
                    setTimeout(() => {
                        try {
                            fs.rmSync('auth_info', { recursive: true, force: true });
                            emitLog('Folder beralih ke state bersih.', 'ok');
                        } catch (e) {
                            console.error('Gagal hapus file kotor:', e.message);
                        }
                        
                        io.emit('wa-status', { connected: false, status: 'logged_out' });
                        emitLog('Sistem siap menerima request pairing baru dalam 3 detik.', 'info');
                        setTimeout(initWhatsApp, 3000);
                    }, 1500);

                    return; 
                }

                if (statusCode === DisconnectReason.connectionReplaced) {
                    emitLog('Sesi digantikan perangkat lain.', 'warn');
                }

                // Lakukan reconnect berkala hanya jika perangkat sudah ter-pairing sebelumnya
                scheduleReconnect();
            }
        });

        sock.ev.on('messages.upsert', () => {});

    } catch (err) {
        emitLog(`initWhatsApp error: ${err.message}`, 'err');
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    
    if (!sock?.authState?.creds?.me) {
        emitLog('Sesi kosong. Menunggu instruksi pairing dari dashboard.', 'info');
        return;
    }

    if (reconnectCount >= MAX_RECONNECT) {
        emitLog('Batas maksimum reconnect tercapai.', 'err');
        return;
    }

    const base   = Math.min(5000 * Math.pow(2, reconnectCount), 120_000);
    const jitter = Math.floor(Math.random() * 3000);
    const wait   = base + jitter;

    reconnectCount++;
    emitLog(`Reconnect ke-${reconnectCount} dalam ${Math.round(wait / 1000)}s...`, 'info');

    reconnectTimer = setTimeout(async () => {
        try { sock?.ws?.close(); } catch (_) {}
        await initWhatsApp();
    }, wait);
}

// ═══════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════
app.get('/api/wa-status', (req, res) => {
    const number = sock?.user?.id?.split(':')[0] || null;
    res.json({ connected: isConnected, number });
});

app.post('/api/request-pairing', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Nomor wajib diisi' });

    try {
        if (isConnected || sock?.authState?.creds?.me) {
            return res.json({ message: 'WhatsApp sudah terhubung.' });
        }
        if (!sock) {
            return res.status(503).json({ error: 'Socket belum siap, silakan tunggu sebentar.' });
        }

        const clean = phone.replace(/[^0-9]/g, '');
        if (clean.length < 8) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid' });

        emitLog(`Meminta pairing code untuk nomor ${clean}...`, 'info');
        await delay(1500);

        let code = await sock.requestPairingCode(clean);
        code = code?.replace(/-/g, '')?.match(/.{1,4}/g)?.join('-') || code;

        emitLog(`Pairing code berhasil didapat: ${code}`, 'ok');
        res.json({ code });

    } catch (err) {
        emitLog(`Pairing error: ${err.message}`, 'err');
        const errMsg = err.message || '';
        if (errMsg.includes('rate-overlimit') || errMsg.includes('429')) {
            return res.status(429).json({ error: 'Terlalu banyak permintaan kode. Silakan tunggu beberapa menit.' });
        } 
        res.status(500).json({ error: 'Gagal mendapatkan pairing code dari server WhatsApp.' });
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
        emitLog('Sesi WA dihapus. Silakan pairing ulang.', 'warn');
        io.emit('wa-status', { connected: false, status: 'logged_out' });
        
        setTimeout(initWhatsApp, 3000);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// API: TEMPLATE CRUD
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

// ═══════════════════════════════════════════════════
// API: QUEUE & TARGET MANAGEMENT
// ═══════════════════════════════════════════════════
app.post('/api/upload-targets', upload.single('file'), async (req, res) => {
    const { messageTemplate, targetLink } = req.body;
    if (!req.file || !messageTemplate || !targetLink) return res.status(400).json({ error: 'Komponen file, template, dan link wajib diisi' });

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
// BLAST ENGINE LOOPER
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
            emitLog('Tidak ada target pending.', 'warn');
            return;
        }

        emitLog(`Memproses ${targets.length} target...`, 'info');

        for (const target of targets) {
            if (stopFlag) { emitLog('Blast dihentikan manual.', 'warn'); break; }

            if (!isConnected) {
                emitLog('WA terputus, menunggu reconnect...', 'warn');
                let waited = 0;
                while (!isConnected && waited < 60000) {
                    await delay(2000);
                    waited += 2000;
                }
                if (!isConnected) {
                    emitLog('Timeout menunggu WA — blast dihentikan.', 'err');
                    break;
                }
            }

            const jid = `${target.phone_number}@s.whatsapp.net`;
            let status = 'failed';
            let waitMs = 2000;

            try {
                const [check] = await sock.onWhatsApp(jid);
                if (!check?.exists) {
                    status = 'not_registered';
                } else {
                    const msg = parseSpintax(target.message);
                    await sock.sendMessage(jid, { text: msg });
                    status = 'sent';
                    waitMs = Math.floor(Math.random() * (25000 - 12000 + 1)) + 12000; // Jeda anti-banned 12-25 detik
                }
            } catch (err) {
                emitLog(`Gagal kirim ${target.phone_number}: ${err.message}`, 'err');
                status = 'failed';
                waitMs = 3000;
            }

            await pool.query('UPDATE blast_targets SET status = ? WHERE id = ?', [status, target.id]);
            io.emit('blast-update', { id: target.id, phone_number: target.phone_number, status });

            await delay(waitMs);
        }
    } catch (err) {
        emitLog(`Blast engine error: ${err.message}`, 'err');
    } finally {
        isBlasting = false;
        io.emit('blast-finished', { message: 'Distribusi kampanye selesai.' });
        emitLog('Mesin blast selesai.', 'ok');
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
    res.json({ success: true, message: 'Sinyal stop dikirim.' });
});

app.post('/api/reset-blast', async (req, res) => {
    if (isBlasting) return res.status(400).json({ error: 'Hentikan blast terlebih dahulu.' });
    try {
        await pool.query('DELETE FROM blast_targets');
        io.emit('blast-reset');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// SOCKET HANDSHAKE
// ═══════════════════════════════════════════════════
io.on('connection', (socket) => {
    const number = sock?.user?.id?.split(':')[0] || null;
    socket.emit('wa-status', {
        connected: isConnected,
        status:    isConnected ? 'connected' : 'disconnected',
        number,
    });
    socket.emit('blast-state', { isBlasting });
});

// ═══════════════════════════════════════════════════
// BOOTSTRAPPER
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log(`║   PANSA BLASTER aktif → port ${PORT}    ║`);
    console.log('╚══════════════════════════════════════╝\n');
    await initWhatsApp();
});
