// استيراد سحوبات نُفّذت فعلاً على منصة أخرى.
// القواعد: تاريخ التحويل لا يمكن أن يكون في المستقبل، ولكل سحب رقم إيصال فريد، ويُحفظ المصدر ويظهر للأعضاء.
const { db, audit, maskName } = require('./db');

const METHODS = {
  zaincash: 'zaincash', 'زين كاش': 'zaincash', 'زين': 'zaincash',
  qicard: 'qicard', 'كي كارد': 'qicard', 'كي': 'qicard', 'ماستركارد': 'qicard',
  bank: 'bank', 'مصرفي': 'bank', 'تحويل مصرفي': 'bank',
  other: 'other', 'أخرى': 'other',
};

// يقبل "2026-10-05 14:30" أو "2026-10-05" بتوقيت بغداد (UTC+3) ويعيد صيغة SQLite بتوقيت UTC
function parseBaghdadDate(str) {
  const t = String(str || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (t) {
    // وقت فقط = اليوم بتوقيت بغداد
    const bg = new Date(Date.now() + 3 * 3600 * 1000);
    str = `${bg.getUTCFullYear()}-${bg.getUTCMonth() + 1}-${bg.getUTCDate()} ${t[1]}:${t[2]}`;
  }
  const m = String(str || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '00'] = m;
  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h - 3, +mi));
  if (Number.isNaN(utc.getTime())) return null;
  return utc.toISOString().slice(0, 19).replace('T', ' ');
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function insertOne({ name, amount, method, paidAt, receipt }, adminId, source) {
  const amt = Math.floor(Number(String(amount).replace(/[^\d]/g, '')));
  if (!name || String(name).trim().length < 2) throw new Error('الاسم مفقود');
  if (!amt || amt < 1000 || amt > 50000000) throw new Error('المبلغ غير صالح');
  const m = METHODS[String(method || '').trim().toLowerCase()] || METHODS[String(method || '').trim()];
  if (!m) throw new Error('طريقة غير معروفة (zaincash / qicard / bank / other)');
  const ref = String(receipt || '').trim();
  if (ref.length < 4) throw new Error('رقم الإيصال مطلوب');
  if (!paidAt) throw new Error('تاريخ غير صالح، الصيغة: 2026-10-05 14:30');
  if (paidAt > nowSql()) throw new Error('تاريخ في المستقبل — تُستورد السحوبات المنفّذة فقط');
  if (db.prepare('SELECT 1 FROM external_payouts WHERE receipt_ref=?').get(ref) ||
      db.prepare('SELECT 1 FROM withdraw_requests WHERE receipt_ref=?').get(ref)) throw new Error('رقم الإيصال مستخدم مسبقاً');
  const r = db.prepare(`INSERT INTO external_payouts (source, display_name, amount, method, paid_at, receipt_ref, imported_by)
    VALUES (?,?,?,?,?,?,?)`).run(source, maskName(String(name).trim()), amt, m, paidAt, ref, adminId);
  audit({ actor: adminId, action: 'external_payout_imported', after: { id: r.lastInsertRowid, source, amount: amt, method: m, paidAt, receipt: ref } });
  return { id: r.lastInsertRowid, name: maskName(String(name).trim()), amount: amt, method: m, at: paidAt, source };
}

// CSV: name,amount,method,paid_at,receipt  (السطر الأول عناوين)
// paid_at: "2026-10-05 14:30" أو "14:30" فقط لسحوبات اليوم
function importCsv(text, adminId, source) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const results = { imported: 0, errors: [], rows: [] };
  const rows = lines.slice(1);
  const run = db.transaction(() => {
    rows.forEach((line, i) => {
      const [name, amount, method, paid, receipt] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      try {
        results.rows.push(insertOne({ name, amount, method, paidAt: parseBaghdadDate(paid), receipt }, adminId, source));
        results.imported++;
      } catch (e) {
        results.errors.push(`سطر ${i + 2}: ${e.message}`);
      }
    });
  });
  run();
  return results;
}

module.exports = { importCsv, insertOne, parseBaghdadDate, nowSql };
