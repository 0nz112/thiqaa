// بيانات تجريبية للتطوير فقط — لا تشغّله على قاعدة الإنتاج
require('dotenv').config();
const { db } = require('./db');
if (db.prepare('SELECT COUNT(*) c FROM tasks').get().c === 0) {
  const t = db.prepare(`INSERT INTO tasks (title, client, description, requirements, proof_required, reward, seats, duration_hours) VALUES (?,?,?,?,?,?,?,?)`);
  t.run('تصنيف صور منتجات (تجريبي)', '[جهة العمل]', 'تصنيف 200 صورة منتج إلى الفئات الصحيحة وفق دليل التصنيف.', 'قراءة دليل التصنيف قبل البدء', 'ملف CSV بالتصنيفات', 10000, 12, 24);
  t.run('تفريغ تسجيل صوتي (تجريبي)', '[جهة العمل]', 'تفريغ مقابلة مدتها 15 دقيقة إلى نص مكتوب.', 'إتقان اللهجة العراقية', 'ملف نصي', 15000, 5, 48);
}
if (db.prepare('SELECT COUNT(*) c FROM projects').get().c === 0) {
  db.prepare(`INSERT INTO projects (name, type, sector, description, business_model, risks, risk_level, capital_required, duration_days, return_method, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('مشروع تجاري رقم 001 (تجريبي)', 'توزيع بالجملة', 'التجارة',
    'شراء وتوزيع مواد غذائية بالجملة لمتاجر التجزئة.', 'هامش ربح على كل شحنة موزعة.',
    'تقلب الأسعار، تأخر التحصيل، تلف البضاعة. قد تخسر جزءاً من رأس المال.', 'متوسطة',
    100000000, 90, 'حصة نسبية من صافي ربح الدورة بعد التكاليف والرسوم', 'open');
}
console.log('seeded');
