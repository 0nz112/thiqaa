// مكافآت النشاط: لعبة تحفيزية مجانية.
// المستوى يُكتسب بإجمالي أرباح المهام فقط (task_earnings)، لا بالرصيد الكلي ولا بالإيداع أو الاستثمار.
// مكافأة اليوم تُستلم مرة واحدة يومياً بشرط إنجاز مهمة في اليوم نفسه، ضمن ميزانية شهرية تحددها الإدارة.
const { db, newRef, audit, getBalance, getSetting, setSetting } = require('./db');

const NOTES = [250, 500, 1000, 5000, 10000, 25000, 50000];
const fail = (m) => { const e = new Error(m); e.userFacing = true; throw e; };
const noteFor = (amount) => NOTES.filter((n) => n <= amount).pop() || 250;

const tiers = () => db.prepare('SELECT * FROM activity_tiers ORDER BY level').all();
const accepted = (uid) => db.prepare("SELECT COUNT(*) c FROM task_submissions WHERE user_id=? AND status='accepted'").get(uid).c;
const earned = (uid) => (getBalance(uid) || { task_earnings: 0 }).task_earnings;
const today = () => db.prepare("SELECT date('now','+3 hours') d").get().d; // يوم بتوقيت بغداد

function levelFor(n) {
  let lv = null;
  for (const t of tiers()) if (n >= t.min_earnings) lv = t;
  return lv;
}

function budget() {
  const total = Number(getSetting('activity_budget') || 0);
  const used = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM activity_claims
    WHERE strftime('%Y-%m', created_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours')`).get().s;
  return { total, used, left: Math.max(0, total - used) };
}

function taskDoneToday(uid) {
  return !!db.prepare(`SELECT 1 FROM task_submissions WHERE user_id=? AND status IN ('review','accepted')
    AND date(submitted_at, '+3 hours') = date('now', '+3 hours') LIMIT 1`).get(uid);
}

function status(uid) {
  const n = earned(uid);
  const lv = levelFor(n);
  const all = tiers();
  const next = all.find((t) => t.min_earnings > n) || null;
  const claim = db.prepare('SELECT * FROM activity_claims WHERE user_id=? AND day=?').get(uid, today());
  const b = budget();
  return {
    enabled: getSetting('activity_enabled') === '1',
    earned: n, accepted: accepted(uid),
    level: lv ? { ...lv, note: noteFor(lv.daily_reward) } : null,
    next: next ? { ...next, remaining: next.min_earnings - n, note: noteFor(next.daily_reward) } : null,
    tiers: all.map((t) => ({ ...t, note: noteFor(t.daily_reward), unlocked: n >= t.min_earnings })),
    today: { taskDone: taskDoneToday(uid), claimed: !!claim, amount: claim ? claim.amount : (lv ? lv.daily_reward : 0) },
    budgetAvailable: !!lv && b.left >= lv.daily_reward,
    monthEarned: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM activity_claims WHERE user_id=?
      AND strftime('%Y-%m', created_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours')`).get(uid).s,
    history: db.prepare('SELECT day, level, amount FROM activity_claims WHERE user_id=? ORDER BY id DESC LIMIT 14').all(uid),
  };
}

const claim = db.transaction((uid, ctx = {}) => {
  if (getSetting('activity_enabled') !== '1') fail('مكافآت النشاط متوقفة حالياً');
  const u = db.prepare('SELECT status FROM users WHERE id=?').get(uid);
  if (u.status !== 'active') fail('الحساب مجمّد، تواصل مع الإدارة');
  const lv = levelFor(earned(uid));
  if (!lv) fail(`يبدأ المستوى الأول عندما تصل أرباحك من المهام إلى ${tiers()[0].min_earnings.toLocaleString('en-US')} د.ع`);
  if (!taskDoneToday(uid)) fail('أنجز مهمة واحدة اليوم لتفعيل مكافأة اليوم');
  if (db.prepare('SELECT 1 FROM activity_claims WHERE user_id=? AND day=?').get(uid, today())) fail('استلمت مكافأة اليوم، عُد غداً');
  if (budget().left < lv.daily_reward) fail('اكتملت ميزانية مكافآت هذا الشهر، تتجدد في بداية الشهر القادم');
  db.prepare('INSERT INTO activity_claims (user_id, day, level, amount) VALUES (?,?,?,?)').run(uid, today(), lv.level, lv.daily_reward);
  const before = getBalance(uid);
  db.prepare('UPDATE balances SET available = available + ? WHERE user_id=?').run(lv.daily_reward, uid);
  db.prepare("INSERT INTO transactions (ref, user_id, type, amount, meta) VALUES (?,?, 'activity_reward', ?, ?)")
    .run(newRef(), uid, lv.daily_reward, JSON.stringify({ level: lv.level }));
  audit({ actor: uid, action: 'activity_claimed', target: uid, before, after: getBalance(uid), ip: ctx.ip, device: ctx.device });
  return { amount: lv.daily_reward, level: lv.level, note: noteFor(lv.daily_reward) };
});

function adminView() {
  const b = budget();
  return {
    enabled: getSetting('activity_enabled') === '1', budget: b, tiers: tiers(),
    claimsMonth: db.prepare(`SELECT COUNT(*) c FROM activity_claims WHERE strftime('%Y-%m', created_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours')`).get().c,
    byLevel: db.prepare(`SELECT level, COUNT(*) c FROM activity_claims WHERE strftime('%Y-%m', created_at, '+3 hours') = strftime('%Y-%m', 'now', '+3 hours') GROUP BY level`).all(),
  };
}

const adminUpdate = db.transaction((body, adminId) => {
  const list = Array.isArray(body.tiers) ? body.tiers : [];
  if (list.length !== 6) fail('يجب إدخال المستويات الستة');
  let prev = 0;
  for (const t of list) {
    const min = Math.floor(Number(t.min_earnings)); const r = Math.floor(Number(t.daily_reward));
    if (!(min > prev)) fail('أرباح المهام المطلوبة يجب أن تزيد من مستوى لآخر');
    if (!(r > 0)) fail('المكافأة اليومية يجب أن تكون أكبر من صفر');
    prev = min;
  }
  const before = tiers();
  const up = db.prepare('UPDATE activity_tiers SET min_earnings=?, daily_reward=? WHERE level=?');
  list.forEach((t, i) => up.run(Math.floor(t.min_earnings), Math.floor(t.daily_reward), i + 1));
  const bud = Math.max(0, Math.floor(Number(body.budget)));
  setSetting('activity_budget', bud);
  setSetting('activity_enabled', body.enabled ? '1' : '0');
  audit({ actor: adminId, action: 'activity_settings', before, after: { tiers: tiers(), budget: bud, enabled: !!body.enabled } });
  return adminView();
});

module.exports = { status, claim, adminView, adminUpdate };
