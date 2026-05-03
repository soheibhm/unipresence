-- UniPresence v2.0 — Full Database Schema
-- Run: mysql -u root -p < database.sql

CREATE DATABASE IF NOT EXISTS unipresence CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE unipresence;

-- ─────────────────────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────────────────────

CREATE TABLE annees_universitaires (
  id INT AUTO_INCREMENT PRIMARY KEY,
  libelle VARCHAR(20) NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE niveaux (
  id INT AUTO_INCREMENT PRIMARY KEY,
  libelle VARCHAR(10) NOT NULL,
  specialite VARCHAR(100) DEFAULT 'Informatique'
);

CREATE TABLE semestres (
  id INT AUTO_INCREMENT PRIMARY KEY,
  libelle VARCHAR(30) NOT NULL,
  annee_id INT NOT NULL,
  niveau_id INT NOT NULL,
  date_debut DATE NOT NULL,
  date_fin DATE NOT NULL,
  actif BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (annee_id) REFERENCES annees_universitaires(id) ON DELETE CASCADE,
  FOREIGN KEY (niveau_id) REFERENCES niveaux(id) ON DELETE CASCADE
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nom VARCHAR(60) NOT NULL,
  prenom VARCHAR(60) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','professeur','etudiant') NOT NULL,
  status ENUM('actif','inactif','en_attente') DEFAULT 'en_attente',
  telephone VARCHAR(20),
  -- Email verification
  email_verified       TINYINT(1)  NOT NULL DEFAULT 0,
  email_verify_token   VARCHAR(64) DEFAULT NULL,
  email_verify_expires DATETIME    DEFAULT NULL,
  -- Password reset
  reset_token          VARCHAR(64) DEFAULT NULL,
  reset_token_expires  DATETIME    DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP NULL
);

CREATE TABLE professeurs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  grade ENUM('Professeur','MCA','MCB','Doctorant') DEFAULT 'MCB',
  specialite VARCHAR(100),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE etudiants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  matricule VARCHAR(20) NOT NULL UNIQUE,
  niveau_id INT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (niveau_id) REFERENCES niveaux(id)
);

CREATE TABLE groupes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nom VARCHAR(20) NOT NULL,
  type ENUM('TD','TP','CM') NOT NULL,
  niveau_id INT NOT NULL,
  FOREIGN KEY (niveau_id) REFERENCES niveaux(id) ON DELETE CASCADE
);

CREATE TABLE etudiant_groupes (
  etudiant_id INT NOT NULL,
  groupe_id INT NOT NULL,
  PRIMARY KEY (etudiant_id, groupe_id),
  FOREIGN KEY (etudiant_id) REFERENCES etudiants(id) ON DELETE CASCADE,
  FOREIGN KEY (groupe_id) REFERENCES groupes(id) ON DELETE CASCADE
);

CREATE TABLE modules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  intitule VARCHAR(100) NOT NULL,
  niveau_id INT NOT NULL,
  semestre_id INT NOT NULL,
  professeur_id INT,
  has_td BOOLEAN DEFAULT TRUE,
  has_tp BOOLEAN DEFAULT FALSE,
  coefficient INT DEFAULT 2,
  credits INT DEFAULT 3,
  FOREIGN KEY (niveau_id) REFERENCES niveaux(id),
  FOREIGN KEY (semestre_id) REFERENCES semestres(id),
  FOREIGN KEY (professeur_id) REFERENCES professeurs(id) ON DELETE SET NULL
);

CREATE TABLE seances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  module_id INT NOT NULL,
  groupe_id INT NOT NULL,
  type ENUM('CM','TD','TP') NOT NULL,
  date_seance DATE NOT NULL,
  heure_debut TIME NOT NULL,
  heure_fin TIME NOT NULL,
  salle VARCHAR(30),
  qr_token VARCHAR(64) UNIQUE,
  qr_expires_at DATETIME,
  statut ENUM('planifiee','active','terminee') DEFAULT 'planifiee',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (groupe_id) REFERENCES groupes(id)
);

CREATE TABLE presences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seance_id INT NOT NULL,
  etudiant_id INT NOT NULL,
  statut ENUM('present','absent','justifie') DEFAULT 'present',
  scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_seance_etudiant (seance_id, etudiant_id),
  FOREIGN KEY (seance_id) REFERENCES seances(id) ON DELETE CASCADE,
  FOREIGN KEY (etudiant_id) REFERENCES etudiants(id) ON DELETE CASCADE
);

CREATE TABLE justifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  etudiant_id INT NOT NULL,
  seance_id INT NOT NULL,
  motif ENUM('medical','familial','transport','universitaire','autre') NOT NULL,
  description TEXT,
  fichier_url VARCHAR(255),
  statut ENUM('en_attente','acceptee','refusee') DEFAULT 'en_attente',
  commentaire TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  traite_at TIMESTAMP NULL,
  traite_par INT,
  FOREIGN KEY (etudiant_id) REFERENCES etudiants(id) ON DELETE CASCADE,
  FOREIGN KEY (seance_id) REFERENCES seances(id) ON DELETE CASCADE,
  FOREIGN KEY (traite_par) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  titre VARCHAR(150) NOT NULL,
  message TEXT NOT NULL,
  type ENUM('info','success','warning','danger') DEFAULT 'info',
  lu BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────

CREATE INDEX idx_seances_date     ON seances(date_seance);
CREATE INDEX idx_seances_qr       ON seances(qr_token);
CREATE INDEX idx_presences_etud   ON presences(etudiant_id);
CREATE INDEX idx_justif_etud      ON justifications(etudiant_id);
CREATE INDEX idx_notif_user       ON notifications(user_id, lu);
CREATE INDEX idx_users_reset      ON users(reset_token);
CREATE INDEX idx_users_verify     ON users(email_verify_token);

