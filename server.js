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

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*' },
    pingTimeout:  60000,
    pingInterval: 25000,
});

// Setup View Engine EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 20 * 1024 * 1024 } // 20 MB Max File
});

// ═══════════════════════════════════════════════════
// INSTANCE STORAGE & RUNTIME MUTEX
// ═══════════════════════════════════════════════════
const sessions = {}; 
let isBlasting = false;
let stopFlag = false;
const log = pino({ level: 'silent' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function emitLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('id-ID');
    io.emit('terminal-log', { ts, msg, type });
    const pfx = { info: '[ ]', ok: '[✓]', err: '[✗]', warn: '[!]' }[type] || '[ ]';
    console.log(`${pfx} ${ts} ${msg}`);
}

function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\[([^\[\]]+)\]/g, (_, inner) => {
        const opts = inner.split('|');
        return opts[Math.floor(Math.random() * opts.length)];
    });
}

// ═══════════════════════════════════════════════════
// MULTI-SESSION INSTANCE INITIALIZER (FIXED CORE)
// ═══════════════════════════════════════════════════
async function initWhatsApp(sessionId) {
    if (sessions[sessionId] && sessions[sessionId].connected) return sessions[sessionId];

    const sessionPath = path.join(__dirname, 'auth_info', sessionId);
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version }          = await fetchLatestBaileysVersion();

        emitLog(`Inisialisasi core [${sessionId}] Baileys Engine v${version.join('.')}`, 'info');

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, log),
            },
            logger: log,
            printQRInTerminal: false,
            browser: ['PANSA GROUP', 'Safari', '18.0'],
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 60_000,
            keepAliveIntervalMs: 15_000,
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        // Daftarkan/perbarui referensi di runtime storage memory
        sessions[sessionId] = {
            sock,
            connected: false,
            number: state.creds?.me?.id?.split(':')[0] || null,
            qr: null
        };

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, reason: closeReason } = update;

            if (qr) {
                sessions[sessionId].qr = qr;
                io.emit('wa-qr-update', { sessionId, qr });
            }

            if (connection === 'connecting') {
                io.emit('wa-instance-status', { sessionId, connected: false, status: 'connecting' });
            }

            if (connection === 'open') {
                sessions[sessionId].connected = true;
                sessions[sessionId].qr = null;
                const number = sock.user?.id?.split(':')[0] || '—';
                sessions[sessionId].number = number;
                
                emitLog(`Device [${sessionId}] Terhubung Sukses: ${number}`, 'ok');
                io.emit('wa-instance-status', { sessionId, connected: true, status: 'connected', number });
            }

            if (connection === 'close') {
                sessions[sessionId].connected = false;
                sessions[sessionId].qr = null;
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason     = lastDisconnect?.error?.message || closeReason || 'Unknown';

                emitLog(`Device [${sessionId}] Putus Sesi. Code: ${statusCode} — ${reason}`, 'warn');
                io.emit('wa-instance-status', { sessionId, connected: false, status: 'disconnected' });

                // 1. HANDLER JIKA LOGOUT PERMANEN (ERROR 401 / MANUAL LOGOUT)
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    emitLog(`Kredensial Perangkat [${sessionId}] Mati/Logout. Disk wipe out...`, 'err');
                    try {
                        sock.ev.removeAllListeners('connection.update');
                        sock.end();
                    } catch (_) {}
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    delete sessions[sessionId];
                    io.emit('wa-instance-deleted', { sessionId });
                    return;
                }

                // 2. AUTOMATIC CLEAN RE-GENERATE UNTUK PAIRING TIMEOUT (ERROR 428 / 408)
                const isBelumLogin = !sock?.authState?.creds?.me;
                if (isBelumLogin && (statusCode === 428 || statusCode === 408 || reason.includes('Timed Out'))) {
                    emitLog(`Proses pairing/QR pada [${sessionId}] kedaluwarsa. Menutup node secara aman...`, 'warn');
                    try {
                        sock.ev.removeAllListeners('connection.update');
                        sock.end();
                        sock.ws.close();
                    } catch(_) {}
                    
                    setTimeout(() => {
                        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                        delete sessions[sessionId];
                        io.emit('wa-instance-deleted', { sessionId });
                        emitLog(`Sesi kotor [${sessionId}] berhasil dibersihkan dari memori.`, 'ok');
                    }, 1000);
                    return; 
                }

                if (statusCode === DisconnectReason.connectionReplaced) {
                    emitLog(`Sesi perangkat [${sessionId}] digantikan oleh instansi lain.`, 'warn');
                }

                // 3. HANDLER UNTUK RESTART REQUIRED / NETWORK INTERRUPT (515, 503, RTO)
                if (!isBelumLogin) {
                    let delayReconnect = 5000;
                    if (statusCode === 515) {
                        emitLog(`Server WA meminta refresh stream (515) pada [${sessionId}]. Reconnecting cepat...`, 'info');
                        delayReconnect = 2000; 
                    }
                    setTimeout(() => initWhatsApp(sessionId), delayReconnect);
                } else {
                    // Pengaman sekunder jika terputus saat belum login dengan status kode selain 428/408
                    try { sock.ev.removeAllListeners('connection.update'); sock.end(); } catch(_) {}
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    delete sessions[sessionId];
                    io.emit('wa-instance-deleted', { sessionId });
                }
            }
        });

        return sessions[sessionId];
    } catch (err) {
        emitLog(`Gagal memuat instance [${sessionId}]: ${err.message}`, 'err');
    }
}

