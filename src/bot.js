const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const { db, upsertUser, audit, publicName, maskName, getBalance, ACCOUNT_TYPES } = require('./db');
const fin = require('./finance');
const imp = require('./importPayouts');
const { decrypt } = require('./security');

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const ENV_ADMINS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const allAdmins = () => [...new Set([...ENV_ADMINS, ...db.prepare('SELECT id FROM admins').all().map((r) => r.id)])];
const isAdmin = (id) => allAdmins().includes(Number(id));

const referralLink = (userId) => `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;

// نص الدعوة — بدون وعود بأرباح مضمونة
function marketingText(userId) {
  return [
    'أدعوك للانضمام إلى منصة «ثقة» 🟢',
    '',
    '• محفظة واضحة تعرض رصيدك وأرباحك ومصدر كل مبلغ.',
    '• مهام مدفوعة وفرص استثمار في مشاريع معلنة بتفاصيلها ومخاطرها.',
    '• صفحة عامة لسحوبات الأعضاء المنفّذة.',
    '',
    `سجّل من هنا: ${referralLink(userId)}`,
    '',
    'تنبيه: الاستثمار ينطوي على مخاطر، والعوائد تعتمد على الأداء الفعلي.',
  ].join('\n');
}

function createBot() {
  const bot = new Bot(process.env.BOT_TOKEN);
  const ADMIN_CHAT = process.env.ADMIN_CHAT_ID;
  const SOURCE = () => process.env.EXTERNAL_SOURCE_NAME || 'المنصة السابقة';

  // يرسل لمجموعة المشرفين إن وُجدت، وإلا لكل مشرف في الخاص
  const toAdmins = async (send) => {
    const targets = ADMIN_CHAT ? [ADMIN_CHAT] : allAdmins();
    for (const t of targets) await send(t).catch((e) => console.error('notify admin:', e.message));
  };

  // رمز لمرة واحدة يظهر في السجلات لتعيين أول مشرف
  bot.adminCode = allAdmins().length ? null : String(Math.floor(100000 + Math.random() * 900000));
  bot.command('admin', async (ctx) => {
    if (!bot.adminCode || (ctx.match || '').trim() !== bot.adminCode) return;
    upsertUser(ctx.from);
    db.prepare('INSERT OR IGNORE INTO admins (id) VALUES (?)').run(ctx.from.id);
    audit({ actor: ctx.from.id, action: 'admin_claimed', target: ctx.from.id });
    bot.adminCode = null;
    await ctx.reply('أصبحت مشرف البوت ✅\nستصلك هنا طلبات السحب وتصفية الحساب وتسليمات المهام.\nأرسل /help لقائمة أوامر الإدارة.');
  });

  const mainKeyboard = () => new InlineKeyboard()
    .webApp('فتح المنصة', process.env.WEBAPP_URL).row()
    .switchInline('مشاركة رابط الإحالة مع جهات اتصالك', '').row()
    .text('رابط الإحالة الخاص بي', 'my_ref');

  // ---------------- /start ----------------
  bot.command('start', async (ctx) => {
    const payload = ctx.match || '';
    const refId = payload.startsWith('ref_') ? Number(payload.slice(4)) : null;
    const { created, referrerId } = upsertUser(ctx.from, refId);
    if (created && referrerId) {
      bot.api.sendMessage(referrerId, `انضم ${ctx.from.first_name || 'عضو جديد'} إلى المنصة عبر رابط الإحالة الخاص بك.`).catch(() => {});
    }
    await ctx.reply(
      `أهلاً ${ctx.from.first_name || ''} في منصة «ثقة» 👋\n\n` +
      'من «فتح المنصة» تتابع رصيدك وأرباحك، وتكمل ملفك الشخصي، وتطلب سحب الأرباح أو تصفية الحساب.\n\n' +
      'شارك المنصة مع أصدقائك: اضغط «مشاركة رابط الإحالة» واختر المحادثات التي تريد إرسال الدعوة إليها.',
      { reply_markup: mainKeyboard() }
    );
  });

  bot.on('message:contact', async (ctx) => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply('يرجى مشاركة رقم هاتفك أنت عبر الزر.');
    upsertUser(ctx.from);
    db.prepare('UPDATE users SET tg_phone=?, kyc_level=MAX(kyc_level,1) WHERE id=?').run(c.phone_number, ctx.from.id);
    audit({ actor: ctx.from.id, action: 'phone_verified', target: ctx.from.id });
    await ctx.reply('تم توثيق رقم هاتفك ✅', { reply_markup: { remove_keyboard: true } });
  });

  bot.command('verify', (ctx) => ctx.reply('اضغط الزر لمشاركة رقمك:', {
    reply_markup: new Keyboard().requestContact('مشاركة رقم الهاتف').resized().oneTime(),
  }));

  bot.callbackQuery('my_ref', async (ctx) => {
    await ctx.answerCallbackQuery();
    const count = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(ctx.from.id).c;
    await ctx.reply(`رابط الإحالة الخاص بك:\n${referralLink(ctx.from.id)}\n\nعدد المسجلين عبر رابطك: ${count}`,
      { reply_markup: new InlineKeyboard().switchInline('مشاركة مع جهات الاتصال', '') });
  });

  // مشاركة الدعوة (يتطلب تفعيل Inline Mode عبر /setinline في BotFather)
  bot.on('inline_query', async (ctx) => {
    upsertUser(ctx.from);
    await ctx.answerInlineQuery([{
      type: 'article',
      id: `ref-${ctx.from.id}`,
      title: 'إرسال دعوة لمنصة ثقة',
      description: 'رسالة تعريفية مع رابط الإحالة الخاص بك',
      input_message_content: { message_text: marketingText(ctx.from.id), link_preview_options: { is_disabled: true } },
      reply_markup: new InlineKeyboard().url('انضم إلى المنصة', referralLink(ctx.from.id)),
    }], { cache_time: 0, is_personal: true });
  });

  // ---------------- نشر السحوبات المنفّذة في القناة (اختياري) ----------------
  const timeBaghdad = (sql) => new Date(sql.replace(' ', 'T') + 'Z')
    .toLocaleString('ar-IQ', { timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  bot.publishPayouts = async (rows, title) => {
    const ch = process.env.PAYOUTS_CHANNEL_ID;
    if (!ch || !rows.length) return;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const total = sorted.reduce((s, r) => s + r.amount, 0);
    const chunks = []; let cur = `${title}\n\n`;
    for (const r of sorted) {
      const l = `• ${r.name} — ${fmt(r.amount)} د.ع${ACCOUNT_TYPES[r.method] && r.method !== 'other' ? ' عبر ' + ACCOUNT_TYPES[r.method] : ''} — ${timeBaghdad(r.at)}\n`;
      if ((cur + l).length > 3800) { chunks.push(cur); cur = ''; }
      cur += l;
    }
    cur += `\nالعدد: ${sorted.length} · المجموع: ${fmt(total)} د.ع`;
    chunks.push(cur);
    for (const c of chunks) await bot.api.sendMessage(ch, c).catch((e) => console.error('publishPayouts:', e.message));
  };

  // ---------------- طلبات السحب: إشعار الإدارة ----------------
  const KIND = { profit: 'سحب أرباح', liquidation: 'تصفية الحساب' };
  bot.notifyWithdrawal = async (r, u) => {
    const b = getBalance(u.id);
    const amountLine = r.kind === 'profit'
      ? `المبلغ المطلوب: ${fmt(r.requested_amount)} د.ع`
      : `تصفية كاملة — الرصيد المتاح المحجوز: ${fmt(r.held_amount)} د.ع + المستثمر: ${fmt(b.invested)} د.ع`;
    const text = [
      `🔔 طلب ${KIND[r.kind]} #${r.id}`,
      '',
      `الاسم: ${u.full_name}`,
      `الهاتف: ${decrypt(u.phone_enc)}`,
      `الحساب: ${ACCOUNT_TYPES[u.account_type] || '—'} — ${decrypt(u.account_enc)}`,
      `تيليغرام: ${u.first_name || ''} (@${u.username || '—'}) · ID ${u.id}`,
      '',
      amountLine,
      r.note ? `ملاحظة العضو: ${r.note}` : '',
      '',
      'راجع الطلب خارجياً، وبعد التحويل اضغط «تم التحويل» وأدخل المبلغ ورقم الإيصال.',
    ].filter((x) => x !== '').join('\n');
    await toAdmins((chat) => bot.api.sendMessage(chat, text, {
      reply_markup: new InlineKeyboard().text('تم التحويل — تسجيل البيانات', `pay_${r.id}`).row().text('رفض الطلب', `wrej_${r.id}`),
    }));
  };

  // بعد التحويل: نشر + إشعار العضو
  const afterPaid = async (r) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id);
    bot.api.sendMessage(r.user_id,
      `تم تنفيذ طلب ${KIND[r.kind]} #${r.id} ✅\nالمبلغ المحوّل: ${fmt(r.paid_amount)} د.ع\nإلى: ${ACCOUNT_TYPES[u.account_type] || ''} ${u.account_masked || ''}\nرقم الإيصال: ${r.receipt_ref}`).catch(() => {});
    await bot.publishPayouts([{ name: publicName(u), amount: r.paid_amount, method: u.account_type, at: r.paid_at }], 'سحب منفّذ');
  };

  // حالة إدخال بيانات التحويل لكل مشرف
  const awaitingPay = new Map();

  bot.callbackQuery(/^pay_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'غير مصرح', show_alert: true });
    const id = Number(ctx.match[1]);
    const r = db.prepare("SELECT * FROM withdraw_requests WHERE id=? AND status='pending'").get(id);
    if (!r) return ctx.answerCallbackQuery({ text: 'الطلب تمت معالجته', show_alert: true });
    awaitingPay.set(ctx.from.id, id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`طلب #${id}: أرسل الآن بيانات التحويل بهذا الشكل:\nالمبلغ المحوّل | رقم الإيصال\n\nمثال: 150000 | ZC-884512\n(أو /cancel للإلغاء)`,
      { reply_markup: { force_reply: true } });
  });

  bot.callbackQuery(/^wrej_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'غير مصرح', show_alert: true });
    try {
      const r = fin.rejectWithdrawal(Number(ctx.match[1]), ctx.from.id);
      await ctx.answerCallbackQuery({ text: 'تم الرفض' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`❌ طلب #${r.id} مرفوض — بواسطة ${ctx.from.first_name}`);
      bot.api.sendMessage(r.user_id, `لم تتم الموافقة على طلب ${KIND[r.kind]} #${r.id}، وأُعيد المبلغ المحجوز إلى رصيدك المتاح. للاستفسار تواصل مع الإدارة.`).catch(() => {});
    } catch (e) { await ctx.answerCallbackQuery({ text: e.userFacing ? e.message : 'حدث خطأ', show_alert: true }); }
  });

  // ---------------- المهام: قبول/رفض ----------------
  const decide = (pattern, handler) => bot.callbackQuery(pattern, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'غير مصرح', show_alert: true });
    try {
      const msg = await handler(ctx, Number(ctx.match[1]));
      await ctx.answerCallbackQuery({ text: 'تم' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`${msg} — بواسطة ${ctx.from.first_name}`);
    } catch (e) { await ctx.answerCallbackQuery({ text: e.userFacing ? e.message : 'حدث خطأ', show_alert: true }); }
  });
  decide(/^task_ok_(\d+)$/, async (ctx, id) => {
    const s = fin.acceptTask(id, ctx.from.id);
    bot.api.sendMessage(s.user_id, `تم قبول مهمة «${s.title}» وإضافة مكافأة ${fmt(s.reward)} د.ع إلى رصيدك.`).catch(() => {});
    return `✅ تسليم مهمة #${id} مقبول`;
  });
  decide(/^task_no_(\d+)$/, async (ctx, id) => {
    const s = fin.rejectTask(id, ctx.from.id);
    bot.api.sendMessage(s.user_id, `لم تُقبل مهمة «${s.title}». راجع المتطلبات وحاول في مهمة أخرى.`).catch(() => {});
    return `❌ تسليم مهمة #${id} مرفوض`;
  });

  // ---------------- أوامر الإدارة ----------------
  const admin = (name, fn) => bot.command(name, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try { await fn(ctx, (ctx.match || '').trim()); }
    catch (e) { await ctx.reply(e.userFacing ? e.message : `خطأ: ${e.message}`); }
  });

  admin('help', (ctx) => ctx.reply([
    'أوامر الإدارة:',
    '/pending — الطلبات قيد المراجعة',
    '/paid رقم_الطلب المبلغ رقم_الإيصال — تسجيل تحويل',
    '/user ID — ملف عضو ورصيده',
    '/deposit ID المبلغ ملاحظة — تسجيل إيداع خارجي',
    '/profit ID المبلغ ملاحظة — إضافة ربح لعضو',
    '/stats — إحصائيات',
    '/extpayout الاسم | المبلغ | الطريقة | الإيصال — سحب من المنصة الأخرى',
    'ملف CSV مع التعليق /import_payouts — قائمة سحوبات اليوم',
    '/addtask ، /addproject ، /pstatus ، /settle',
    '/kyc ID المستوى ، /freeze ID ، /unfreeze ID',
  ].join('\n')));

  admin('cancel', async (ctx) => { awaitingPay.delete(ctx.from.id); await ctx.reply('تم الإلغاء'); });

  admin('paid', async (ctx, arg) => {
    const [id, amount, ...rest] = arg.split(/\s+/);
    const r = fin.markPaid(Number(id), amount, rest.join(' '), ctx.from.id);
    await ctx.reply(`✅ تم تسجيل تحويل طلب #${r.id}: ${fmt(r.paid_amount)} د.ع — إيصال ${r.receipt_ref}`);
    await afterPaid(r);
  });

  admin('pending', async (ctx) => {
    const rows = db.prepare(`SELECT w.*, u.full_name FROM withdraw_requests w JOIN users u ON u.id=w.user_id
      WHERE w.status='pending' ORDER BY w.id`).all();
    if (!rows.length) return ctx.reply('لا توجد طلبات قيد المراجعة');
    for (const r of rows.slice(0, 20)) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id);
      await bot.notifyWithdrawal(r, u);
    }
  });

  admin('user', async (ctx, arg) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(arg));
    if (!u) return ctx.reply('العضو غير موجود');
    const b = getBalance(u.id);
    await ctx.reply([
      `العضو ${u.id} — ${u.full_name || u.first_name || ''}`,
      `الهاتف: ${decrypt(u.phone_enc) || '—'} · تيليغرام: ${u.tg_phone || 'غير موثّق'}`,
      `الحساب: ${ACCOUNT_TYPES[u.account_type] || '—'} ${decrypt(u.account_enc) || ''}`,
      `التحقق: ${u.kyc_level} · الحالة: ${u.status}`,
      '',
      `المتاح: ${fmt(b.available)} · المحجوز: ${fmt(b.pending)} · المستثمر: ${fmt(b.invested)}`,
      `الأرباح المحققة: ${fmt(b.realized_profit)} · مكافآت المهام: ${fmt(b.task_earnings)}`,
    ].join('\n'));
  });

  admin('deposit', async (ctx, arg) => {
    const [id, amount, ...note] = arg.split(/\s+/);
    const ref = fin.creditDeposit(Number(id), amount, note.join(' '), ctx.from.id);
    await ctx.reply(`تم تسجيل إيداع ${fmt(amount)} د.ع للعضو ${id} (${ref})`);
    bot.api.sendMessage(Number(id), `تم تسجيل إيداع بمبلغ ${fmt(amount)} د.ع في حسابك.`).catch(() => {});
  });

  admin('profit', async (ctx, arg) => {
    const [id, amount, ...note] = arg.split(/\s+/);
    const ref = fin.creditProfit(Number(id), amount, note.join(' '), ctx.from.id);
    await ctx.reply(`تم تسجيل ربح ${fmt(amount)} د.ع للعضو ${id} (${ref})`);
    bot.api.sendMessage(Number(id), `أُضيف ربح بمبلغ ${fmt(amount)} د.ع إلى رصيدك${note.length ? ` (${note.join(' ')})` : ''}.`).catch(() => {});
  });

  admin('stats', async (ctx) => {
    const q = (sql) => db.prepare(sql).get();
    const users = q('SELECT COUNT(*) c FROM users').c;
    const b = q('SELECT SUM(available) a, SUM(pending) p, SUM(invested) i FROM balances');
    const pend = q("SELECT COUNT(*) c FROM withdraw_requests WHERE status='pending'").c;
    const paid = q("SELECT COUNT(*) c, COALESCE(SUM(paid_amount),0) s FROM withdraw_requests WHERE status='paid'");
    const tr = q("SELECT COUNT(*) c FROM task_submissions WHERE status='review'").c;
    await ctx.reply(`الأعضاء: ${users}\nالأرصدة المتاحة: ${fmt(b.a)}\nالمحجوز لطلبات: ${fmt(b.p)}\nالمستثمر: ${fmt(b.i)}\n\n` +
      `طلبات قيد المراجعة: ${pend}\nسحوبات منفّذة: ${paid.c} بمجموع ${fmt(paid.s)}\nمهام للمراجعة: ${tr}`);
  });

  admin('addtask', async (ctx, arg) => {
    const [title, client, reward, seats, hours, description, requirements, proof] = arg.split('|').map((s) => s?.trim());
    if (!title || !reward || !description) return ctx.reply('الصيغة: /addtask العنوان | الجهة | المكافأة | المقاعد | الساعات | الوصف | المتطلبات | الإثبات');
    const r = db.prepare(`INSERT INTO tasks (title, client, reward, seats, duration_hours, description, requirements, proof_required)
      VALUES (?,?,?,?,?,?,?,?)`).run(title, client, Number(reward), Number(seats) || 10, Number(hours) || 24, description, requirements, proof);
    audit({ actor: ctx.from.id, action: 'task_created', after: { id: r.lastInsertRowid, title, reward } });
    await ctx.reply(`تمت إضافة المهمة #${r.lastInsertRowid}`);
  });

  admin('addproject', async (ctx, arg) => {
    const [name, type, sector, capital, days, risk, method, description, model, risks] = arg.split('|').map((s) => s?.trim());
    if (!name || !capital || !days || !method) return ctx.reply('الصيغة: /addproject الاسم | النوع | القطاع | رأس المال | الأيام | المخاطر | طريقة الاحتساب | الوصف | نموذج العمل | المخاطر التفصيلية');
    const r = db.prepare(`INSERT INTO projects (name, type, sector, capital_required, duration_days, risk_level, return_method, description, business_model, risks)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, type, sector, Number(capital), Number(days), risk || 'متوسطة', method, description, model, risks);
    audit({ actor: ctx.from.id, action: 'project_created', after: { id: r.lastInsertRowid, name } });
    await ctx.reply(`تمت إضافة المشروع #${r.lastInsertRowid} بحالة «قيد الدراسة». لفتحه: /pstatus ${r.lastInsertRowid} open`);
  });

  admin('pstatus', async (ctx, arg) => {
    const [id, status] = arg.split(/\s+/);
    if (!['study', 'open', 'active', 'closed'].includes(status)) return ctx.reply('الحالات: study | open | active | closed');
    const before = db.prepare('SELECT status FROM projects WHERE id=?').get(Number(id));
    if (!before) return ctx.reply('المشروع غير موجود');
    const dates = status === 'active' ? ", start_date=date('now'), end_date=date('now', '+' || duration_days || ' days')" : '';
    db.prepare(`UPDATE projects SET status=?${dates} WHERE id=?`).run(status, Number(id));
    audit({ actor: ctx.from.id, action: 'project_status', before, after: { status } });
    await ctx.reply(`حالة المشروع #${id}: ${status}`);
  });

  admin('settle', async (ctx, arg) => {
    const [id, pct] = arg.split(/\s+/).map(Number);
    if (!id || !Number.isFinite(pct)) return ctx.reply('الصيغة: /settle رقم_المشروع النسبة (مثال: /settle 3 4.5 أو /settle 3 -2)');
    const { project, results } = fin.settleProject(id, pct, ctx.from.id);
    for (const r of results) {
      const word = r.pnl >= 0 ? `ربح ${fmt(r.pnl)}` : `خسارة ${fmt(-r.pnl)}`;
      bot.api.sendMessage(r.userId, `تمت تسوية مشروع «${project.name}».\nالمستثمر: ${fmt(r.amount)} د.ع\nالنتيجة: ${word} د.ع\nأُضيف ${fmt(r.result)} د.ع إلى رصيدك المتاح.`).catch(() => {});
    }
    await ctx.reply(`تمت تسوية المشروع #${id} لعدد ${results.length} مستثمر بنسبة ${pct}%`);
  });

  const setStatus = (status, word) => async (ctx, arg) => {
    db.prepare('UPDATE users SET status=? WHERE id=?').run(status, Number(arg));
    audit({ actor: ctx.from.id, action: `user_${status}`, target: Number(arg) });
    await ctx.reply(`${word} الحساب ${arg}`);
  };
  admin('freeze', setStatus('frozen', 'تم تجميد'));
  admin('unfreeze', setStatus('active', 'تم تفعيل'));

  admin('kyc', async (ctx, arg) => {
    const [id, level] = arg.split(/\s+/).map(Number);
    db.prepare('UPDATE users SET kyc_level=? WHERE id=?').run(level, id);
    audit({ actor: ctx.from.id, action: 'kyc_level', target: id, after: { kyc_level: level } });
    await ctx.reply(`مستوى التحقق للعضو ${id}: ${level}`);
  });

  admin('extpayout', async (ctx, arg) => {
    const [name, amount, method, receipt] = arg.split('|').map((x) => x?.trim());
    if (!name || !amount || !method || !receipt) return ctx.reply('الصيغة: /extpayout الاسم | المبلغ | zaincash أو qicard | رقم_الإيصال');
    const row = imp.insertOne({ name, amount, method, receipt, paidAt: imp.nowSql() }, ctx.from.id, SOURCE());
    await ctx.reply(`تم تسجيل السحب #${row.id} (عبر ${SOURCE()})`);
    await bot.publishPayouts([row], `سحب منفّذ — ${SOURCE()}`);
  });

  // ملف CSV لسحوبات اليوم مع التعليق /import_payouts
  bot.on('message:document', async (ctx, next) => {
    if (!(ctx.message.caption || '').startsWith('/import_payouts')) return next();
    if (!isAdmin(ctx.from.id)) return;
    const doc = ctx.message.document;
    if (!/\.csv$/i.test(doc.file_name || '') || doc.file_size > 2 * 1024 * 1024) return ctx.reply('أرسل ملف CSV أقل من 2MB');
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
    const r = imp.importCsv(await res.text(), ctx.from.id, SOURCE());
    const today = new Date().toLocaleDateString('ar-IQ', { timeZone: 'Asia/Baghdad', day: 'numeric', month: 'long', year: 'numeric' });
    await bot.publishPayouts(r.rows, `سحوبات الأعضاء المنفّذة — ${SOURCE()}\nتاريخ النشر: ${today}`);
    const errs = r.errors.slice(0, 25).join('\n');
    await ctx.reply(`تم استيراد ${r.imported} سحب.` + (r.errors.length ? `\n\nمرفوض ${r.errors.length}:\n${errs}` : ''));
  });

  // نص المشرف بعد «تم التحويل»: المبلغ | رقم الإيصال
  bot.on('message:text', async (ctx, next) => {
    const id = awaitingPay.get(ctx.from.id);
    if (!id || !isAdmin(ctx.from.id) || ctx.message.text.startsWith('/')) return next();
    const [amount, receipt] = ctx.message.text.split('|').map((s) => s.trim());
    try {
      const r = fin.markPaid(id, amount, receipt, ctx.from.id);
      awaitingPay.delete(ctx.from.id);
      await ctx.reply(`✅ تم تسجيل تحويل طلب #${r.id}: ${fmt(r.paid_amount)} د.ع — إيصال ${r.receipt_ref}\nتم إشعار العضو ونشر السحب.`);
      await afterPaid(r);
    } catch (e) {
      await ctx.reply(`${e.userFacing ? e.message : 'خطأ'}\nأعد الإرسال بالشكل: المبلغ | رقم الإيصال  (أو /cancel)`);
    }
  });

  bot.notifyTask = async (s, task, user) => {
    const text = `تسليم مهمة #${s.id} — «${task.title}» (${fmt(task.reward)} د.ع)\n${user.first_name || ''} (@${user.username || '—'}) · ID ${user.id}\n\nالإثبات:\n${s.proof_text || '—'}`;
    const kb = new InlineKeyboard().text('قبول', `task_ok_${s.id}`).text('رفض', `task_no_${s.id}`);
    await toAdmins((chat) => s.proof_path
      ? bot.api.sendDocument(chat, new InputFile(s.proof_path), { caption: text.slice(0, 1000), reply_markup: kb })
      : bot.api.sendMessage(chat, text, { reply_markup: kb }));
  };

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));
  return bot;
}

module.exports = { createBot, marketingText, referralLink };
