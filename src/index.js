const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const envPath = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });

const line = '─'.repeat(52);
const say = (...a) => console.log(...a);

if (!process.env.BOT_TOKEN || !/^\d+:[\w-]{30,}$/.test(process.env.BOT_TOKEN)) {
  say(`\n${line}\n  ضع توكن البوت في ملف .env في سطر:\n  BOT_TOKEN=التوكن\n${line}\n`);
  process.exit(1);
}

// مكان البيانات (قاعدة البيانات، الإثباتات، مفتاح التشفير)
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  say('⚠ لم تُضف Volume في Railway: قاعدة البيانات ستُحذف مع كل تحديث. أضف Volume على المسار /app/data');
}

// مفتاح التشفير: من المتغيرات إن وُجد، وإلا يُنشأ مرة واحدة ويُحفظ مع البيانات
if (!/^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '')) {
  const keyFile = path.join(dataDir, '.encryption_key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    say('✔ تم إنشاء مفتاح التشفير وحفظه مع البيانات');
  }
  process.env.ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
}

const { createBot } = require('./bot');
const { createServer } = require('./server');

// رابط HTTPS مؤقت تلقائي عبر Cloudflare إذا لم يُحدد WEBAPP_URL
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    say('… تجهيز رابط HTTPS للمنصة (قد يستغرق دقيقة في المرة الأولى)');
    const p = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${port}`],
      { shell: process.platform === 'win32' });
    const timer = setTimeout(() => reject(new Error('تعذّر إنشاء الرابط خلال 90 ثانية')), 90000);
    const onData = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (c) => { clearTimeout(timer); reject(new Error('توقف cloudflared، رمز ' + c)); });
    process.on('exit', () => p.kill());
  });
}

(async () => {
  const port = Number(process.env.PORT || 3000);
  const bot = createBot();
  const status = { version: '3.1', server: 'ok', telegram: 'connecting', error: null, bot: null, webapp: null, port };

  // الخادم يبدأ أولاً حتى يعمل الرابط حتى لو فشل الاتصال بتيليغرام
  const app = createServer(bot, status);
  await new Promise((r) => app.listen(port, '0.0.0.0', r));
  say(`✔ الخادم يعمل على المنفذ ${port}`);

  try {
    await bot.init();
  } catch (e) {
    status.telegram = 'failed';
    status.error = e.error_code === 401 ? 'التوكن غير صحيح أو تم إلغاؤه — حدّث BOT_TOKEN' : (e.description || e.message);
    say('✖ تعذّر الاتصال بتيليغرام:', status.error);
    return; // نُبقي الخادم يعمل لتظهر حالة الخطأ على /health
  }
  if (!process.env.BOT_USERNAME) process.env.BOT_USERNAME = bot.botInfo.username;
  status.bot = '@' + bot.botInfo.username;

  if (!process.env.WEBAPP_URL && process.env.RAILWAY_PUBLIC_DOMAIN) {
    process.env.WEBAPP_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.WEBAPP_URL) {
    status.telegram = 'failed';
    status.error = 'لا يوجد رابط: أنشئه من Settings ← Networking ← Generate Domain ثم Redeploy';
    say('✖', status.error);
    return;
  }
  if (!process.env.WEBAPP_URL || !process.env.WEBAPP_URL.startsWith('https://') || process.env.WEBAPP_URL.includes('ضع')) {
    try {
      process.env.WEBAPP_URL = await startTunnel(port);
    } catch (e) {
      say(`\n✖ ${e.message}\n  تأكد من اتصال الإنترنت ثم أعد التشغيل.\n`);
      process.exit(1);
    }
  }

  await bot.api.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'المنصة', web_app: { url: process.env.WEBAPP_URL } },
  }).catch((e) => say('تنبيه زر القائمة:', e.message));
  await bot.api.setMyCommands([{ command: 'start', description: 'القائمة الرئيسية ورابط الإحالة' }]).catch(() => {});

  // إيقاف هادئ عند إعادة النشر حتى تستلم النسخة الجديدة فوراً
  const shutdown = async (sig) => {
    say(`… إيقاف البوت (${sig})`);
    try { await bot.stop(); } catch (e) {}
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  // إذا كانت نسخة أخرى تعمل بنفس التوكن (409) ننتظر ونعيد المحاولة بدل التوقف
  (async function runPolling(attempt = 1) {
    try {
      await bot.start({ drop_pending_updates: false });
    } catch (e) {
      if (e.error_code === 409) {
        const wait = Math.min(30, 5 * attempt);
        say(`⚠ توجد نسخة أخرى من البوت تعمل بنفس التوكن. إعادة المحاولة بعد ${wait} ثانية…`);
        if (attempt === 3) say('  إذا استمرت الرسالة: أغلق البوت على جهازك، وتأكد أن Replicas = 1 في Railway.');
        setTimeout(() => runPolling(attempt + 1), wait * 1000);
      } else {
        say('✖ خطأ في الاتصال بتيليغرام:', e.description || e.message);
        setTimeout(() => runPolling(attempt + 1), 10000);
      }
    }
  })();

  status.telegram = 'ok';
  status.webapp = process.env.WEBAPP_URL;
  say(`\n${line}`);
  say(`  ✔ البوت يعمل:  https://t.me/${process.env.BOT_USERNAME}`);
  say(`  ✔ رابط المنصة: ${process.env.WEBAPP_URL}`);
  if (bot.adminCode) {
    say('');
    say('  لتصبح مشرف البوت، أرسل له هذه الرسالة:');
    say(`      /admin ${bot.adminCode}`);
  }
  say('');
  if (!process.env.RAILWAY_ENVIRONMENT) say('  اترك هذه النافذة مفتوحة؛ إغلاقها يوقف البوت.');
  say(`${line}\n`);
})().catch((e) => {
  say('\n✖ خطأ:', e.description || e.message);
  if (e.error_code === 401) say('  التوكن غير صحيح أو تم إلغاؤه. انسخه من جديد من @BotFather.');
  process.exit(1);
});
