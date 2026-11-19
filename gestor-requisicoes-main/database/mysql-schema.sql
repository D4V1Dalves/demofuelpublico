-- Fuel Jobs — schema MySQL/MariaDB para importar no phpMyAdmin (cPanel).
-- Compatível com MySQL 8+ e MariaDB 10.4+. Charset utf8mb4 (acentos e emojis).
-- Depois de importar, configure as variáveis DB_* no app Node do cPanel.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(10) NOT NULL,
  avatar VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clients (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  website TEXT NULL,
  instagram TEXT NULL,
  facebook TEXT NULL,
  whatsapp TEXT NULL,
  linkedin TEXT NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(190) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_clients_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status VARCHAR(30) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  responsible_id INT UNSIGNED NULL,
  due_date DATE NULL,
  created_by INT UNSIGNED NOT NULL,
  admin_approved_at DATETIME NULL,
  client_approved_at DATETIME NULL,
  client_rejected_at DATETIME NULL,
  client_rejection_reason TEXT NULL,
  approval_token VARCHAR(64) NULL,
  dropbox_url TEXT NULL,
  generated_by_rule_id INT UNSIGNED NULL,
  completed_at DATETIME NULL,
  cycle_started_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_requests_approval_token (approval_token),
  KEY idx_requests_status (status),
  KEY idx_requests_client (client_id),
  KEY idx_requests_responsible (responsible_id),
  KEY idx_requests_due_date (due_date),
  CONSTRAINT fk_requests_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_requests_responsible FOREIGN KEY (responsible_id) REFERENCES users (id),
  CONSTRAINT fk_requests_creator FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_requests_status CHECK (
    status IN ('Novo', 'Em andamento', 'Em processo', 'Aprovação', 'Aprovado', 'Rejeitado')
  ),
  CONSTRAINT chk_requests_priority CHECK (priority IN ('Baixa', 'Média', 'Alta', 'Urgente'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recurring_rules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(160) NOT NULL,
  client_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  priority VARCHAR(20) NOT NULL,
  responsible_id INT UNSIGNED NULL,
  due_days INT NOT NULL DEFAULT 0,
  dropbox_url TEXT NULL,
  interval_value INT NOT NULL,
  interval_unit VARCHAR(10) NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  next_run_at DATETIME NOT NULL,
  last_run_at DATETIME NULL,
  failure_count INT NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rules_next_run (active, next_run_at),
  CONSTRAINT fk_rules_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_rules_responsible FOREIGN KEY (responsible_id) REFERENCES users (id),
  CONSTRAINT fk_rules_creator FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_rules_interval_unit CHECK (interval_unit IN ('dia', 'semana', 'mes')),
  CONSTRAINT chk_rules_priority CHECK (priority IN ('Baixa', 'Média', 'Alta', 'Urgente'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_comments_request (request_id),
  CONSTRAINT fk_comments_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_attachments_request (request_id),
  CONSTRAINT fk_attachments_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS time_entries (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'paused',
  started_at DATETIME NULL,
  accumulated_seconds INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_time_entries_request_user (request_id, user_id),
  KEY idx_time_entries_request (request_id),
  CONSTRAINT fk_time_entries_request FOREIGN KEY (request_id) REFERENCES requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_time_entries_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT chk_time_entries_status CHECK (status IN ('running', 'paused', 'finished'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_name VARCHAR(64) NOT NULL,
  setting_value TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
