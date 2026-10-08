// واجهة الإدارة: كل ما كان أوامر نصية أصبح أزراراً ونماذج في لوحة الإدارة داخل المنصة.
const express = require('express');
const multer = require('multer');
const { db, audit, getBalance, ACCOUNT_TYPES } = require('./db');
const fin = require('./finance');
const imp = require('./importPayouts');
const { decrypt } = require('./security');

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

function adminRouter(bot, wrap, bad) {
  const r = express.Router();
  r.use((req, res, next) => (bot.isAdmin(req.user.id) ? next() : res.status(403).json({ error: 'هذه الصفحة للإدارة فقط' })));
  const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
  const int = (v) => Math.floor(Number(String(v ?? '').replace(/[^\d-]/g, '')));

  // ---------- الإحصائيات ----------
  r.get('/stats', wrap(() => {
    const q = (sql) => db.prepare(sql).get();
    const b = q('SELECT COALESCE(SUM(available),0) a, COALESCE(SUM(pending),0) p, COALESCE(SUM(invested),0) i, COALESCE(SUM(realized_profit),0) pr FROM balances');
    return {
      users: q('SELECT COUNT(*) c FROM users').c,
      newWeek: q("SELECT COUNT(*) c FROM users WHERE created_at >= datetime('now','-7 days')").c,
      available: b.a, pending: b.p, invested: b.i, profits: b.pr,
      deposits: q("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='deposit'").s,
      pendingRequests: q("SELECT COUNT(*) c FROM withdraw_requests WHERE status='pending'").c,
      paid: q("SELECT COUNT(*) c, COALESCE(SUM(paid_amount),0) s FROM withdraw_requests WHERE status='paid'"),
      reviewTasks: q("SELECT COUNT(*) c FROM task_submissions WHERE status='review'").c,
      openProjects: q("SELECT COUNT(*) c FROM projects WHERE status IN ('open','active')").c,
    };
  }));

  // ---------- الأعضاء ----------
  r.get('/users', wrap((req) => {
    const q = String(req.query.q || '').trim();
    const rows = q
      ? db.prepare(`SELECT u.id, u.full_name, u.first_name, u.username, u.status, u.kyc_level, b.available, b.invested
          FROM users u JOIN balances b ON b.user_id=u.id
          WHERE CAST(u.id AS TEXT)=? OR u.full_name LIKE ? OR u.first_name LIKE ? OR u.username LIKE ?
          ORDER BY u.created_at DESC LIMIT 50`).all(q, `%${q}%`, `%${q}%`, `%${q}%`)
      : db.prepare(`SELECT u.id, u.full_name, u.first_name, u.username, u.status, u.kyc_level, b.available, b.invested
          FROM users u JOIN balances b ON b.user_id=u.id ORDER BY u.created_at DESC LIMIT 50`).all();
    return rows;
  }));

  r.get('/users/:id', wrap((req) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!u) bad('العضو غير موجود');
    return {
      id: u.id, full_name: u.full_name, first_name: u.first_name, username: u.username,
      phone: decrypt(u.phone_enc), account_type: ACCOUNT_TYPES[u.account_type] || null, account: decrypt(u.account_enc),
      status: u.status, kyc_level: u.kyc_level, created_at: u.created_at, is_admin: bot.isAdmin(u.id),
      referrals: db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(u.id).c,
      balance: getBalance(u.id),
      tx: db.prepare('SELECT ref, type, amount, meta, created_at FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 30').all(u.id),
      investments: db.prepare(`SELECT i.amount, i.status, p.name FROM investments i JOIN projects p ON p.id=i.project_id WHERE i.user_id=? ORDER BY i.id DESC`).all(u.id),
    };
  }));

  // إيداع تم خارجياً (أو تصحيح بالسالب)
  r.post('/users/:id/deposit', wrap((req) => {
    const amount = int(req.body.amount);
    const note = String(req.body.note || '').slice(0, 200);
    const ref = fin.creditDeposit(Number(req.params.id), amount, note, req.user.id);
    bot.notifyUser(Number(req.params.id), amount > 0
      ? `تم إضافة إيداع بمبلغ ${fmt(amount)} د.ع إلى محفظتك.`
      : `تم تصحيح رصيدك بمبلغ ${fmt(amount)} د.ع${note ? ` (${note})` : ''}.`);
    return { ok: true, ref };
  }));

  r.post('/users/:id/profit', wrap((req) => {
    const amount = int(req.body.amount);
    const note = String(req.body.note || '').slice(0, 200);
    const ref = fin.creditProfit(Number(req.params.id), amount, note, req.user.id);
    bot.notifyUser(Number(req.params.id), `أُضيف ربح بمبلغ ${fmt(amount)} د.ع إلى محفظتك${note ? ` (${note})` : ''}.`);
    return { ok: true, ref };
  }));

  r.post('/users/:id/status', wrap((req) => {
    const status = req.body.status === 'frozen' ? 'frozen' : 'active';
    const id = Number(req.params.id);
    db.prepare('UPDATE users SET status=? WHERE id=?').run(status, id);
    audit({ actor: req.user.id, action: `user_${status}`, target: id });
    bot.notifyUser(id, status === 'frozen' ? 'تم تجميد حسابك مؤقتاً. للاستفسار تواصل مع الدعم.' : 'تم تفعيل حسابك.');
    return { ok: true, status };
  }));

  r.post('/users/:id/kyc', wrap((req) => {
    const level = Math.max(0, Math.min(2, int(req.body.level)));
    db.prepare('UPDATE users SET kyc_level=? WHERE id=?').run(level, Number(req.params.id));
    audit({ actor: req.user.id, action: 'kyc_level', target: Number(req.params.id), after: { level } });
    if (level === 2) bot.notifyUser(Number(req.params.id), 'تم توثيق حسابك ✅ يمكنك الآن الاستثمار في المشاريع.', '/invest');
    return { ok: true, level };
  }));

  r.post('/users/:id/admin', wrap((req) => {
    const id = Number(req.params.id);
    if (req.body.make) db.prepare('INSERT OR IGNORE INTO admins (id) VALUES (?)').run(id);
    else {
      if (id === req.user.id) bad('لا يمكنك إزالة نفسك');
      db.prepare('DELETE FROM admins WHERE id=?').run(id);
    }
    audit({ actor: req.user.id, action: req.body.make ? 'admin_added' : 'admin_removed', target: id });
    return { ok: true };
  }));

  // ---------- طلبات السحب والتصفية ----------
  r.get('/requests', wrap((req) => {
    const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    return db.prepare(`SELECT w.*, u.full_name, u.first_name, u.account_type, u.account_enc, u.phone_enc, b.available, b.invested
      FROM withdraw_requests w JOIN users u ON u.id=w.user_id JOIN balances b ON b.user_id=w.user_id
      WHERE w.status=? ORDER BY w.id DESC LIMIT 100`).all(status).map((w) => ({
      ...w, account_type: ACCOUNT_TYPES[w.account_type] || '—', account: decrypt(w.account_enc), phone: decrypt(w.phone_enc),
      account_enc: undefined, phone_enc: undefined,
    }));
  }));

  r.post('/requests/:id/paid', wrap(async (req) => {
    const w = fin.markPaid(Number(req.params.id), req.body.amount, req.body.receipt, req.user.id);
    await bot.afterPaid(w);
    return { ok: true };
  }));

  r.post('/requests/:id/reject', wrap((req) => {
    const w = fin.rejectWithdrawal(Number(req.params.id), req.user.id);
    bot.notifyUser(w.user_id, `لم تتم الموافقة على طلبك #${w.id}، وأُعيد المبلغ المحجوز إلى رصيدك. للاستفسار تواصل مع الدعم.`);
    return { ok: true };
  }));

  // ---------- المشاريع الاستثمارية ----------
  const projectFields = (b) => ({
    name: String(b.name || '').trim(), type: b.type || null, sector: b.sector || null,
    description: b.description || null, business_model: b.business_model || null, risks: b.risks || null,
    risk_level: ['منخفضة', 'متوسطة', 'مرتفعة'].includes(b.risk_level) ? b.risk_level : 'متوسطة',
    capital_required: int(b.capital_required), min_amount: int(b.min_amount) || 100000,
    duration_days: int(b.duration_days), return_method: String(b.return_method || '').trim(),
    expected_return: String(b.expected_return || 'حسب الأداء الفعلي').trim(),
  });
  const checkProject = (p) => {
    if (!p.name) bad('اسم المشروع مطلوب');
    if (!p.capital_required || p.capital_required <= 0) bad('رأس المال المطلوب غير صالح');
    if (!p.duration_days || p.duration_days <= 0) bad('المدة غير صالحة');
    if (!p.return_method) bad('طريقة احتساب العائد مطلوبة');
    if (/مضمون|بدون مخاطر|100\s*%/.test(p.expected_return + p.return_method)) bad('لا يمكن وصف العائد بأنه مضمون');
  };

  r.get('/projects', wrap(() => db.prepare(`SELECT p.*, (SELECT COALESCE(SUM(amount),0) FROM investments i WHERE i.project_id=p.id AND i.status!='liquidated') raised,
    (SELECT COUNT(*) FROM investments i WHERE i.project_id=p.id) investors FROM projects p ORDER BY p.id DESC`).all()));

  r.post('/projects', wrap(async (req) => {
    const p = projectFields(req.body); checkProject(p);
    const status = req.body.publish ? 'open' : 'study';
    const res = db.prepare(`INSERT INTO projects (name,type,sector,description,business_model,risks,risk_level,capital_required,min_amount,duration_days,return_method,expected_return,status)
      VALUES (@name,@type,@sector,@description,@business_model,@risks,@risk_level,@capital_required,@min_amount,@duration_days,@return_method,@expected_return,'${status}')`).run(p);
    audit({ actor: req.user.id, action: 'project_created', after: { id: res.lastInsertRowid, name: p.name, status } });
    let sent = 0;
    if (req.body.publish && req.body.notify) {
      sent = await bot.broadcast(`📢 فرصة استثمار جديدة: ${p.name}\nالمدة: ${p.duration_days} يوماً · المخاطر: ${p.risk_level}\nالعائد: ${p.expected_return}\n\nالاستثمار ينطوي على مخاطر؛ اطّلع على التفاصيل قبل القرار.`, `/invest/${res.lastInsertRowid}`);
    }
    return { ok: true, id: res.lastInsertRowid, sent };
  }));

  r.put('/projects/:id', wrap((req) => {
    const p = projectFields(req.body); checkProject(p);
    const before = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
    if (!before) bad('المشروع غير موجود');
    db.prepare(`UPDATE projects SET name=@name,type=@type,sector=@sector,description=@description,business_model=@business_model,risks=@risks,
      risk_level=@risk_level,capital_required=@capital_required,min_amount=@min_amount,duration_days=@duration_days,return_method=@return_method,expected_return=@expected_return
      WHERE id=${Number(req.params.id)}`).run(p);
    audit({ actor: req.user.id, action: 'project_updated', before, after: p });
    return { ok: true };
  }));

  r.post('/projects/:id/status', wrap((req) => {
    const status = req.body.status;
    if (!['study', 'open', 'active', 'closed'].includes(status)) bad('حالة غير صحيحة');
    const before = db.prepare('SELECT status FROM projects WHERE id=?').get(req.params.id);
    if (!before) bad('المشروع غير موجود');
    const dates = status === 'active' ? ", start_date=date('now'), end_date=date('now', '+' || duration_days || ' days')" : '';
    db.prepare(`UPDATE projects SET status=?${dates} WHERE id=?`).run(status, Number(req.params.id));
    audit({ actor: req.user.id, action: 'project_status', before, after: { status } });
    return { ok: true };
  }));

  r.post('/projects/:id/settle', wrap((req) => {
    const pct = Number(req.body.percent);
    if (!Number.isFinite(pct) || pct < -100 || pct > 1000) bad('نسبة غير صالحة');
    const { project, results } = fin.settleProject(Number(req.params.id), pct, req.user.id);
    for (const x of results) {
      const word = x.pnl >= 0 ? `ربح ${fmt(x.pnl)}` : `خسارة ${fmt(-x.pnl)}`;
      bot.notifyUser(x.userId, `تمت تسوية مشروع «${project.name}».\nالمستثمر: ${fmt(x.amount)} د.ع\nالنتيجة: ${word} د.ع\nأُضيف ${fmt(x.result)} د.ع إلى رصيدك.`);
    }
    return { ok: true, investors: results.length };
  }));

  // ---------- المهام ----------
  r.get('/tasks', wrap(() => db.prepare(`SELECT t.*,
    (SELECT COUNT(*) FROM task_submissions s WHERE s.task_id=t.id AND s.status!='rejected') taken,
    (SELECT COUNT(*) FROM task_submissions s WHERE s.task_id=t.id AND s.status='review') in_review
    FROM tasks t ORDER BY t.id DESC`).all()));

  r.post('/tasks', wrap(async (req) => {
    const b = req.body;
    const t = { title: String(b.title || '').trim(), client: b.client || null, description: String(b.description || '').trim(),
      requirements: b.requirements || null, proof_required: b.proof_required || null,
      reward: int(b.reward), seats: int(b.seats) || 10, duration_hours: int(b.duration_hours) || 24 };
    if (!t.title || !t.description) bad('العنوان والوصف مطلوبان');
    if (!t.reward || t.reward <= 0) bad('المكافأة غير صالحة');
    const res = db.prepare(`INSERT INTO tasks (title,client,description,requirements,proof_required,reward,seats,duration_hours)
      VALUES (@title,@client,@description,@requirements,@proof_required,@reward,@seats,@duration_hours)`).run(t);
    audit({ actor: req.user.id, action: 'task_created', after: { id: res.lastInsertRowid, title: t.title, reward: t.reward } });
    let sent = 0;
    if (b.notify) sent = await bot.broadcast(`🆕 مهمة جديدة: ${t.title}\nالمكافأة: ${fmt(t.reward)} د.ع · المقاعد: ${t.seats}`, `/tasks/${res.lastInsertRowid}`);
    return { ok: true, id: res.lastInsertRowid, sent };
  }));

  r.post('/tasks/:id/status', wrap((req) => {
    const status = req.body.status === 'closed' ? 'closed' : 'open';
    db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, Number(req.params.id));
    audit({ actor: req.user.id, action: 'task_status', after: { id: Number(req.params.id), status } });
    return { ok: true };
  }));

  r.get('/submissions', wrap(() => db.prepare(`SELECT s.id, s.proof_text, s.proof_path IS NOT NULL has_file, s.submitted_at, t.title, t.reward,
    u.id user_id, u.full_name, u.first_name FROM task_submissions s JOIN tasks t ON t.id=s.task_id JOIN users u ON u.id=s.user_id
    WHERE s.status='review' ORDER BY s.submitted_at`).all()));

  r.get('/submissions/:id/file', (req, res) => {
    const s = db.prepare('SELECT proof_path FROM task_submissions WHERE id=?').get(req.params.id);
    if (!s?.proof_path) return res.status(404).end();
    res.sendFile(s.proof_path);
  });

  r.post('/submissions/:id/:decision', wrap((req) => {
    const ok = req.params.decision === 'accept';
    const s = ok ? fin.acceptTask(Number(req.params.id), req.user.id) : fin.rejectTask(Number(req.params.id), req.user.id);
    bot.afterTask(s, ok);
    return { ok: true };
  }));

  // ---------- سحوبات المنصة السابقة ----------
  const SOURCE = () => process.env.EXTERNAL_SOURCE_NAME || 'المنصة السابقة';
  r.post('/external-payouts', wrap(async (req) => {
    const b = req.body;
    const row = imp.insertOne({ name: b.name, amount: b.amount, method: b.method, receipt: b.receipt,
      paidAt: b.time ? imp.parseBaghdadDate(b.time) : imp.nowSql() }, req.user.id, SOURCE());
    await bot.publishPayouts([row], `سحب منفّذ — ${SOURCE()}`);
    return { ok: true };
  }));

  r.post('/external-payouts/csv', csvUpload.single('file'), wrap(async (req) => {
    if (!req.file) bad('اختر ملف CSV');
    const res = imp.importCsv(req.file.buffer.toString('utf8'), req.user.id, SOURCE());
    const today = new Date().toLocaleDateString('ar-IQ', { timeZone: 'Asia/Baghdad', day: 'numeric', month: 'long', year: 'numeric' });
    await bot.publishPayouts(res.rows, `سحوبات الأعضاء المنفّذة — ${SOURCE()}\nتاريخ النشر: ${today}`);
    return { imported: res.imported, errors: res.errors };
  }));

  // ---------- سجل التدقيق ----------
  r.get('/audit', wrap(() => db.prepare(`SELECT a.id, a.actor_id, a.action, a.target_user_id, a.created_at, u.first_name actor_name
    FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`).all()));

  return r;
}

module.exports = { adminRouter };
