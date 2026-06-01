CREATE DATABASE IF NOT EXISTS pansa_blaster
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE pansa_blaster;

-- ── TABEL TEMPLATE PESAN ──────────────────
CREATE TABLE IF NOT EXISTS templates (
    id         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    title      VARCHAR(150)    NOT NULL,
    content    TEXT            NOT NULL,
    created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── TABEL ANTREAN BLAST ───────────────────
CREATE TABLE IF NOT EXISTS blast_targets (
    id           INT UNSIGNED    NOT NULL AUTO_INCREMENT,
    phone_number VARCHAR(20)     NOT NULL,
    status       ENUM('pending','sent','failed','not_registered')
                                 NOT NULL DEFAULT 'pending',
    message      TEXT            NOT NULL,
    created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
