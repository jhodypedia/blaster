const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host:               process.env.DB_HOST     || 'localhost',
    port:               process.env.DB_PORT     || 3306,
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASSWORD || '',
    database:           process.env.DB_NAME     || 'pansa_blaster',
    waitForConnections: true,
    connectionLimit:    10,
    queueLimit:         0,
    timezone:           '+07:00',
});

pool.getConnection()
    .then(conn => { console.log('[DB] MySQL terhubung.'); conn.release(); })
    .catch(err  => { console.error('[DB] Gagal:', err.message); process.exit(1); });

module.exports = pool;
