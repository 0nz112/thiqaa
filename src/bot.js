const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
const { db, upsertUser, audit, maskName } = require('./db');
const fin = require('./finance');
const { decrypt } = require('./security');
const imp = require('./importPayouts');

const fmt = (n) => Number(n).toLocaleString('en-US');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const dbAdmins = () => db.prepare('SELECT id FROM admins').all().map((r) => r.id);
const allAdmins = () => [...new Set([...ADMIN_IDS, ...dbAdmins()])];
const isAdmin = (id) => allAdmins().includes(Number(id));

function referralLink(userId) {
  return `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
}

// النص التسويقي الذي يُرسل مع رابط الإحالة — بدون وعود بأرباح مضمونة
function marketingText(userId) {
  return [
    'أدعوك لتجربة منصة «ثقة» 🟢',
    '',
    '• مهام رقمية مدفوعة من جهات عمل حقيقية — لا تحتاج أي إيداع.',
    '• فرص استثمار في مشاريع معلنة بتفاصيلها ومخاطرها.',
    '• محفظة واضحة تعرض مصدر كل مبلغ، مع سحب إلى زين كاش أو كي كارد.',
    '',
    `سجّل من هنا: ${referralLink(userId)}`,
    '',
    'تنبيه: الاستثمار ينطوي على مخاطر، والعوائد تعتمد على الأداء الفعلي للمشاريع.',
  ].join('\n');
}

function createBot() {
  const bot = new Bot(process.env.BOT_TOKEN);
  const ADMIN_CHAT = process.env.ADMIN_CHAT_ID;

  // يرسل للمجموعة إن وُجدت، وإلا لكل مشرف في محادثته الخاصة
  const toAdmins = async (send) => {
    const targets = ADMIN_CHAT ? [ADMIN_CHAT] : allAdmins();
    for (const t of targets) await send(t).catch((e) => console.error('notify admin', e.message));
  };

  // رمز لمرة واحدة يظهر في نافذة التشغيل لتعيين أول مشرف
  bot.adminCode = null;
  if (!allAdmins().length) bot.adminCode = String(Math.floor(100000 + Math.random() * 900000));

  bot.command('admin', async (ctx) => {
    if (!bot.adminCode || (ctx.match || '').trim() !== bot.adminCode) return;
    upsertUser(ctx.from);
    db.prepare('INSERT OR IGNORE INTO admins (id) VALUES (?)').run(ctx.from.id);
    audit({ actor: ctx.from.id, action: 'admin_claimed', target: ctx.from.id });
    bot.adminCode = null;
    console.log(`✔ تم تعيين ${ctx.from.first_name} مشرفاً`);
    await ctx.reply('أصبحت مشرف البوت ✅\nستصلك هنا طلبات الإيداع والسحب والمهام للموافقة عليها.\nأرسل /stats لرؤية الإحصائيات.');
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
      bot.api.sendMessage(referrerId,
        `انضم ${ctx.from.first_name || 'مستخدم جديد'} إلى المنصة عبر رابط الإحالة الخاص بك.`).catch(() => {});
    }

    await ctx.reply(
      `أهلاً ${ctx.from.first_name || ''} في منصة «ثقة» 👋\n\n` +
      'من هنا تدير محفظتك، تنفّذ مهام مدفوعة، وتتابع استثماراتك بوضوح.\n\n' +
      'شارك المنصة مع أصدقائك: اضغط «مشاركة رابط الإحالة» ثم اختر المحادثات التي تريد إرسال الدعوة إليها.',
      { reply_markup: mainKeyboard() }
    );

    const user = db.prepare('SELECT phone FROM users WHERE id=?').get(ctx.from.id);
    if (!user.phone) {
      await ctx.reply('لتفعيل السحب، وثّق رقم هاتفك بضغطة واحدة:', {
        reply_markup: new Keyboard().requestContact('مشاركة رقم الهاتف').resized().oneTime(),
      });
    }
  });

  // توثيق الهاتف — نقبل فقط رقم صاحب الحساب نفسه
  bot.on('message:contact', async (ctx) => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply('يرجى مشاركة رقم هاتفك أنت عبر الزر.');
    upsertUser(ctx.from);
    const before = db.prepare('SELECT phone, kyc_level FROM users WHERE id=?').get(ctx.from.id);
    db.prepare('UPDATE users SET phone=?, kyc_level=MAX(kyc_level,1) WHERE id=?').run(c.phone_number, ctx.from.id);
    audit({ actor: ctx.from.id, action: 'phone_verified', target: ctx.from.id, before, after: { phone: 'verified' } });
    await ctx.reply('تم توثيق رقم هاتفك ✅', { reply_markup: { remove_keyboard: true } });
  });

  bot.callbackQuery('my_ref', async (ctx) => {
    await ctx.answerCallbackQuery();
    const count = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(ctx.from.id).c;
    await ctx.reply(`رابط الإحالة الخاص بك:\n${referralLink(ctx.from.id)}\n\nعدد المسجلين عبر رابطك: ${count}`,
      { reply_markup: new InlineKeyboard().switchInline('مشاركة مع جهات الاتصال', '') });
  });

  // ---------------- مشاركة الإحالة (Inline mode) ----------------
  // يجب تفعيل Inline Mode من @BotFather عبر /setinline
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

  // ---------------- قرارات المشرفين ----------------
  const decide = (pattern, handler) => bot.callbackQuery(pattern, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'غير مصرح', show_alert: true });
    try {
      const msg = await handler(ctx, Number(ctx.match[1]));
      await ctx.answerCallbackQuery({ text: 'تم' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`${msg} — بواسطة ${ctx.from.first_name}`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: e.userFacing ? e.message : 'حدث خطأ', show_alert: true });
    }
  });

  decide(/^dep_ok_(\d+)$/, async (ctx, id) => {
    const r = fin.approveDeposit(id, ctx.from.id);
    bot.api.sendMessage(r.user_id, `تم قبول إيداعك بمبلغ ${fmt(r.amount)} د.ع وإضافته إلى رصيدك.\nرقم العملية: ${r.ref}`).catch(() => {});
    return `✅ إيداع #${id} مقبول`;
  });
  decide(/^dep_no_(\d+)$/, async (ctx, id) => {
    const r = fin.rejectDeposit(id, ctx.from.id);
    bot.api.sendMessage(r.user_id, `تم رفض طلب الإيداع #${id}. تحقق من إثبات الدفع أو تواصل مع الدعم.`).catch(() => {});
    return `❌ إيداع #${id} مرفوض`;
  });
  decide(/^wd_ok_(\d+)$/, async (ctx, id) => {
    const r = fin.approveWithdraw(id, ctx.from.id);
    bot.api.sendMessage(r.user_id, `تم تنفيذ طلب السحب #${id}. المبلغ الصافي: ${fmt(r.net)} د.ع\nرقم العملية: ${r.ref}`).catch(() => {});
    const u = db.prepare('SELECT first_name, last_name, hide_in_feed FROM users WHERE id=?').get(r.user_id);
    const m = db.prepare('SELECT type FROM payout_methods WHERE id=?').get(r.payout_method_id);
    bot.publishPayouts([{ name: u.hide_in_feed ? 'عضو' : maskName(u.first_name, u.last_name), amount: r.net, method: m?.type, at: new Date().toISOString().slice(0, 19).replace('T', ' ') }], 'سحب منفّذ');
    return `✅ سحب #${id} منفّذ`;
  });
  decide(/^wd_no_(\d+)$/, async (ctx, id) => {
    const r = fin.rejectWithdraw(id, ctx.from.id);
    bot.api.sendMessage(r.user_id, `تم رفض طلب السحب #${id} وإعادة ${fmt(r.amount)} د.ع إلى رصيدك المتاح.`).catch(() => {});
    return `❌ سحب #${id} مرفوض`;
  });
  decide(/^task_ok_(\d+)$/, async (ctx, id) => {
    const s = fin.acceptTask(id, ctx.from.id);
    bot.api.sendMessage(s.user_id, `تم قبول مهمة «${s.title}» وإضافة مكافأة ${fmt(s.reward)} د.ع إلى رصيدك.`).catch(() => {});
    return `✅ مهمة (تسليم #${id}) مقبولة`;
  });
  decide(/^task_no_(\d+)$/, async (ctx, id) => {
    const s = fin.rejectTask(id, ctx.from.id);
    bot.api.sendMessage(s.user_id, `لم تُقبل مهمة «${s.title}». راجع المتطلبات وأعد المحاولة إن كانت المقاعد متاحة.`).catch(() => {});
    return `❌ مهمة (تسليم #${id}) مرفوضة`;
  });

  // ---------------- أوامر المشرفين ----------------
  const admin = (name, fn) => bot.command(name, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try { await fn(ctx, (ctx.match || '').trim()); }
    catch (e) { await ctx.reply(e.userFacing ? e.message : `خطأ: ${e.message}`); }
  });

  admin('stats', async (ctx) => {
    const q = (sql) => db.prepare(sql).get();
    const users = q('SELECT COUNT(*) c FROM users').c;
    const b = q('SELECT SUM(available) a, SUM(pending) p, SUM(invested) i FROM balances');
    const dep = q("SELECT COUNT(*) c FROM deposit_requests WHERE status='pending'").c;
    const wd = q("SELECT COUNT(*) c FROM withdraw_requests WHERE status='pending'").c;
    const tr = q("SELECT COUNT(*) c FROM task_submissions WHERE status='review'").c;
    await ctx.reply(
      `المستخدمون: ${users}\nالأرصدة المتاحة: ${fmt(b.a || 0)}\nسحوبات معلقة: ${fmt(b.p || 0)}\n` +
      `الأموال المستثمرة: ${fmt(b.i || 0)}\n\nطلبات إيداع بانتظار المراجعة: ${dep}\nطلبات سحب: ${wd}\nمهام للمراجعة: ${tr}`);
  });

  // /addtask العنوان | الجهة | المكافأة | المقاعد | الساعات | الوصف | المتطلبات | الإثبات المطلوب
  admin('addtask', async (ctx, arg) => {
    const [title, client, reward, seats, hours, description, requirements, proof] = arg.split('|').map((s) => s?.trim());
    if (!title || !reward || !description) return ctx.reply('الصيغة: /addtask العنوان | الجهة | المكافأة | المقاعد | الساعات | الوصف | المتطلبات | الإثبات');
    const r = db.prepare(`INSERT INTO tasks (title, client, reward, seats, duration_hours, description, requirements, proof_required)
      VALUES (?,?,?,?,?,?,?,?)`).run(title, client, Number(reward), Number(seats) || 10, Number(hours) || 24, description, requirements, proof);
    audit({ actor: ctx.from.id, action: 'task_created', after: { id: r.lastInsertRowid, title, reward } });
    await ctx.reply(`تمت إضافة المهمة #${r.lastInsertRowid}`);
  });

  // /addproject الاسم | النوع | القطاع | رأس المال | المدة بالأيام | المخاطر | طريقة احتساب العائد | الوصف | نموذج العمل | المخاطر التفصيلية
  admin('addproject', async (ctx, arg) => {
    const [name, type, sector, capital, days, risk, method, description, model, risks] = arg.split('|').map((s) => s?.trim());
    if (!name || !capital || !days || !method) return ctx.reply('الصيغة: /addproject الاسم | النوع | القطاع | رأس المال | الأيام | المخاطر | طريقة الاحتساب | الوصف | نموذج العمل | المخاطر التفصيلية');
    const r = db.prepare(`INSERT INTO projects (name, type, sector, capital_required, duration_days, risk_level, return_method, description, business_model, risks)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, type, sector, Number(capital), Number(days), risk || 'متوسطة', method, description, model, risks);
    audit({ actor: ctx.from.id, action: 'project_created', after: { id: r.lastInsertRowid, name } });
    await ctx.reply(`تمت إضافة المشروع #${r.lastInsertRowid} بحالة «قيد الدراسة». غيّرها بـ /pstatus ${r.lastInsertRowid} open`);
  });

  // /pstatus 3 open|active|closed
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

  // /settle 3 4.5  → تسوية المشروع بعائد صافٍ +4.5% (أو سالب للخسارة) بعد التدقيق
  admin('settle', async (ctx, arg) => {
    const [id, pct] = arg.split(/\s+/).map(Number);
    if (!id || !Number.isFinite(pct)) return ctx.reply('الصيغة: /settle رقم_المشروع النسبة (مثال: /settle 3 4.5 أو /settle 3 -2)');
    const { project, results } = fin.settleProject(id, pct, ctx.from.id);
    for (const r of results) {
      const word = r.pnl >= 0 ? `ربح ${fmt(r.pnl)}` : `خسارة ${fmt(-r.pnl)}`;
      bot.api.sendMessage(r.userId, `تمت تسوية مشروع «${project.name}».\nالمبلغ المستثمر: ${fmt(r.amount)} د.ع\nالنتيجة: ${word} د.ع\nأُضيف ${fmt(r.result)} د.ع إلى رصيدك المتاح.`).catch(() => {});
    }
    await ctx.reply(`تمت تسوية المشروع #${id} لعدد ${results.length} مستثمر بنسبة ${pct}%`);
  });

  admin('freeze', async (ctx, arg) => {
    const id = Number(arg);
    db.prepare("UPDATE users SET status='frozen' WHERE id=?").run(id);
    audit({ actor: ctx.from.id, action: 'user_frozen', target: id });
    await ctx.reply(`تم تجميد الحساب ${id}`);
  });
  admin('unfreeze', async (ctx, arg) => {
    const id = Number(arg);
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(id);
    audit({ actor: ctx.from.id, action: 'user_unfrozen', target: id });
    await ctx.reply(`تم تفعيل الحساب ${id}`);
  });
  // /kyc userId 2  → بعد مراجعة وثائق الهوية يدوياً
  admin('kyc', async (ctx, arg) => {
    const [id, level] = arg.split(/\s+/).map(Number);
    const before = db.prepare('SELECT kyc_level FROM users WHERE id=?').get(id);
    db.prepare('UPDATE users SET kyc_level=? WHERE id=?').run(level, id);
    audit({ actor: ctx.from.id, action: 'kyc_level', target: id, before, after: { kyc_level: level } });
    await ctx.reply(`مستوى التحقق للمستخدم ${id}: ${level}`);
    bot.api.sendMessage(id, level >= 2 ? 'تم توثيق هويتك ✅ يمكنك الآن الاستثمار.' : 'تم تحديث مستوى التحقق لحسابك.').catch(() => {});
  });

  // ---------- سحوبات المنصة الأخرى ----------
  const SOURCE = () => process.env.EXTERNAL_SOURCE_NAME || 'المنصة السابقة';

  // سحب نُفّذ الآن على المنصة الأخرى: /extpayout الاسم | المبلغ | الطريقة | رقم_الإيصال
  admin('extpayout', async (ctx, arg) => {
    const [name, amount, method, receipt] = arg.split('|').map((x) => x?.trim());
    if (!name || !amount || !method || !receipt) return ctx.reply('الصيغة: /extpayout الاسم | المبلغ | zaincash أو qicard | رقم_الإيصال');
    try {
      const row = imp.insertOne({ name, amount, method, receipt, paidAt: imp.nowSql() }, ctx.from.id, SOURCE());
      await ctx.reply(`تم تسجيل السحب #${row.id} (عبر ${SOURCE()})`);
      bot.publishPayouts([row], `سحب منفّذ — ${SOURCE()}`);
    } catch (e) { await ctx.reply(`لم يُسجَّل: ${e.message}`); }
  });

  // استيراد ملف CSV لسحوبات سابقة: أرسل الملف مع التعليق /import_payouts
  bot.on('message:document', async (ctx, next) => {
    const cap = ctx.message.caption || '';
    if (!cap.startsWith('/import_payouts')) return next();
    if (!isAdmin(ctx.from.id)) return;
    const doc = ctx.message.document;
    if (!/\.csv$/i.test(doc.file_name || '') || doc.file_size > 2 * 1024 * 1024) return ctx.reply('أرسل ملف CSV أقل من 2MB');
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
    const r = imp.importCsv(await res.text(), ctx.from.id, SOURCE());
    const today = new Date().toLocaleDateString('ar-IQ', { timeZone: 'Asia/Baghdad', day: 'numeric', month: 'long', year: 'numeric' });
    await bot.publishPayouts(r.rows, `سحوبات الأعضاء المنفّذة — ${SOURCE()}\nتاريخ النشر: ${today}`);
    const errs = r.errors.slice(0, 25).join('\n');
    await ctx.reply(`تم استيراد ${r.imported} سحب من «${SOURCE()}».` + (r.errors.length ? `\n\nمرفوض ${r.errors.length}:\n${errs}${r.errors.length > 25 ? '\n…' : ''}` : ''));
  });

  // ---------- نشر السحوبات المنفّذة في قناة (اختياري: PAYOUTS_CHANNEL_ID) ----------
  const METHOD_AR = { zaincash: 'زين كاش', qicard: 'كي كارد', bank: 'تحويل مصرفي', other: '' };
  const timeBaghdad = (sql) => {
    const d = new Date(sql.replace(' ', 'T') + 'Z');
    return d.toLocaleString('ar-IQ', { timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  };
  const line = (r) => `• ${r.name} — ${fmt(r.amount)} د.ع${METHOD_AR[r.method] ? ' عبر ' + METHOD_AR[r.method] : ''} — ${timeBaghdad(r.at)}`;

  bot.publishPayouts = async (rows, title) => {
    const ch = process.env.PAYOUTS_CHANNEL_ID;
    if (!ch || !rows.length) return;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const total = sorted.reduce((s, r) => s + r.amount, 0);
    const chunks = [];
    let cur = `${title}\n\n`;
    for (const r of sorted) {
      const l = line(r) + '\n';
      if ((cur + l).length > 3800) { chunks.push(cur); cur = ''; }
      cur += l;
    }
    cur += `\nالعدد: ${sorted.length} · المجموع: ${fmt(total)} د.ع`;
    chunks.push(cur);
    for (const c of chunks) await bot.api.sendMessage(ch, c).catch((e) => console.error('publishPayouts', e.message));
  };

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));

  // ---------------- إشعارات المشرفين (يستدعيها الخادم) ----------------
  const userLabel = (u) => `${u.first_name || ''} ${u.last_name || ''} (@${u.username || '—'}) · ID ${u.id}`;

  bot.notifyDeposit = async (req, user) => {
    const text = `طلب إيداع #${req.id}\n${userLabel(user)}\nالطريقة: ${req.method}\nالمبلغ: ${fmt(req.amount)} د.ع\nرقم العملية الخارجي: ${req.external_ref || '—'}`;
    const kb = new InlineKeyboard().text('قبول', `dep_ok_${req.id}`).text('رفض', `dep_no_${req.id}`);
    await toAdmins((chat) => req.proof_path
      ? bot.api.sendPhoto(chat, new InputFile(req.proof_path), { caption: text, reply_markup: kb })
      : bot.api.sendMessage(chat, text, { reply_markup: kb }));
  };

  bot.notifyWithdraw = async (w, user) => {
    const m = w.method;
    const dest = m.type === 'zaincash'
      ? `زين كاش: ${decrypt(m.phone_enc)}`
      : `كي كارد: ${decrypt(m.card_enc)}`;
    const text = `طلب سحب #${w.id}\n${userLabel(user)}\nالمبلغ: ${fmt(w.amount)} · الرسوم: ${fmt(w.fee)} · الصافي: ${fmt(w.net)} د.ع\n` +
      `صاحب الحساب: ${m.holder_name}\n${dest}\nالعنوان: ${decrypt(m.address_enc) || '—'}`;
    await toAdmins((chat) => bot.api.sendMessage(chat, text, {
      reply_markup: new InlineKeyboard().text('تم التحويل', `wd_ok_${w.id}`).text('رفض', `wd_no_${w.id}`),
    }));
  };

  bot.notifyTask = async (s, task, user) => {
    const text = `تسليم مهمة #${s.id} — «${task.title}» (${fmt(task.reward)} د.ع)\n${userLabel(user)}\n\nالإثبات:\n${s.proof_text || '—'}`;
    const kb = new InlineKeyboard().text('قبول', `task_ok_${s.id}`).text('رفض', `task_no_${s.id}`);
    await toAdmins((chat) => s.proof_path
      ? bot.api.sendDocument(chat, new InputFile(s.proof_path), { caption: text.slice(0, 1000), reply_markup: kb })
      : bot.api.sendMessage(chat, text, { reply_markup: kb }));
  };

  return bot;
}

module.exports = { createBot, marketingText, referralLink };
