const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// على Railway تُحفظ البيانات في الـ Volume، ومحلياً في مجلد data
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'thiqa_v2.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,                 -- Telegram user id
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  tg_phone TEXT,                          -- رقم موثّق عبر زر مشاركة الهاتف في تيليغرام
  referrer_id INTEGER,
  kyc_level INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- active | frozen
  hide_in_feed INTEGER NOT NULL DEFAULT 0,
  -- الملف الشخصي (يعبّئه العضو) — البيانات الحساسة مشفّرة
  full_name TEXT,
  phone_enc TEXT,
  account_type TEXT,                      -- zaincash | qicard | bank | other
  account_enc TEXT,
  account_masked TEXT,
  profile_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS balances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  available INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,     -- محجوز لطلب سحب قيد المراجعة
  invested INTEGER NOT NULL DEFAULT 0,
  realized_profit INTEGER NOT NULL DEFAULT 0,
  task_earnings INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdraw','liquidation','invest','invest_return','task_reward','profit_settlement')),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- طلبات السحب وتصفية الحساب: تُراجع وتُحوَّل خارجياً ثم يسجّل المشرف بيانات التحويل
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('profit','liquidation')),
  requested_amount INTEGER,
  held_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | rejected
  paid_amount INTEGER,
  receipt_ref TEXT,
  paid_at TEXT,
  reviewed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, type TEXT, sector TEXT, description TEXT, business_model TEXT, risks TEXT,
  risk_level TEXT NOT NULL DEFAULT 'متوسطة',
  capital_required INTEGER NOT NULL,
  min_amount INTEGER NOT NULL DEFAULT 100000,
  duration_days INTEGER NOT NULL,
  return_method TEXT NOT NULL,
  expected_return TEXT NOT NULL DEFAULT 'حسب الأداء الفعلي',
  status TEXT NOT NULL DEFAULT 'study',
  start_date TEXT, end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | settled | liquidated
  result_amount INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, client TEXT, description TEXT NOT NULL, requirements TEXT, proof_required TEXT,
  reward INTEGER NOT NULL,
  seats INTEGER NOT NULL DEFAULT 10,
  duration_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'in_progress',
  proof_text TEXT, proof_path TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  UNIQUE(task_id, user_id)
);

-- سحوبات منفّذة فعلاً على منصة أخرى (بإيصالات، بدون تواريخ مستقبلية)
CREATE TABLE IF NOT EXISTS external_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  display_name TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  receipt_ref TEXT NOT NULL UNIQUE,
  imported_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (paid_at <= created_at)
);
CREATE TRIGGER IF NOT EXISTS ext_no_update BEFORE UPDATE ON external_payouts
BEGIN SELECT RAISE(ABORT, 'external_payouts is append-only'); END;

CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, action TEXT NOT NULL, target_user_id INTEGER,
  before_value TEXT, after_value TEXT, ip TEXT, device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`);

function newRef(prefix = 'TX') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function audit({ actor, action, target, before, after, ip, device }) {
  db.prepare(`INSERT INTO audit_log (actor_id, action, target_user_id, before_value, after_value, ip, device)
              VALUES (?,?,?,?,?,?,?)`).run(
    actor ?? null, action, target ?? null,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    ip ?? null, device ?? null
  );
}

function upsertUser(u, referrerId) {
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(u.id);
  if (!exists) {
    const ref = referrerId && referrerId !== u.id &&
      db.prepare('SELECT id FROM users WHERE id = ?').get(referrerId) ? referrerId : null;
    db.prepare('INSERT INTO users (id, username, first_name, last_name, referrer_id) VALUES (?,?,?,?,?)')
      .run(u.id, u.username ?? null, u.first_name ?? null, u.last_name ?? null, ref);
    db.prepare('INSERT INTO balances (user_id) VALUES (?)').run(u.id);
    return { created: true, referrerId: ref };
  }
  db.prepare('UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE id = ?')
    .run(u.username ?? null, u.first_name ?? null, u.last_name ?? null, u.id);
  return { created: false };
}

const getBalance = (userId) => db.prepare('SELECT * FROM balances WHERE user_id = ?').get(userId);

// الاسم الأول + أول حرف من اسم العائلة
function maskName(first, last) {
  const parts = String([first, last].filter(Boolean).join(' ')).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'عضو';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// الاسم الظاهر للعضو في صفحة السحوبات
function publicName(u) {
  if (!u || u.hide_in_feed) return 'عضو';
  return u.full_name ? maskName(u.full_name) : maskName(u.first_name, u.last_name);
}

const ACCOUNT_TYPES = { zaincash: 'زين كاش', qicard: 'كي كارد', bank: 'حساب مصرفي', other: 'أخرى' };

module.exports = { db, dataDir, newRef, audit, upsertUser, getBalance, maskName, publicName, ACCOUNT_TYPES };
