import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { initDb, createOrder, getOrder, setReceipt, reviewOrder, markDelivered } from './db.js';
import { PLANS, findPlan, toman } from './plans.js';

const required = ['BOT_TOKEN', 'ADMIN_ID', 'DATABASE_URL', 'CARD_NUMBER', 'CARD_HOLDER'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const adminId = Number(process.env.ADMIN_ID);
if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new Error('ADMIN_ID must be a valid Telegram user ID');

const bot = new Telegraf(process.env.BOT_TOKEN);
const awaitingReceipt = new Map();
const awaitingDelivery = new Map();

const planKeyboard = () => Markup.inlineKeyboard(
  PLANS.map((plan) => [Markup.button.callback(`${plan.title} — ${toman(plan.price)}`, `plan:${plan.id}`)])
);
const deliveryKeyboard = (orderId) => Markup.inlineKeyboard([
  [Markup.button.callback('📦 تحویل اشتراک', `deliver:${orderId}`)]
]);
const isAdmin = (ctx) => ctx.from?.id === adminId;
const orderText = (order, plan) => `سفارش #${order.id}\nپلن: ${plan.title}\nحجم: ${plan.volume}\nمدت: ${plan.duration}\nمبلغ: ${toman(plan.price)}`;

bot.start(async (ctx) => {
  await ctx.reply('سلام 👋\nبرای خرید اشتراک، پلن موردنظر را انتخاب کنید.', planKeyboard());
});

bot.command('plans', async (ctx) => ctx.reply('پلن‌های فعال:', planKeyboard()));
bot.command('support', async (ctx) => ctx.reply(`پشتیبانی: ${process.env.SUPPORT_USERNAME || 'با مدیر تماس بگیرید.'}`));

bot.action(/^plan:(.+)$/, async (ctx) => {
  const plan = findPlan(ctx.match[1]);
  if (!plan) return ctx.answerCbQuery('پلن معتبر نیست.');

  const order = await createOrder({
    telegramId: ctx.from.id,
    username: ctx.from.username,
    firstName: ctx.from.first_name,
    planId: plan.id
  });
  awaitingReceipt.set(ctx.from.id, order.id);

  await ctx.answerCbQuery();
  await ctx.reply(
    `${orderText(order, plan)}\n\nمبلغ را به کارت زیر واریز کنید:\n\`${process.env.CARD_NUMBER}\`\nبه نام: ${process.env.CARD_HOLDER}\n\nسپس تصویر یا فایل رسید را همین‌جا ارسال کنید.`,
    { parse_mode: 'Markdown' }
  );
});

async function acceptReceipt(ctx, fileId, type) {
  const orderId = awaitingReceipt.get(ctx.from.id);
  if (!orderId) return ctx.reply('ابتدا یک پلن را از /plans انتخاب کنید.');

  const order = await setReceipt(orderId, fileId, type);
  awaitingReceipt.delete(ctx.from.id);
  if (!order) return ctx.reply('این سفارش دیگر برای دریافت رسید فعال نیست.');

  const plan = findPlan(order.plan_id);
  const user = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'بدون نام کاربری');
  const caption = `رسید جدید برای ${orderText(order, plan)}\nکاربر: ${user}\nشناسه: ${order.telegram_id}`;
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('✅ تأیید پرداخت', `approve:${order.id}`), Markup.button.callback('❌ رد پرداخت', `reject:${order.id}`)]
  ]);

  if (type === 'photo') await bot.telegram.sendPhoto(adminId, fileId, { caption, ...buttons });
  else await bot.telegram.sendDocument(adminId, fileId, { caption, ...buttons });
  await ctx.reply('رسید دریافت شد و برای بررسی مدیر ارسال شد. پس از تأیید، اشتراک برایتان فرستاده می‌شود.');
}

async function deliverPendingMessage(ctx) {
  const orderId = awaitingDelivery.get(ctx.from.id);
  if (!isAdmin(ctx) || !orderId) return false;

  const order = await getOrder(orderId);
  if (!order || order.status !== 'approved') {
    awaitingDelivery.delete(adminId);
    await ctx.reply('این سفارش دیگر آمادهٔ تحویل نیست.');
    return true;
  }

  await bot.telegram.copyMessage(order.telegram_id, ctx.chat.id, ctx.message.message_id);
  const delivered = await markDelivered(order.id);
  if (!delivered) {
    await ctx.reply('وضعیت سفارش تغییر کرده است؛ تحویل دوباره بررسی شود.');
    return true;
  }

  awaitingDelivery.delete(adminId);
  await ctx.reply(`اشتراک سفارش #${order.id} برای کاربر ارسال شد.`);
  return true;
}

bot.on('message', async (ctx, next) => {
  if (await deliverPendingMessage(ctx)) return;
  return next();
});

bot.on('photo', (ctx) => acceptReceipt(ctx, ctx.message.photo.at(-1).file_id, 'photo'));
bot.on('document', async (ctx) => {
  const document = ctx.message.document;
  if (!['image/jpeg', 'image/png', 'application/pdf'].includes(document.mime_type)) {
    return ctx.reply('فقط تصویر JPG/PNG یا فایل PDF رسید را ارسال کنید.');
  }
  if (document.file_size > 10 * 1024 * 1024) return ctx.reply('حجم فایل رسید باید کمتر از ۱۰ مگابایت باشد.');
  return acceptReceipt(ctx, document.file_id, 'document');
});

bot.action(/^(approve|reject):(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('اجازه دسترسی ندارید.', { show_alert: true });

  const status = ctx.match[1] === 'approve' ? 'approved' : 'rejected';
  const order = await reviewOrder(Number(ctx.match[2]), status);
  if (!order) return ctx.answerCbQuery('سفارش قبلاً بررسی شده یا وجود ندارد.');

  await ctx.answerCbQuery(status === 'approved' ? 'پرداخت تأیید شد.' : 'پرداخت رد شد.');
  if (status === 'approved') await ctx.editMessageReplyMarkup(deliveryKeyboard(order.id).reply_markup);
  else await ctx.editMessageReplyMarkup(undefined);

  await bot.telegram.sendMessage(
    order.telegram_id,
    status === 'approved'
      ? `پرداخت سفارش #${order.id} تأیید شد ✅\nمدیر به‌زودی اشتراک را از طریق همین ربات ارسال می‌کند.`
      : `پرداخت سفارش #${order.id} تأیید نشد ❌\nبرای پیگیری از /support استفاده کنید.`
  );
});

bot.action(/^deliver:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('اجازه دسترسی ندارید.', { show_alert: true });

  const order = await getOrder(Number(ctx.match[1]));
  if (!order || order.status !== 'approved') {
    return ctx.answerCbQuery('ابتدا باید پرداخت تأیید شود.', { show_alert: true });
  }

  awaitingDelivery.set(adminId, order.id);
  await ctx.answerCbQuery();
  await ctx.reply('متن، فایل یا کانفیگ اشتراک را در پیام بعدی ارسال کنید؛ همان محتوا برای خریدار فرستاده می‌شود.');
});

bot.catch((error, ctx) => console.error(`Update ${ctx.update.update_id} failed`, error));
await initDb();
await bot.launch({ dropPendingUpdates: false });
console.log('Bot is running');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
