// كل عملية مالية تتم داخل معاملة قاعدة بيانات واحدة وتُسجَّل في سجل التدقيق.
const { db, newRef, audit, getBalance } = require('./db');

const fail = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };

function addTx(userId, type, amount, status = 'completed', meta = null) {
  const ref = newRef();
  db.prepare('INSERT INTO transactions (ref, user_id, type, amount, status, meta) VALUES (?,?,?,?,?,?)')
    .run(ref, userId, type, amount, status, meta ? JSON.stringify(meta) : null);
  return ref;
}

function setBalance(userId, changes, actor, action, ctx = {}) {
  const before = getBalance(userId);
  const after = { ...before };
  for (const [k, v] of Object.entries(changes)) after[k] = before[k] + v;
  if (after.available < 0 || after.pending < 0 || after.invested < 0) fail('الرصيد غير كافٍ');
  db.prepare(`UPDATE balances SET available=?, pending=?, invested=?, realized_profit=?, task_earnings=? WHERE user_id=?`)
    .run(after.available, after.pending, after.invested, after.realized_profit, after.task_earnings, userId);
  audit({ actor, action, target: userId, before, after, ip: ctx.ip, device: ctx.device });
  return after;
}

// ---------------- الإيداع ----------------
const approveDeposit = db.transaction((id, adminId) => {
  const r = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(id);
  if (!r || r.status !== 'pending') fail('الطلب غير موجود أو تمت معالجته');
  db.prepare("UPDATE deposit_requests SET status='approved', reviewed_by=? WHERE id=?").run(adminId, id);
  setBalance(r.user_id, { available: r.amount }, adminId, 'deposit_approved');
  const ref = addTx(r.user_id, 'deposit', r.amount, 'completed', { request: id, method: r.method });
  return { ...r, ref };
});

const rejectDeposit = db.transaction((id, adminId) => {
  const r = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(id);
  if (!r || r.status !== 'pending') fail('الطلب غير موجود أو تمت معالجته');
  db.prepare("UPDATE deposit_requests SET status='rejected', reviewed_by=? WHERE id=?").run(adminId, id);
  audit({ actor: adminId, action: 'deposit_rejected', target: r.user_id, after: { request: id, amount: r.amount } });
  return r;
});

// ---------------- السحب ----------------
const requestWithdraw = db.transaction((userId, methodId, amount, ctx) => {
  amount = Math.floor(Number(amount));
  if (!Number.isFinite(amount) || amount < 10000) fail('الحد الأدنى للسحب 10,000 د.ع');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (user.status !== 'active') fail('الحساب مجمّد، تواصل مع الدعم');
  if (user.kyc_level < 1) fail('يجب توثيق رقم الهاتف قبل السحب');
  const m = db.prepare('SELECT * FROM payout_methods WHERE id=? AND user_id=?').get(methodId, userId);
  if (!m) fail('اختر طريقة استلام صحيحة');
  const limit = Number(process.env.DAILY_WITHDRAW_LIMIT || 5000000);
  const today = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM withdraw_requests
    WHERE user_id=? AND status!='rejected' AND date(created_at)=date('now')`).get(userId).s;
  if (today + amount > limit) fail(`تجاوزت الحد اليومي للسحب (${limit.toLocaleString('en-US')} د.ع)`);
  const fee = Math.ceil(amount * Number(process.env.WITHDRAW_FEE_PERCENT || 0) / 100);
  setBalance(userId, { available: -amount, pending: amount }, userId, 'withdraw_requested', ctx);
  const info = db.prepare('INSERT INTO withdraw_requests (user_id, payout_method_id, amount, fee, net) VALUES (?,?,?,?,?)')
    .run(userId, methodId, amount, fee, amount - fee);
  return { id: info.lastInsertRowid, amount, fee, net: amount - fee, method: m };
});

const approveWithdraw = db.transaction((id, adminId) => {
  const r = db.prepare('SELECT * FROM withdraw_requests WHERE id=?').get(id);
  if (!r || r.status !== 'pending') fail('الطلب غير موجود أو تمت معالجته');
  db.prepare("UPDATE withdraw_requests SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?").run(adminId, id);
  setBalance(r.user_id, { pending: -r.amount }, adminId, 'withdraw_approved');
  const ref = addTx(r.user_id, 'withdraw', -r.net, 'completed', { request: id });
  if (r.fee > 0) addTx(r.user_id, 'fee', -r.fee, 'completed', { request: id, kind: 'withdraw_fee' });
  return { ...r, ref };
});

const rejectWithdraw = db.transaction((id, adminId) => {
  const r = db.prepare('SELECT * FROM withdraw_requests WHERE id=?').get(id);
  if (!r || r.status !== 'pending') fail('الطلب غير موجود أو تمت معالجته');
  db.prepare("UPDATE withdraw_requests SET status='rejected', reviewed_by=? WHERE id=?").run(adminId, id);
  setBalance(r.user_id, { pending: -r.amount, available: r.amount }, adminId, 'withdraw_rejected');
  return r;
});

// ---------------- الاستثمار ----------------
const invest = db.transaction((userId, projectId, amount, ctx) => {
  amount = Math.floor(Number(amount));
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!p || p.status !== 'open') fail('المشروع غير مفتوح للاستثمار');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (user.kyc_level < 2) fail('يجب إكمال التحقق من الهوية قبل الاستثمار');
  if (!Number.isFinite(amount) || amount < p.min_amount) fail(`الحد الأدنى ${p.min_amount.toLocaleString('en-US')} د.ع`);
  const raised = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM investments WHERE project_id=?').get(projectId).s;
  if (raised + amount > p.capital_required) fail('المبلغ يتجاوز رأس المال المتبقي للمشروع');
  setBalance(userId, { available: -amount, invested: amount }, userId, 'invest', ctx);
  db.prepare('INSERT INTO investments (user_id, project_id, amount) VALUES (?,?,?)').run(userId, projectId, amount);
  return addTx(userId, 'invest', -amount, 'completed', { project: projectId });
});

// تسوية مشروع بناءً على نتيجته الفعلية المدققة (نسبة قد تكون سالبة)
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
    addTx(inv.user_id, 'invest_return', inv.amount, 'completed', { project: projectId });
    if (pnl !== 0) addTx(inv.user_id, 'profit_settlement', pnl, 'completed', { project: projectId, percent: returnPercent });
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
  const ref = addTx(s.user_id, 'task_reward', s.reward, 'completed', { task: s.task_id });
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
  approveDeposit, rejectDeposit, requestWithdraw, approveWithdraw, rejectWithdraw,
  invest, settleProject, acceptTask, rejectTask,
};
