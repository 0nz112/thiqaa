// كل عملية مالية داخل معاملة قاعدة بيانات واحدة وتُسجَّل في سجل التدقيق.
// الإيداع والتحويل يتمّان خارج البوت؛ البوت يسجّل ما تؤكده الإدارة فقط.
const { db, newRef, audit, getBalance } = require('./db');

const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function addTx(userId, type, amount, meta = null) {
  const ref = newRef();
  db.prepare('INSERT INTO transactions (ref, user_id, type, amount, meta) VALUES (?,?,?,?,?)')
    .run(ref, userId, type, amount, meta ? JSON.stringify(meta) : null);
  return ref;
}

function setBalance(userId, changes, actor, action, ctx = {}) {
  const before = getBalance(userId);
  if (!before) fail('المستخدم غير موجود');
  const after = { ...before };
  for (const [k, v] of Object.entries(changes)) after[k] = before[k] + v;
  if (after.available < 0 || after.pending < 0 || after.invested < 0) fail('الرصيد غير كافٍ لهذه العملية');
  db.prepare('UPDATE balances SET available=?, pending=?, invested=?, realized_profit=?, task_earnings=? WHERE user_id=?')
    .run(after.available, after.pending, after.invested, after.realized_profit, after.task_earnings, userId);
  audit({ actor, action, target: userId, before, after, ip: ctx.ip, device: ctx.device });
  return after;
}

// ---------------- إيداع خارجي تؤكده الإدارة ----------------
const creditDeposit = db.transaction((userId, amount, note, adminId) => {
  amount = Math.floor(Number(amount));
  if (!amount || amount <= 0) fail('المبلغ غير صالح');
  setBalance(userId, { available: amount }, adminId, 'deposit_recorded');
  return addTx(userId, 'deposit', amount, { note, by: adminId });
});

// ربح يُضاف مباشرة لعضو (من نتيجة نشاط فعلي يحسبها المحاسب)
const creditProfit = db.transaction((userId, amount, note, adminId) => {
  amount = Math.floor(Number(amount));
  if (!amount) fail('المبلغ غير صالح');
  setBalance(userId, { available: amount, realized_profit: amount }, adminId, 'profit_recorded');
  return addTx(userId, 'profit_settlement', amount, { note, by: adminId });
});

// ---------------- طلبات السحب والتصفية ----------------
const requestWithdrawal = db.transaction((userId, kind, amount, note, ctx) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (u.status !== 'active') fail('الحساب مجمّد، تواصل مع الإدارة');
  if (!u.account_enc || !u.phone_enc || !u.full_name) fail('أكمل ملفك الشخصي (الاسم، الهاتف، رقم الحساب) أولاً');
  if (db.prepare("SELECT 1 FROM withdraw_requests WHERE user_id=? AND status='pending'").get(userId)) {
    fail('لديك طلب قيد المراجعة، انتظر حتى تتم معالجته');
  }
  const b = getBalance(userId);
  let held;
  if (kind === 'profit') {
    amount = Math.floor(Number(amount));
    if (!amount || amount < 1000) fail('أدخل مبلغاً صحيحاً (الحد الأدنى 1,000 د.ع)');
    if (amount > b.available) fail('المبلغ أكبر من رصيدك المتاح');
    held = amount;
  } else if (kind === 'liquidation') {
    if (b.available + b.invested <= 0) fail('لا يوجد رصيد لتصفيته');
    held = b.available;
    amount = null;
  } else fail('نوع طلب غير صحيح');
  if (held > 0) setBalance(userId, { available: -held, pending: held }, userId, `${kind}_requested`, ctx);
  const r = db.prepare('INSERT INTO withdraw_requests (user_id, kind, requested_amount, held_amount, note) VALUES (?,?,?,?,?)')
    .run(userId, kind, amount, held, note ? String(note).slice(0, 300) : null);
  return db.prepare('SELECT * FROM withdraw_requests WHERE id=?').get(r.lastInsertRowid);
});

const cancelWithdrawal = db.transaction((userId, id) => {
  const r = db.prepare("SELECT * FROM withdraw_requests WHERE id=? AND user_id=? AND status='pending'").get(id, userId);
  if (!r) fail('لا يوجد طلب قابل للإلغاء');
  db.prepare("UPDATE withdraw_requests SET status='rejected', note=COALESCE(note,'') || ' [ألغاه العضو]' WHERE id=?").run(id);
  if (r.held_amount) setBalance(userId, { pending: -r.held_amount, available: r.held_amount }, userId, 'withdraw_cancelled');
  return r;
});

const rejectWithdrawal = db.transaction((id, adminId) => {
  const r = db.prepare("SELECT * FROM withdraw_requests WHERE id=? AND status='pending'").get(id);
  if (!r) fail('الطلب غير موجود أو تمت معالجته');
  db.prepare("UPDATE withdraw_requests SET status='rejected', reviewed_by=? WHERE id=?").run(adminId, id);
  if (r.held_amount) setBalance(r.user_id, { pending: -r.held_amount, available: r.held_amount }, adminId, 'withdraw_rejected');
  return r;
});

