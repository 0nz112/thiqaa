// استعادة قاعدة البيانات من نسخة احتياطية (ملف .db) يرسله المشرف للبوت مع التعليق /restore
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { db, dbPath, dataDir } = require('./db');

function inspect(file) {
  let d;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['users', 'balances', 'transactions']) if (!tables.includes(t)) throw new Error(`الملف لا يحتوي جدول ${t}`);
    return {
      users: d.prepare('SELECT COUNT(*) c FROM users').get().c,
      balance: d.prepare('SELECT COALESCE(SUM(available + pending + invested),0) s FROM balances').get().s,
    };
  } catch (e) {
    throw new Error(e.message.includes('file is not a database') ? 'الملف ليس قاعدة بيانات صالحة' : e.message);
  } finally { try { d && d.close(); } catch (e) {} }
}

// يتحقق من النسخة، يحفظ نسخة من البيانات الحالية، ثم يستبدل القاعدة. بعدها يجب إعادة تشغيل العملية.
function restoreFrom(file, force = false) {
  const incoming = inspect(file);
  const current = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (current > incoming.users && !force) {
    throw new Error(`القاعدة الحالية فيها ${current} مشترك والنسخة فيها ${incoming.users} فقط. للتأكيد أرسل الملف مع التعليق: /restore force`);
  }
  const bdir = path.join(dataDir, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const before = path.join(bdir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
  db.prepare('VACUUM INTO ?').run(before);
  db.close();
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (e) {} }
  fs.copyFileSync(file, dbPath);
  return { ...incoming, previous: current, before };
}

module.exports = { inspect, restoreFrom };