function loadExistingSessions() {
    const dir = path.join(__dirname, 'auth_info');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        if (fs.statSync(path.join(dir, file)).isDirectory() && file.startsWith('dev_')) {
            initWhatsApp(file);
        }
    });
}

// ═══════════════════════════════════════════════════
// SYSTEM REST API ENDPOINTS
// ═══════════════════════════════════════════════════

// Core Render Shell SPA
app.get('/', async (req, res) => {
    try {
        const [templates] = await pool.query('SELECT * FROM templates ORDER BY id DESC');
        res.render('dashboard', { initialTemplates: templates });
    } catch (err) {
        res.status(500).send('Database MySQL Connection Error');
    }
});

// Device Session Manager API
app.get('/api/wa-sessions', (req, res) => {
    const list = Object.keys(sessions).map(id => ({
        sessionId: id,
        connected: sessions[id].connected,
        number: sessions[id].number,
        qr: sessions[id].qr
    }));
    res.json(list);
});

app.post('/api/create-session', async (req, res) => {
    const randomId = `dev_c${Math.floor(1000 + Math.random() * 9000)}`;
    await initWhatsApp(randomId);
    res.json({ success: true, sessionId: randomId });
});

app.post('/api/request-pairing', async (req, res) => {
    const { sessionId, phone } = req.body;
    const instance = sessions[sessionId];
    if (!instance) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    try {
        const clean = phone.replace(/[^0-9]/g, '');
        if (clean.length < 8) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid' });

        emitLog(`Request pairing token untuk instansi [${sessionId}] ke: ${clean}`, 'info');
        await delay(1500);
        let code = await instance.sock.requestPairingCode(clean);
        code = code?.replace(/-/g, '')?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ code });
    } catch (err) { 
        res.status(500).json({ error: 'Gagal menembak server Meta. Batas limit terlampaui.' }); 
    }
});

