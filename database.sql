CREATE DATABASE IF NOT EXISTS pansa_blast;
USE pansa_blast;

-- 1. Tabel untuk Antrean Target Blast
CREATE TABLE IF NOT EXISTS blast_targets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone_number VARCHAR(20) NOT NULL,
    status ENUM('pending', 'sent', 'failed', 'not_registered') DEFAULT 'pending',
    message TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 2. Tabel untuk Manajemen Kumpulan Template
CREATE TABLE IF NOT EXISTS templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Seeding Otomatis: Menyimpan 3 Template Default Super Menarik (High CTR)
INSERT INTO templates (title, content) VALUES 
('Crypto / Airdrop (Urgensi Tinggi)', '*[URGENT|ALERT|NOTICE]*: The [exclusive|new Web3] distribution is now live. Early access allocation is [84%|89%|92%] full. Verify your [profile|slot|account] and secure your digital asset immediately: [Link]'),
('Hadiah Tertunda (Rasa Penasaran)', '*[Quick update|System Notice|Hey]*: You left a [pending reward|special package|surprise box] unclaimed on your digital account. It will be transferred to another user in [2 hours|30 minutes|1 hour] if not confirmed: [Link]'),
('Undangan VIP (Akses Eksklusif)', '*[Hey|Hi|Hello]*! Your private invitation to access the [premium automated dashboard|VIP beta tools|exclusive app] has been approved. Claim your [free pass|login setup] before it expires today: [Link]');
