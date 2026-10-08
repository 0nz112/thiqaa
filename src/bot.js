const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { db, upsertUser, audit, publicName, ACCOUNT_TYPES } = require('./db');
const fin = require('./finance');
const { decrypt } = require('./security');

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const ENV_ADMINS = (process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
const allAdmins = () => [...new Set([...ENV_ADMINS, ...db.prepare('SELECT id FROM admins').all().map((r) => r.id)])];
const isAdmin = (id) => allAdmins().includes(Number(id));

const referralLink = (userId) => `https://t.me/${process.env.BOT_USERNAME}?start=ref_${userId}`;
const supportLink = () => (process.env.SUPPORT_USERNAME ? `https://t.me/${process.env.SUPPORT_USERNAME.replace('@', '').trim()}` : null);

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
  bot.isAdmin = isAdmin;
  bot.allAdmins = allAdmins;

  const webapp = (hash = '') => `${process.env.WEBAPP_URL}/${hash ? '#' + hash : ''}`;

  // إرسال للمشرفين: مجموعة إن وُجدت، وإلا الخاص، مع زر يفتح لوحة الإدارة
  const toAdmins = async (text, hash) => {
    const targets = ADMIN_CHAT ? [ADMIN_CHAT] : allAdmins();
    for (const chat of targets) {
      const kb = new InlineKeyboard();
      if (hash) ADMIN_CHAT ? kb.url('فتح لوحة الإدارة', webapp(hash)) : kb.webApp('فتح لوحة الإدارة', webapp(hash));
      await bot.api.sendMessage(chat, text, { reply_markup: kb }).catch((e) => console.error('notify admin:', e.message));
    }
  };
  bot.toAdmins = toAdmins;

  // رمز لمرة واحدة يظهر في السجلات لتعيين أول مشرف
  bot.adminCode = allAdmins().length ? null : String(Math.floor(100000 + Math.random() * 900000));
  bot.command('admin', async (ctx) => {
    if (!bot.adminCode || (ctx.match || '').trim() !== bot.adminCode) return;
    upsertUser(ctx.from);
    db.prepare('INSERT OR IGNORE INTO admins (id) VALUES (?)').run(ctx.from.id);
    audit({ actor: ctx.from.id, action: 'admin_claimed', target: ctx.from.id });
    bot.adminCode = null;
    await ctx.reply('أصبحت مشرف البوت ✅\nكل الإدارة تتم بالأزرار من «لوحة الإدارة».',
      { reply_markup: new InlineKeyboard().webApp('فتح لوحة الإدارة', webapp('/admin')) });
  });

  const mainKeyboard = (userId) => {
    const kb = new InlineKeyboard().webApp('فتح المنصة', webapp()).row();
    if (supportLink()) kb.url('التواصل مع الدعم', supportLink()).row();
    kb.switchInline('مشاركة رابط الإحالة مع جهات اتصالك', '').row();
    kb.text('رابط الإحالة الخاص بي', 'my_ref');
    if (isAdmin(userId)) kb.row().webApp('لوحة الإدارة', webapp('/admin'));
    return kb;
  };

  bot.command('start', async (ctx) => {
    const payload = ctx.match || '';
    const refId = payload.startsWith('ref_') ? Number(payload.slice(4)) : null;
    const { created, referrerId } = upsertUser(ctx.from, refId);
    if (created && referrerId) {
      bot.api.sendMessage(referrerId, `انضم ${ctx.from.first_name || 'عضو جديد'} إلى المنصة عبر رابط الإحالة الخاص بك.`).catch(() => {});
    }
    await ctx.reply(
      `أهلاً ${ctx.from.first_name || ''} في منصة «ثقة» 👋\n\n` +
      'من «فتح المنصة» تتابع رصيدك وأرباحك واستثماراتك، وتجد أزرار الإيداع وسحب الأرباح التي توصلك بفريق الدعم مباشرة.',
      { reply_markup: mainKeyboard(ctx.from.id) }
    );
  });

  bot.callbackQuery('my_ref', async (ctx) => {
    await ctx.answerCallbackQuery();
    const count = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(ctx.from.id).c;
    await ctx.reply(`رابط الإحالة الخاص بك:\n${referralLink(ctx.from.id)}\n\nعدد المسجلين عبر رابطك: ${count}`,
      { reply_markup: new InlineKeyboard().switchInline('مشاركة مع جهات الاتصال', '') });
  });

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

  // ---------------- إشعارات ----------------
  const KIND = { profit: 'سحب أرباح', liquidation: 'تصفية الحساب' };

  bot.notifyWithdrawal = async (r, u) => {
    const text = [
      `🔔 طلب ${KIND[r.kind]} #${r.id}`,
      `${u.full_name || u.first_name || ''} · ID ${u.id}`,
      `الحساب: ${ACCOUNT_TYPES[u.account_type] || '—'} ${decrypt(u.account_enc) || ''}`,
      `الهاتف: ${decrypt(u.phone_enc) || '—'}`,
      r.kind === 'profit' ? `المبلغ: ${fmt(r.requested_amount)} د.ع` : `تصفية كاملة — المحجوز: ${fmt(r.held_amount)} د.ع`,
      r.note ? `ملاحظة: ${r.note}` : '',
    ].filter(Boolean).join('\n');
    await toAdmins(text, '/admin/requests');
  };

  bot.notifyTask = async (s, task, user) => {
    const text = `📝 تسليم مهمة «${task.title}» (${fmt(task.reward)} د.ع)\n${user.full_name || user.first_name || ''} · ID ${user.id}\n\n${s.proof_text || ''}`.slice(0, 1000);
    const targets = ADMIN_CHAT ? [ADMIN_CHAT] : allAdmins();
    for (const chat of targets) {
      const kb = new InlineKeyboard().text('قبول', `task_ok_${s.id}`).text('رفض', `task_no_${s.id}`);
      const send = s.proof_path
        ? bot.api.sendDocument(chat, new InputFile(s.proof_path), { caption: text, reply_markup: kb })
        : bot.api.sendMessage(chat, text, { reply_markup: kb });
      await send.catch((e) => console.error('notifyTask:', e.message));
    }
  };

  bot.afterTask = (s, ok) => bot.api.sendMessage(s.user_id, ok
    ? `تم قبول مهمة «${s.title}» وإضافة مكافأة ${fmt(s.reward)} د.ع إلى رصيدك.`
    : `لم تُقبل مهمة «${s.title}». راجع المتطلبات وحاول في مهمة أخرى.`).catch(() => {});

  // قبول/رفض المهام بزر مباشرة من الإشعار
  const decide = (pattern, handler) => bot.callbackQuery(pattern, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'غير مصرح', show_alert: true });
    try {
      const msg = handler(ctx.from.id, Number(ctx.match[1]));
      await ctx.answerCallbackQuery({ text: 'تم' });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`${msg} — بواسطة ${ctx.from.first_name}`);
    } catch (e) { await ctx.answerCallbackQuery({ text: e.userFacing ? e.message : 'حدث خطأ', show_alert: true }); }
  });
  decide(/^task_ok_(\d+)$/, (adminId, id) => { bot.afterTask(fin.acceptTask(id, adminId), true); return '✅ مهمة مقبولة'; });
  decide(/^task_no_(\d+)$/, (adminId, id) => { bot.afterTask(fin.rejectTask(id, adminId), false); return '❌ مهمة مرفوضة'; });

  bot.notifyUser = (userId, text, hash = '/wallet') => bot.api.sendMessage(userId, text,
    { reply_markup: new InlineKeyboard().webApp('فتح المنصة', webapp(hash)) }).catch(() => {});

  bot.afterPaid = async (r) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id);
    bot.notifyUser(r.user_id, `تم تنفيذ طلب ${KIND[r.kind]} #${r.id} ✅\nالمبلغ المحوّل: ${fmt(r.paid_amount)} د.ع\nإلى: ${ACCOUNT_TYPES[u.account_type] || ''} ${u.account_masked || ''}\nرقم الإيصال: ${r.receipt_ref}`);
    await bot.publishPayouts([{ name: publicName(u), amount: r.paid_amount, method: u.account_type, at: r.paid_at }], 'سحب منفّذ');
  };

  // نشر السحوبات في قناة (اختياري)
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

  // إعلان لكل الأعضاء النشطين (عند نشر مشروع أو مهمة) بمعدل آمن
  bot.broadcast = async (text, hash) => {
    const ids = db.prepare("SELECT id FROM users WHERE status='active'").all().map((r) => r.id);
    let sent = 0;
    for (const id of ids) {
      await bot.api.sendMessage(id, text, { reply_markup: new InlineKeyboard().webApp('عرض في المنصة', webapp(hash)) })
        .then(() => sent++).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
    }
    return sent;
  };

  bot.catch((err) => console.error('Bot error:', err.error?.message || err));
  return bot;
}

module.exports = { createBot, marketingText, referralLink, supportLink };