-- ─────────────────────────────────────────────────────────────
-- SEED DATA
-- ─────────────────────────────────────────────────────────────

INSERT INTO niveaux (id, libelle, specialite) VALUES
(1,'L1','Informatique'),(2,'L2','Informatique'),(3,'L3','Informatique'),
(4,'M1','Informatique'),(5,'M2','Informatique');

INSERT INTO annees_universitaires (id, libelle, date_debut, date_fin, active) VALUES
(1, '2024-2025', '2024-09-01', '2025-07-31', TRUE);

INSERT INTO semestres (libelle, annee_id, niveau_id, date_debut, date_fin, actif) VALUES
('S5 - L3 Info', 1, 3, '2024-09-15', '2025-01-31', FALSE),
('S6 - L3 Info', 1, 3, '2025-02-15', '2025-06-30', TRUE),
('S3 - L2 Info', 1, 2, '2024-09-15', '2025-01-31', FALSE),
('S4 - L2 Info', 1, 2, '2025-02-15', '2025-06-30', TRUE),
('S1 - L1 Info', 1, 1, '2024-09-15', '2025-01-31', FALSE),
('S2 - L1 Info', 1, 1, '2025-02-15', '2025-06-30', TRUE),
('S1 - M1 Info', 1, 4, '2024-09-15', '2025-01-31', FALSE),
('S2 - M1 Info', 1, 4, '2025-02-15', '2025-06-30', TRUE),
('S1 - M2 Info', 1, 5, '2024-09-15', '2025-01-31', FALSE),
('S2 - M2 Info', 1, 5, '2025-02-15', '2025-06-30', TRUE);

-- ─────────────────────────────────────────────────────────────
-- ADMIN USER — Password: Admin@1234
-- (email_verified=1, status=actif — admin bypasses approval)
-- ─────────────────────────────────────────────────────────────
INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified) VALUES
('Administrateur', 'Système', 'admin@unipresence.dz',
 '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lihO',
 'admin', 'actif', 1);

-- ─────────────────────────────────────────────────────────────
-- SAMPLE PROFESSOR — Password: Prof@1234
-- ─────────────────────────────────────────────────────────────
INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified) VALUES
('Boudiaf', 'Karim', 'k.boudiaf@unipresence.dz',
 '$2a$10$TKh8H1.PfunCpOmMsYdSN.N4Kk26.hRlpPbzVQmhE2jyWqb/tOOi',
 'professeur', 'actif', 1);
INSERT INTO professeurs (user_id, grade, specialite) VALUES (2, 'MCA', 'Algorithmique et Structures de Données');

-- ─────────────────────────────────────────────────────────────
-- SAMPLE STUDENTS — Password: Etudiant@1234
-- ─────────────────────────────────────────────────────────────
INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified) VALUES
('Amrani',  'Yasmine', 'y.amrani@unipresence.dz',  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.', 'etudiant', 'actif', 1),
('Benali',  'Mohamed', 'm.benali@unipresence.dz',  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.', 'etudiant', 'actif', 1),
('Chérif',  'Sara',    's.cherif@unipresence.dz',  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.', 'etudiant', 'actif', 1);

INSERT INTO etudiants (user_id, matricule, niveau_id) VALUES
(3, '2022001', 3),(4, '2022002', 3),(5, '2022003', 3);

INSERT INTO groupes (nom, type, niveau_id) VALUES
('G1','CM',3),('TD1','TD',3),('TD2','TD',3),('TP1','TP',3),('TP2','TP',3);

INSERT INTO etudiant_groupes (etudiant_id, groupe_id) VALUES
(1,1),(1,2),(1,4),(2,1),(2,2),(2,4),(3,1),(3,3),(3,5);

-- Modules with credits
INSERT INTO modules (code, intitule, niveau_id, semestre_id, professeur_id, has_td, has_tp, coefficient, credits) VALUES
('ALGO3', 'Algorithmique Avancée', 3, 2, 1, TRUE, TRUE,  4, 6),
('BD3',   'Bases de Données',      3, 2, 1, TRUE, TRUE,  3, 5),
('GL3',   'Génie Logiciel',        3, 2, 1, TRUE, FALSE, 3, 4);

-- ─────────────────────────────────────────────────────────────
-- MIGRATION SCRIPT (run if upgrading from v1)
-- Uncomment below if you already have an existing database
-- ─────────────────────────────────────────────────────────────
/*
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified       TINYINT(1)  NOT NULL DEFAULT 0 AFTER status,
  ADD COLUMN IF NOT EXISTS email_verify_token   VARCHAR(64) DEFAULT NULL AFTER email_verified,
  ADD COLUMN IF NOT EXISTS email_verify_expires DATETIME    DEFAULT NULL AFTER email_verify_token,
  ADD COLUMN IF NOT EXISTS reset_token          VARCHAR(64) DEFAULT NULL AFTER email_verify_expires,
  ADD COLUMN IF NOT EXISTS reset_token_expires  DATETIME    DEFAULT NULL AFTER reset_token;

ALTER TABLE modules
  ADD COLUMN IF NOT EXISTS credits INT DEFAULT 3 AFTER coefficient;

-- Mark existing users as verified and active
UPDATE users SET email_verified = 1 WHERE email_verified = 0;
UPDATE users SET status = 'actif' WHERE status = 'en_attente' AND email_verified = 1;
*/