app.post('/api/logout', async (req, res) => {
    const { sessionId } = req.body;
    const instance = sessions[sessionId];
    if (!instance) return res.status(404).json({ error: 'Sesi tidak ditemukan' });

    try {
        if (instance.connected) await instance.sock.logout();
        try {
            instance.sock.ev.removeAllListeners('connection.update');
            instance.sock.end();
        } catch (_) {}
        
        const sessionPath = path.join(__dirname, 'auth_info', sessionId);
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        
        delete sessions[sessionId];
        io.emit('wa-instance-deleted', { sessionId });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Template CRUD API
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
        await pool.query('DELETE FROM templates WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Campaign Queue Systems API
app.post('/api/upload-targets', upload.single('file'), async (req, res) => {
    const { messageTemplate, targetLink } = req.body;
    if (!req.file || !messageTemplate || !targetLink) return res.status(400).json({ error: 'Payload tidak lengkap.' });

    try {
        const raw = fs.readFileSync(req.file.path, 'utf-8');
        const numbers = raw.split(/\r?\n/).map(line => {
            let n = line.replace(/[\s\-\(\)\.]/g, '');
            if (n.startsWith('+')) n = n.slice(1);
            else if (n.startsWith('0')) n = '62' + n.slice(1);
            return n.replace(/[^0-9]/g, '');
        }).filter(n => n.length >= 8 && n.length <= 15);

        const unique = [...new Set(numbers)];
        if (!unique.length) return res.status(400).json({ error: 'Berkas kosong / nomor tidak valid.' });

        const finalTemplate = messageTemplate.replace(/\[Link\]/gi, targetLink);
        await pool.query('DELETE FROM blast_targets');
        
        const values = unique.map(n => [n, 'pending', finalTemplate]);
        await pool.query('INSERT INTO blast_targets (phone_number, status, message) VALUES ?', [values]);
        
        fs.unlinkSync(req.file.path);
        io.emit('blast-ready', { total: unique.length });
        res.json({ success: true, total: unique.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', async (req, res) => {
    try {
        const [[row]] = await pool.query(`
            SELECT COUNT(*) AS total, SUM(status='sent') AS sent, SUM(status='failed') AS failed,
            SUM(status='not_registered') AS skipped, SUM(status='pending') AS pending FROM blast_targets
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

// ══════════════════════════════════════
// LOAD BALANCED MULTI-DEVICE BLAST ENGINE
// ══════════════════════════════════════
async function startBlastEngine() {
    if (isBlasting) return;
    isBlasting = true; stopFlag = false;
    io.emit('blast-started');

    try {
        const [targets] = await pool.query('SELECT * FROM blast_targets WHERE status="pending" ORDER BY id ASC');
        if(!targets.length) return;

        emitLog(`Memulai mesin blast massal untuk ${targets.length} target...`, 'ok');

        for (const target of targets) {
            if (stopFlag) { emitLog('Engine diinterupsi oleh admin.', 'warn'); break; }

            // Cari alokasi device yang siap secara acak (Load Balancing antar instansi)
            const activeSessions = Object.values(sessions).filter(s => s.connected);
            if (!activeSessions.length) {
                emitLog('Tidak ada device WhatsApp yang aktif terhubung. Loop ditahan...', 'warn');
                while (Object.values(sessions).filter(s => s.connected).length === 0) { await delay(3000); }
                continue;
            }

            const activeNode = activeSessions[Math.floor(Math.random() * activeSessions.length)];
            const jid = `${target.phone_number}@s.whatsapp.net`;
            let status = 'failed';
            let waitMs = 2000;

            try {
                const [check] = await activeNode.sock.onWhatsApp(jid);
                if (!check?.exists) {
                    status = 'not_registered';
                } else {
                    const msg = parseSpintax(target.message);
                    await activeNode.sock.sendMessage(jid, { text: msg });
                    status = 'sent';
                    waitMs = Math.floor(Math.random() * (22000 - 12000 + 1)) + 12000; // Anti-Banned delay 12-22s
                }
            } catch (err) {
                status = 'failed';
                waitMs = 4000;
            }

            await pool.query('UPDATE blast_targets SET status=? WHERE id=?', [status, target.id]);
            io.emit('blast-update', { id: target.id, phone_number: target.phone_number, status });
            await delay(waitMs);
        }
    } catch (err) { console.error(err); } 
    finally {
        isBlasting = false;
        io.emit('blast-finished');
        emitLog('Eksekusi looper blast selesai.', 'info');
    }
}

app.post('/api/start-blast', (req, res) => { startBlastEngine(); res.json({ success: true }); });
app.post('/api/stop-blast', (req, res) => { stopFlag = true; res.json({ success: true }); });
app.post('/api/reset-blast', async (req, res) => {
    try {
        await pool.query('DELETE FROM blast_targets');
        io.emit('blast-reset'); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
    socket.emit('blast-state', { isBlasting });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n================== PANSA GROUP SYSTEM INITIALIZED PORT ${PORT} ==================\n`);
    loadExistingSessions();
});
