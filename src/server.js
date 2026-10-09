const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, dataDir, upsertUser, audit, getBalance, publicName, ACCOUNT_TYPES, SETTINGS } = require('./db');
const fin = require('./finance');
const { encrypt, decrypt, validateInitData, normalizeIraqiPhone } = require('./security');
const { marketingText, referralLink, supportLink } = require('./bot');
const { adminRouter } = require('./adminApi');
const activity = require('./activity');

function createServer(bot, status = {}) {
  const app = express();
  // صفحة فحص الحالة: افتح https://الرابط/health
  app.get('/health', (req, res) => {
    let users = null;
    try { users = db.prepare('SELECT COUNT(*) c FROM users').get().c; } catch (e) {}
    res.json({ ...status, users });
  });
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^(image\/(jpeg|png|webp)|application\/pdf|text\/csv)$/.test(file.mimetype)),
  });

  const hits = new Map();
  const rateLimit = (req, res, next) => {
    const k = req.user?.id || req.ip;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < 60000);
    arr.push(now); hits.set(k, arr);
    if (arr.length > 120) return res.status(429).json({ error: 'طلبات كثيرة، حاول بعد دقيقة' });
    next();
  };

  const auth = (req, res, next) => {
    const v = validateInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN);
    if (!v?.user) return res.status(401).json({ error: 'افتح المنصة من داخل تيليغرام' });
    const ref = v.startParam?.startsWith('ref_') ? Number(v.startParam.slice(4)) : null;
    upsertUser(v.user, ref);
    req.user = db.prepare('SELECT * FROM users WHERE id=?').get(v.user.id);
    req.ctx = { ip: req.ip, device: (req.get('user-agent') || '').slice(0, 200) };
    if (req.user.status === 'frozen' && req.method !== 'GET') return res.status(403).json({ error: 'الحساب مجمّد، تواصل مع الإدارة' });
    next();
  };

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (e) {
      if (!e.userFacing) console.error(e);
      res.status(e.userFacing ? 400 : 500).json({ error: e.userFacing ? e.message : 'حدث خطأ غير متوقع' });
    }
  };
  const bad = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };

  const api = express.Router();
  api.use(auth, rateLimit);

  // ---------- الحساب ----------
  api.get('/me', wrap((req) => {
    const u = req.user;
    const pending = db.prepare("SELECT id, kind, requested_amount, held_amount, created_at FROM withdraw_requests WHERE user_id=? AND status='pending'").get(u.id);
    return {
      user: {
        id: u.id, name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' '),
        kycLevel: u.kyc_level, status: u.status, createdAt: u.created_at, hideInFeed: !!u.hide_in_feed,
        tgPhoneVerified: !!u.tg_phone,
        profileComplete: !!(u.full_name && u.phone_enc && u.account_enc),
        accountType: u.account_type, accountMasked: u.account_masked,
        vip: !!u.vip,
        acceptedTasks: db.prepare("SELECT COUNT(*) c FROM task_submissions WHERE user_id=? AND status='accepted'").get(u.id).c,
      },
      balance: getBalance(u.id),
      pending: pending || null,
      referral: {
        link: referralLink(u.id),
        text: marketingText(u.id),
        count: db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(u.id).c,
        active: db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=? AND referral_paid=1').get(u.id).c,
        earned: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='referral_bonus'").get(u.id).s,
        bonus: SETTINGS.referralBonus(),
      },
      isAdmin: bot.isAdmin(u.id),
      config: { license: process.env.LICENSE_TEXT || '', accountTypes: ACCOUNT_TYPES, support: supportLink(), vipTasks: SETTINGS.vipTasks(), minInvest: SETTINGS.minInvest() },
    };
  }));

  // ---------- الملف الشخصي: الاسم، الهاتف، نوع ورقم الحساب ----------
  api.get('/profile', wrap((req) => {
    const u = req.user;
    return { full_name: u.full_name || '', phone: decrypt(u.phone_enc) || '', account_type: u.account_type || 'zaincash',
      account_number: decrypt(u.account_enc) || '', updated_at: u.profile_updated_at };
  }));

  api.put('/profile', wrap((req) => {
    const { full_name, phone, account_type, account_number } = req.body || {};
    const name = String(full_name || '').trim().replace(/\s+/g, ' ');
    if (name.split(' ').length < 3) bad('أدخل الاسم الثلاثي كما في الهوية');
    const ph = normalizeIraqiPhone(phone);
    if (!ph) bad('رقم الهاتف غير صحيح، مثال: 07701234567');
    if (!ACCOUNT_TYPES[account_type]) bad('اختر نوع الحساب');
    const acc = String(account_number || '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9-]{6,34}$/.test(acc)) bad('رقم الحساب غير صحيح');
    if (db.prepare("SELECT 1 FROM withdraw_requests WHERE user_id=? AND status='pending'").get(req.user.id)) {
      bad('لا يمكن تعديل بيانات الحساب أثناء وجود طلب قيد المراجعة');
    }
    const masked = acc.length > 4 ? `•••• ${acc.slice(-4)}` : acc;
    db.prepare(`UPDATE users SET full_name=?, phone_enc=?, account_type=?, account_enc=?, account_masked=?, profile_updated_at=datetime('now') WHERE id=?`)
      .run(name, encrypt(ph), account_type, encrypt(acc), masked, req.user.id);
    audit({ actor: req.user.id, action: 'profile_updated', target: req.user.id, after: { account_type, account_masked: masked }, ...req.ctx });
    return { ok: true };
  }));

  // ---------- طلب سحب أرباح / تصفية الحساب ----------
  api.get('/withdrawals', wrap((req) =>
    db.prepare(`SELECT id, kind, requested_amount, held_amount, status, paid_amount, receipt_ref, paid_at, created_at
      FROM withdraw_requests WHERE user_id=? ORDER BY id DESC LIMIT 50`).all(req.user.id)));

  api.post('/withdrawals', wrap(async (req) => {
    const { kind, amount, note } = req.body || {};
    const r = fin.requestWithdrawal(req.user.id, kind, amount, note, req.ctx);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    bot.notifyWithdrawal(r, u).catch((e) => console.error('notifyWithdrawal', e.message));
    return { id: r.id, kind: r.kind, status: 'pending' };
  }));

  api.post('/withdrawals/:id/cancel', wrap((req) => {
    fin.cancelWithdrawal(req.user.id, Number(req.params.id));
    return { ok: true };
  }));

  // ---------- العمليات والتقارير ----------
  api.get('/transactions', wrap((req) => {
    const type = req.query.type;
    return type
      ? db.prepare('SELECT ref, type, amount, status, created_at FROM transactions WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 200').all(req.user.id, type)
      : db.prepare('SELECT ref, type, amount, status, created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id);
  }));

  api.get('/reports', wrap((req) => {
    const from = req.query.from || '2000-01-01';
    const to = req.query.to || '2999-12-31';
    const sums = db.prepare(`SELECT type, SUM(amount) total FROM transactions
      WHERE user_id=? AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY type`).all(req.user.id, from, to);
    const monthly = db.prepare(`SELECT strftime('%Y-%m', created_at) m, type, SUM(amount) total FROM transactions
      WHERE user_id=? AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY m, type ORDER BY m`).all(req.user.id, from, to);
    return { sums, monthly };
  }));

  // ---------- سحوبات الأعضاء (منفّذة فعلاً فقط) ----------
  api.get('/payouts-feed', wrap((req) => {
    const since = String(req.query.since || '1970-01-01 00:00:00');
    const internal = db.prepare(`SELECT w.id, w.paid_amount amount, w.paid_at at, u.account_type method, u.full_name, u.first_name, u.last_name, u.hide_in_feed
      FROM withdraw_requests w JOIN users u ON u.id=w.user_id
      WHERE w.status='paid' AND w.paid_at > ? ORDER BY w.paid_at DESC LIMIT 50`).all(since);
    const external = db.prepare(`SELECT id, amount, paid_at at, method, display_name, source FROM external_payouts
      WHERE paid_at > ? AND paid_at <= datetime('now') ORDER BY paid_at DESC LIMIT 50`).all(since);
    const items = [
      ...internal.map((r) => ({ id: 'i' + r.id, amount: r.amount, at: r.at, method: r.method, source: null, name: publicName(r) })),
      ...external.map((r) => ({ id: 'e' + r.id, amount: r.amount, at: r.at, method: r.method, source: r.source, name: r.display_name })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
    const t1 = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(paid_amount),0) s,
      COALESCE(SUM(CASE WHEN paid_at >= datetime('now','-30 days') THEN paid_amount END),0) m FROM withdraw_requests WHERE status='paid'`).get();
    const t2 = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s,
      COALESCE(SUM(CASE WHEN paid_at >= datetime('now','-30 days') THEN amount END),0) m FROM external_payouts WHERE paid_at <= datetime('now')`).get();
    return { totals: { count: t1.c + t2.c, sum: t1.s + t2.s, month: t1.m + t2.m }, items };
  }));

  api.post('/me/feed-visibility', wrap((req) => {
    const hide = req.body?.hide ? 1 : 0;
    db.prepare('UPDATE users SET hide_in_feed=? WHERE id=?').run(hide, req.user.id);
    audit({ actor: req.user.id, action: 'feed_visibility', target: req.user.id, after: { hide }, ...req.ctx });
    return { hide: !!hide };
  }));

  // ---------- الاستثمار ----------
  const projectRow = (p) => ({
    ...p,
    raised: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM investments WHERE project_id=? AND status!='liquidated'").get(p.id).s,
  });
  api.get('/projects', wrap(() =>
    db.prepare("SELECT * FROM projects WHERE status!='closed' ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, id DESC").all().map(projectRow)));
  api.get('/projects/:id', wrap((req) => {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!p) bad('المشروع غير موجود');
    return projectRow(p);
  }));
  api.post('/projects/:id/invest', wrap((req) => {
    if (req.body?.accept_risk !== true) bad('يجب الموافقة على شروط المشروع ومخاطره');
    return { ok: true, ref: fin.invest(req.user.id, Number(req.params.id), req.body.amount, req.ctx) };
  }));
  api.get('/investments', wrap((req) =>
    db.prepare(`SELECT i.*, p.name, p.status project_status, p.end_date FROM investments i
      JOIN projects p ON p.id=i.project_id WHERE i.user_id=? ORDER BY i.id DESC`).all(req.user.id)));

  // ---------- المهام ----------
  api.get('/tasks', wrap((req) =>
    db.prepare(`SELECT t.*, (t.seats - (SELECT COUNT(*) FROM task_submissions s WHERE s.task_id=t.id AND s.status!='rejected')) seats_left,
      (SELECT status FROM task_submissions s WHERE s.task_id=t.id AND s.user_id=?) my_status
      FROM tasks t WHERE t.status='open' OR t.id IN (SELECT task_id FROM task_submissions WHERE user_id=?) ORDER BY t.id DESC`).all(req.user.id, req.user.id)));

  api.post('/tasks/:id/start', wrap((req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id=? AND status='open'").get(req.params.id);
    if (!t) bad('المهمة غير متاحة');
    if (t.audience === 'vip' && !req.user.vip) bad(`هذه المهمة للأعضاء المميزين (VIP). تحصل على VIP بعد ${SETTINGS.vipTasks()} مهمة مقبولة`);
    const taken = db.prepare("SELECT COUNT(*) c FROM task_submissions WHERE task_id=? AND status!='rejected'").get(t.id).c;
    if (taken >= t.seats) bad('اكتملت مقاعد هذه المهمة');
    db.prepare('INSERT OR IGNORE INTO task_submissions (task_id, user_id) VALUES (?,?)').run(t.id, req.user.id);
    return { ok: true };
  }));

  api.post('/tasks/:id/submit', upload.single('proof'), wrap(async (req) => {
    const s = db.prepare('SELECT * FROM task_submissions WHERE task_id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!s || s.status !== 'in_progress') bad('ابدأ المهمة أولاً');
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    const proofText = String(req.body?.proof_text || '').slice(0, 2000);
    if (!proofText && !req.file) bad('أرفق الإثبات المطلوب');
    db.prepare("UPDATE task_submissions SET status='review', proof_text=?, proof_path=?, submitted_at=datetime('now') WHERE id=?")
      .run(proofText, req.file?.path || null, s.id);
    bot.notifyTask(db.prepare('SELECT * FROM task_submissions WHERE id=?').get(s.id), task, req.user)
      .catch((e) => console.error('notifyTask', e.message));
    return { ok: true, status: 'review' };
  }));

  // ---------- مكافآت النشاط ----------
  api.get('/activity', wrap((req) => activity.status(req.user.id)));
  api.post('/activity/claim', wrap((req) => activity.claim(req.user.id, req.ctx)));

  api.use('/admin', adminRouter(bot, wrap, bad));
  app.use('/api', api);
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  return app;
}

module.exports = { createServer };
