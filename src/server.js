const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, dataDir, upsertUser, audit, getBalance, maskName } = require('./db');
const fin = require('./finance');
const { encrypt, validateInitData, normalizeIraqiPhone, luhnValid } = require('./security');
const { marketingText, referralLink } = require('./bot');

function createServer(bot) {
  const app = express();
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

  // حد بسيط لعدد الطلبات لكل مستخدم
  const hits = new Map();
  const rateLimit = (req, res, next) => {
    const k = req.user?.id || req.ip;
    const now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < 60000);
    arr.push(now); hits.set(k, arr);
    if (arr.length > 120) return res.status(429).json({ error: 'طلبات كثيرة، حاول بعد دقيقة' });
    next();
  };

  // التحقق من هوية مستخدم تيليغرام في كل طلب
  const auth = (req, res, next) => {
    const v = validateInitData(req.get('X-Telegram-Init-Data'), process.env.BOT_TOKEN);
    if (!v?.user) return res.status(401).json({ error: 'افتح المنصة من داخل تيليغرام' });
    const ref = v.startParam?.startsWith('ref_') ? Number(v.startParam.slice(4)) : null;
    upsertUser(v.user, ref);
    req.user = db.prepare('SELECT * FROM users WHERE id=?').get(v.user.id);
    req.ctx = { ip: req.ip, device: (req.get('user-agent') || '').slice(0, 200) };
    if (req.user.status === 'frozen' && req.method !== 'GET') return res.status(403).json({ error: 'الحساب مجمّد، تواصل مع الدعم' });
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
    return {
      user: { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' '), username: u.username,
        phoneVerified: !!u.phone, kycLevel: u.kyc_level, hideInFeed: !!u.hide_in_feed, status: u.status, createdAt: u.created_at },
      balance: getBalance(u.id),
      referral: {
        link: referralLink(u.id),
        text: marketingText(u.id),
        count: db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(u.id).c,
      },
      config: {
        license: process.env.LICENSE_TEXT || '',
        withdrawFeePercent: Number(process.env.WITHDRAW_FEE_PERCENT || 0),
        dailyWithdrawLimit: Number(process.env.DAILY_WITHDRAW_LIMIT || 0),
        deposit: {
          zaincash: process.env.DEPOSIT_ZAINCASH_NUMBER,
          qicard: process.env.DEPOSIT_QICARD_NUMBER,
          qicardName: process.env.DEPOSIT_QICARD_NAME,
        },
      },
    };
  }));

  api.get('/transactions', wrap((req) => {
    const type = req.query.type;
    const rows = type
      ? db.prepare('SELECT ref, type, amount, status, created_at FROM transactions WHERE user_id=? AND type=? ORDER BY id DESC LIMIT 200').all(req.user.id, type)
      : db.prepare('SELECT ref, type, amount, status, created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 200').all(req.user.id);
    const deps = db.prepare("SELECT 'DEP-'||id ref, 'deposit' type, amount, status, created_at FROM deposit_requests WHERE user_id=? AND status!='approved' ORDER BY id DESC LIMIT 50").all(req.user.id);
    const wds = db.prepare("SELECT 'WD-'||id ref, 'withdraw' type, -amount amount, status, created_at FROM withdraw_requests WHERE user_id=? AND status!='approved' ORDER BY id DESC LIMIT 50").all(req.user.id);
    const all = type ? rows.concat([...deps, ...wds].filter((r) => r.type === type)) : rows.concat(deps, wds);
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }));

  api.get('/reports', wrap((req) => {
    const from = req.query.from || '2000-01-01';
    const to = req.query.to || '2999-12-31';
    const sums = db.prepare(`SELECT type, SUM(amount) total FROM transactions
      WHERE user_id=? AND status='completed' AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY type`).all(req.user.id, from, to);
    const monthly = db.prepare(`SELECT strftime('%Y-%m', created_at) m, type, SUM(amount) total FROM transactions
      WHERE user_id=? AND status='completed' AND date(created_at) BETWEEN date(?) AND date(?) GROUP BY m, type ORDER BY m`).all(req.user.id, from, to);
    return { sums, monthly };
  }));

  // ---------- طرق الاستلام: زين كاش / كي كارد ----------
  api.get('/payout-methods', wrap((req) =>
    db.prepare('SELECT id, type, holder_name, masked, is_default, created_at FROM payout_methods WHERE user_id=? ORDER BY id DESC').all(req.user.id)));

  api.post('/payout-methods', wrap((req) => {
    const { type, holder_name, phone, address, card_number } = req.body || {};
    if (!['zaincash', 'qicard'].includes(type)) bad('نوع المحفظة غير صحيح');
    const name = String(holder_name || '').trim();
    if (name.length < 3) bad('أدخل اسم صاحب الحساب كما هو مسجل');
    const addr = String(address || '').trim();
    if (addr.length < 5) bad('أدخل العنوان (المحافظة، المنطقة، أقرب نقطة دالة)');
    const ph = normalizeIraqiPhone(phone);
    if (!ph) bad('رقم الهاتف غير صحيح، مثال: 07701234567');

    let masked; let cardEnc = null;
    if (type === 'zaincash') {
      masked = `${ph.slice(0, 4)}•••${ph.slice(-4)}`;
    } else {
      const card = String(card_number || '').replace(/\D/g, '');
      if (!luhnValid(card)) bad('رقم بطاقة كي كارد غير صحيح');
      cardEnc = encrypt(card);
      masked = `•••• ${card.slice(-4)}`;
    }
    const count = db.prepare('SELECT COUNT(*) c FROM payout_methods WHERE user_id=?').get(req.user.id).c;
    if (count >= 5) bad('الحد الأقصى 5 محافظ');
    const r = db.prepare(`INSERT INTO payout_methods (user_id, type, holder_name, phone_enc, address_enc, card_enc, masked, is_default)
      VALUES (?,?,?,?,?,?,?,?)`).run(req.user.id, type, name, encrypt(ph), encrypt(addr), cardEnc, masked, count === 0 ? 1 : 0);
    audit({ actor: req.user.id, action: 'payout_method_added', target: req.user.id, after: { type, masked }, ...req.ctx });
    return { id: r.lastInsertRowid, type, holder_name: name, masked };
  }));

  api.delete('/payout-methods/:id', wrap((req) => {
    const pending = db.prepare("SELECT COUNT(*) c FROM withdraw_requests WHERE payout_method_id=? AND status='pending'").get(req.params.id).c;
    if (pending) bad('لا يمكن الحذف أثناء وجود طلب سحب قيد المراجعة على هذه المحفظة');
    const used = db.prepare('SELECT COUNT(*) c FROM withdraw_requests WHERE payout_method_id=?').get(req.params.id).c;
    // نحتفظ بالمحافظ المرتبطة بعمليات سابقة للسجل المالي
    if (used) bad('هذه المحفظة مرتبطة بعمليات سابقة ولا يمكن حذفها؛ يمكنك إضافة محفظة جديدة');
    const r = db.prepare('DELETE FROM payout_methods WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    if (!r.changes) bad('المحفظة غير موجودة');
    audit({ actor: req.user.id, action: 'payout_method_removed', target: req.user.id, after: { id: req.params.id }, ...req.ctx });
    return { ok: true };
  }));

  // ---------- سحوبات الأعضاء (عمليات حقيقية منفّذة فقط) ----------
  api.get('/payouts-feed', wrap((req) => {
    const since = String(req.query.since || '1970-01-01 00:00:00');
    const internal = db.prepare(`SELECT 'i' || w.id id, w.net amount, w.reviewed_at at, m.type method, u.first_name, u.last_name, u.hide_in_feed, NULL source
      FROM withdraw_requests w JOIN users u ON u.id=w.user_id JOIN payout_methods m ON m.id=w.payout_method_id
      WHERE w.status='approved' AND w.reviewed_at > ? ORDER BY w.reviewed_at DESC LIMIT 50`).all(since);
    const external = db.prepare(`SELECT 'e' || id id, amount, paid_at at, method, display_name, source FROM external_payouts
      WHERE paid_at > ? AND paid_at <= datetime('now') ORDER BY paid_at DESC LIMIT 50`).all(since);
    const items = [
      ...internal.map((r) => ({ id: r.id, amount: r.amount, at: r.at, method: r.method, source: null,
        name: r.hide_in_feed ? 'عضو' : maskName(r.first_name, r.last_name) })),
      ...external.map((r) => ({ id: r.id, amount: r.amount, at: r.at, method: r.method, source: r.source, name: r.display_name })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
    const t1 = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(net),0) s,
      COALESCE(SUM(CASE WHEN reviewed_at >= datetime('now','-30 days') THEN net END),0) m FROM withdraw_requests WHERE status='approved'`).get();
    const t2 = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount),0) s,
      COALESCE(SUM(CASE WHEN paid_at >= datetime('now','-30 days') THEN amount END),0) m FROM external_payouts WHERE paid_at <= datetime('now')`).get();
    return {
      totals: { count: t1.c + t2.c, sum: t1.s + t2.s, month: t1.m + t2.m, botCount: t1.c, externalCount: t2.c },
      items,
    };
  }));

  api.post('/me/feed-visibility', wrap((req) => {
    const hide = req.body?.hide ? 1 : 0;
    db.prepare('UPDATE users SET hide_in_feed=? WHERE id=?').run(hide, req.user.id);
    audit({ actor: req.user.id, action: 'feed_visibility', target: req.user.id, after: { hide }, ...req.ctx });
    return { hide: !!hide };
  }));

  // ---------- الإيداع ----------
  api.post('/deposits', upload.single('proof'), wrap(async (req) => {
    const { method, amount, external_ref } = req.body || {};
    const amt = Math.floor(Number(amount));
    if (!['zaincash', 'qicard', 'bank'].includes(method)) bad('اختر طريقة الإيداع');
    if (!Number.isFinite(amt) || amt < 10000) bad('الحد الأدنى للإيداع 10,000 د.ع');
    if (!req.file) bad('ارفع صورة إثبات الدفع');
    const open = db.prepare("SELECT COUNT(*) c FROM deposit_requests WHERE user_id=? AND status='pending'").get(req.user.id).c;
    if (open >= 3) bad('لديك 3 طلبات إيداع قيد المراجعة، انتظر معالجتها');
    const r = db.prepare('INSERT INTO deposit_requests (user_id, method, amount, external_ref, proof_path) VALUES (?,?,?,?,?)')
      .run(req.user.id, method, amt, String(external_ref || '').slice(0, 64), req.file.path);
    const reqRow = db.prepare('SELECT * FROM deposit_requests WHERE id=?').get(r.lastInsertRowid);
    audit({ actor: req.user.id, action: 'deposit_requested', target: req.user.id, after: { id: reqRow.id, amt, method }, ...req.ctx });
    bot.notifyDeposit(reqRow, req.user).catch((e) => console.error('notifyDeposit', e.message));
    return { id: reqRow.id, status: 'pending' };
  }));

  // ---------- السحب ----------
  api.post('/withdrawals', wrap(async (req) => {
    const { method_id, amount } = req.body || {};
    const w = fin.requestWithdraw(req.user.id, Number(method_id), amount, req.ctx);
    bot.notifyWithdraw(w, req.user).catch((e) => console.error('notifyWithdraw', e.message));
    return { id: w.id, amount: w.amount, fee: w.fee, net: w.net, status: 'pending' };
  }));

  // ---------- الاستثمار ----------
  const projectRow = (p) => ({
    ...p,
    raised: db.prepare('SELECT COALESCE(SUM(amount),0) s FROM investments WHERE project_id=?').get(p.id).s,
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
    const ref = fin.invest(req.user.id, Number(req.params.id), req.body.amount, req.ctx);
    return { ok: true, ref };
  }));
  api.get('/investments', wrap((req) =>
    db.prepare(`SELECT i.*, p.name, p.status project_status, p.end_date FROM investments i
      JOIN projects p ON p.id=i.project_id WHERE i.user_id=? ORDER BY i.id DESC`).all(req.user.id)));

  // ---------- المهام (لا تتطلب أي إيداع) ----------
  api.get('/tasks', wrap((req) =>
    db.prepare(`SELECT t.*, (t.seats - (SELECT COUNT(*) FROM task_submissions s WHERE s.task_id=t.id AND s.status!='rejected')) seats_left,
      (SELECT status FROM task_submissions s WHERE s.task_id=t.id AND s.user_id=?) my_status
      FROM tasks t WHERE t.status='open' OR t.id IN (SELECT task_id FROM task_submissions WHERE user_id=?) ORDER BY t.id DESC`).all(req.user.id, req.user.id)));

  api.post('/tasks/:id/start', wrap((req) => {
    const t = db.prepare("SELECT * FROM tasks WHERE id=? AND status='open'").get(req.params.id);
    if (!t) bad('المهمة غير متاحة');
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
    const updated = db.prepare('SELECT * FROM task_submissions WHERE id=?').get(s.id);
    bot.notifyTask(updated, task, req.user).catch((e) => console.error('notifyTask', e.message));
    return { ok: true, status: 'review' };
  }));

  app.use('/api', api);
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  return app;
}

module.exports = { createServer };