// المشرف حوّل المبلغ خارجياً ويسجّل هنا المبلغ الفعلي ورقم الإيصال
const markPaid = db.transaction((id, paidAmount, receipt, adminId) => {
  const r = db.prepare("SELECT * FROM withdraw_requests WHERE id=? AND status='pending'").get(id);
  if (!r) fail('الطلب غير موجود أو تمت معالجته');
  paidAmount = Math.floor(Number(String(paidAmount).replace(/[^\d]/g, '')));
  if (!paidAmount || paidAmount <= 0) fail('المبلغ غير صالح');
  receipt = String(receipt || '').trim();
  if (receipt.length < 3) fail('رقم الإيصال مطلوب');
  if (db.prepare('SELECT 1 FROM withdraw_requests WHERE receipt_ref=?').get(receipt) ||
      db.prepare('SELECT 1 FROM external_payouts WHERE receipt_ref=?').get(receipt)) fail('رقم الإيصال مستخدم مسبقاً');

  if (r.kind === 'profit') {
    if (paidAmount > r.held_amount) fail(`المبلغ المحوّل أكبر من المطلوب (${r.held_amount.toLocaleString('en-US')})`);
    setBalance(r.user_id, { pending: -r.held_amount, available: r.held_amount - paidAmount }, adminId, 'withdraw_paid');
    addTx(r.user_id, 'withdraw', -paidAmount, { request: id, receipt });
  } else {
    // تصفية: يُغلق الرصيد المحجوز والاستثمارات النشطة، والفرق يُسجَّل ربحاً أو خسارة
    const b = getBalance(r.user_id);
    const base = r.held_amount + b.invested;
    const diff = paidAmount - base;
    setBalance(r.user_id, { pending: -r.held_amount, invested: -b.invested, realized_profit: diff }, adminId, 'liquidation_paid');
    db.prepare("UPDATE investments SET status='liquidated', result_amount=amount WHERE user_id=? AND status='active'").run(r.user_id);
    if (diff !== 0) addTx(r.user_id, 'profit_settlement', diff, { request: id, kind: 'liquidation' });
    addTx(r.user_id, 'liquidation', -paidAmount, { request: id, receipt });
  }
  db.prepare("UPDATE withdraw_requests SET status='paid', paid_amount=?, receipt_ref=?, paid_at=?, reviewed_by=? WHERE id=?")
    .run(paidAmount, receipt, nowSql(), adminId, id);
  return db.prepare('SELECT * FROM withdraw_requests WHERE id=?').get(id);
});

// ---------------- الاستثمار ----------------
const invest = db.transaction((userId, projectId, amount, ctx) => {
  amount = Math.floor(Number(amount));
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p || p.status !== 'open') fail('المشروع غير مفتوح للاستثمار');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (user.kyc_level < 2) fail('يجب توثيق هويتك لدى الإدارة قبل الاستثمار');
  if (!Number.isFinite(amount) || amount < p.min_amount) fail(`الحد الأدنى ${p.min_amount.toLocaleString('en-US')} د.ع`);
  const raised = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM investments WHERE project_id=? AND status!='liquidated'").get(projectId).s;
  if (raised + amount > p.capital_required) fail('المبلغ يتجاوز رأس المال المتبقي للمشروع');
  setBalance(userId, { available: -amount, invested: amount }, userId, 'invest', ctx);
  db.prepare('INSERT INTO investments (user_id, project_id, amount) VALUES (?,?,?)').run(userId, projectId, amount);
  return addTx(userId, 'invest', -amount, { project: projectId });
});

const settleProject = db.transaction((projectId, returnPercent, adminId) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p || p.status !== 'active') fail('يجب أن يكون المشروع بحالة «نشط»');
  const rows = db.prepare("SELECT * FROM investments WHERE project_id=? AND status='active'").all(projectId);
  const out = [];
  for (const inv of rows) {
    const result = Math.max(0, Math.round(inv.amount * (1 + returnPercent / 100)));
    const pnl = result - inv.amount;
    setBalance(inv.user_id, { invested: -inv.amount, available: result, realized_profit: pnl }, adminId, 'project_settled');
    db.prepare("UPDATE investments SET status='settled', result_amount=? WHERE id=?").run(result, inv.id);
    addTx(inv.user_id, 'invest_return', inv.amount, { project: projectId });
    if (pnl !== 0) addTx(inv.user_id, 'profit_settlement', pnl, { project: projectId, percent: returnPercent });
    out.push({ userId: inv.user_id, amount: inv.amount, result, pnl });
  }
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  audit({ actor: adminId, action: 'project_completed', after: { projectId, returnPercent, investors: rows.length } });
  return { project: p, results: out };
});

// ---------------- المهام ----------------
const acceptTask = db.transaction((submissionId, adminId) => {
  const s = db.prepare('SELECT s.*, t.reward, t.title FROM task_submissions s JOIN tasks t ON t.id=s.task_id WHERE s.id=?').get(submissionId);
  if (!s || s.status !== 'review') fail('التسليم غير موجود أو تمت مراجعته');
  db.prepare("UPDATE task_submissions SET status='accepted' WHERE id=?").run(submissionId);
  setBalance(s.user_id, { available: s.reward, task_earnings: s.reward }, adminId, 'task_reward');
  const ref = addTx(s.user_id, 'task_reward', s.reward, { task: s.task_id });
  return { ...s, ref };
});

const rejectTask = db.transaction((submissionId, adminId) => {
  const s = db.prepare('SELECT s.*, t.title FROM task_submissions s JOIN tasks t ON t.id=s.task_id WHERE s.id=?').get(submissionId);
  if (!s || s.status !== 'review') fail('التسليم غير موجود أو تمت مراجعته');
  db.prepare("UPDATE task_submissions SET status='rejected' WHERE id=?").run(submissionId);
  audit({ actor: adminId, action: 'task_rejected', target: s.user_id, after: { submissionId } });
  return s;
});

module.exports = {
  creditDeposit, creditProfit, requestWithdrawal, cancelWithdrawal, rejectWithdrawal, markPaid,
  invest, settleProject, acceptTask, rejectTask, nowSql,
};
