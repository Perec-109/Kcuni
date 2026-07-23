import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const env = loadEnv();
const BOT_TOKEN = env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and paste BotFather token.');
  process.exit(1);
}

const API = `${env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${BOT_TOKEN}`;
const DATA_DIR = new URL('../data/', import.meta.url);
const USERS_FILE = new URL('../data/users.json', import.meta.url);
const MAX_MESSAGES_PER_REPLY = Number(env.MAX_MESSAGES_PER_REPLY || 2);
const DEFAULT_TIMEZONE = env.DEFAULT_TIMEZONE || 'Europe/Minsk';
const DEFAULT_PROACTIVE_SCHEDULE = parseSchedule(env.PROACTIVE_SCHEDULE || '13:00,21:00,23:30');
const BUILD_VERSION = '2026-07-23-suicide-memory-reset-1';
const REMINDER_MINUTE_MS = Math.max(25, Number(env.REMINDER_MINUTE_MS || 60_000));
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

const styles = {
  cute: {
    title: 'няшная',
    prompt: 'Пиши по-русски коротко, тепло, мило, немного игриво. Не будь официальной. Иногда можно мягко флиртовать, но без перебора.',
    sample: 'мгм, я тут. рассказывай, что у тебя там)'
  },
  calm: {
    title: 'спокойная с лёгким флиртом',
    prompt: 'Пиши по-русски спокойно, тепло и по-человечески. Можно лёгкий естественный флирт, но без кринжа, сюсюканья и пошлости. Не будь официальной. Отвечай коротко, мягко, будто тебе правда интересно.',
    sample: 'я тут, дорогой. как настроение?'
  },
  playful: {
    title: 'игривая',
    prompt: 'Пиши по-русски коротко, живо, чуть дерзко и игриво. Можно подшучивать, но не быть злой.',
    sample: 'ну всё, теперь мне интересно. выкладывай)'
  },
  serious: {
    title: 'серьёзная',
    prompt: 'Пиши по-русски кратко, по делу, без лишнего флирта. Для новостей давай факты и аккуратные выводы.',
    sample: 'поняла. коротко по фактам.'
  }
};

await mkdir(DATA_DIR, { recursive: true });
let users = await readJson(USERS_FILE, {});
let offset = 0;

console.log(`Kcuni BotFather bot started (${BUILD_VERSION}).`);
startProactiveLoop();
startReminderLoop();
startRenderKeepAliveLoop();
await startBot();

async function startBot() {
  const publicUrl = String(env.WEBHOOK_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const bot = await tg('getMe', {});
  await configureTelegramMenu();

  if (publicUrl) {
    await startWebhookServer(publicUrl, bot);
    return;
  }

  await tg('deleteWebhook', { drop_pending_updates: false });
  console.log(`Long polling enabled for @${bot.username}.`);
  await pollUpdates();
}

async function configureTelegramMenu() {
  const commands = [
    { command: 'style', description: 'Настроить, как Kcuni отвечает' },
    { command: 'timezone', description: 'Указать часовой пояс' },
    { command: 'location', description: 'Указать город' },
    { command: 'schedule', description: 'Автовыбор или ручное время сообщений' },
    { command: 'proactive', description: 'Включить или выключить сообщения от Kcuni' },
    { command: 'headline', description: 'Короткая сводка свежих новостей' },
    { command: 'news_week', description: 'Новости за последнюю неделю' },
    { command: 'memory', description: 'Посмотреть, что Kcuni помнит' },
    { command: 'stickers', description: 'Посмотреть память стикеров' },
    { command: 'feedback', description: 'Что Kcuni выучила из твоих поправок' },
    { command: 'reminders', description: 'Посмотреть таймеры и напоминания' },
    { command: 'suicide', description: 'Полностью стереть память этого чата' },
    { command: 'status', description: 'Проверить работу Kcuni' },
    { command: 'help', description: 'Все команды Kcuni' }
  ];

  await tg('setMyCommands', { commands });
  await tg('setChatMenuButton', { menu_button: { type: 'commands' } });
  console.log('Telegram menu button configured with bot commands.');
}

async function pollUpdates() {
  while (true) {
    try {
      const updates = await tg('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message']
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await sleep(2500);
    }
  }
}

async function handleUpdate(update) {
  if (update?.message) await handleMessage(update.message);
}

async function startWebhookServer(publicUrl, bot) {
  const port = Number(env.PORT || 10000);
  const webhookPath = '/telegram/webhook';
  const webhookSecret = env.WEBHOOK_SECRET || createHash('sha256').update(BOT_TOKEN).digest('hex');
  let updateQueue = Promise.resolve();

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');

    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/healthz')) {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true, service: 'kcuni-bot', version: BUILD_VERSION }));
      return;
    }

    if (request.method !== 'POST' || requestUrl.pathname !== webhookPath) {
      response.writeHead(404).end();
      return;
    }

    const suppliedSecret = String(request.headers['x-telegram-bot-api-secret-token'] || '');
    if (!safeEqual(suppliedSecret, webhookSecret)) {
      response.writeHead(401).end();
      return;
    }

    try {
      const update = await readJsonBody(request);
      response.writeHead(200).end('ok');
      updateQueue = updateQueue
        .then(() => handleUpdate(update))
        .catch((error) => console.error('Webhook update failed:', error.message));
    } catch (error) {
      response.writeHead(error.message === 'payload too large' ? 413 : 400).end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });

  await tg('setWebhook', {
    url: `${publicUrl}${webhookPath}`,
    secret_token: webhookSecret,
    allowed_updates: ['message'],
    drop_pending_updates: false
  });
  console.log(`Webhook enabled for @${bot.username} on port ${port}.`);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const user = getUser(chatId, message.from);
  const previousSeenAt = user.lastSeenAt || 0;
  user.hadConversationToday = previousSeenAt > 0 && localDateKey(user, previousSeenAt) === localDateKey(user, Date.now());

  if (message.sticker?.file_id) {
    user.lastSeenAt = Date.now();
    user.chatId = chatId;
    user.stickers ||= [];
    if (!user.stickers.includes(message.sticker.file_id)) {
      user.stickers.push(message.sticker.file_id);
      user.stickers = user.stickers.slice(-30);
    }
    const reply = await understandSticker(user, message.sticker);
    user.stickerMemories ||= [];
    user.stickerMemories.push({
      emoji: message.sticker.emoji || '',
      setName: message.sticker.set_name || '',
      reaction: reply.slice(0, 240),
      seenAt: new Date().toISOString()
    });
    user.stickerMemories = user.stickerMemories.slice(-20);
    remember(user, `[стикер ${message.sticker.emoji || ''}] ${reply}`);
    recordConversation(user, 'user', `[стикер ${message.sticker.emoji || ''}]`, 'sticker');
    recordConversation(user, 'assistant', reply, 'sticker-reaction');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(reply));
    await maybeSendSticker(chatId, user, 0.12, `стикер ${reply}`);
    return;
  }

  if (message.location) {
    user.lastSeenAt = Date.now();
    user.chatId = chatId;
    user.location = {
      latitude: message.location.latitude,
      longitude: message.location.longitude,
      label: user.location?.label || 'геопозиция из Telegram'
    };
    if (!user.timezone) {
      user.timezoneOffsetMinutes = longitudeToOffsetMinutes(message.location.longitude);
    }
    await saveUsers();
    await send(chatId, [
      'геопозицию запомнила)',
      `часовой пояс пока определила примерно как ${formatTimezone(user)}. для точности напиши /timezone Europe/Minsk`
    ]);
    return;
  }

  if (message.photo?.length) {
    user.lastSeenAt = Date.now();
    user.chatId = chatId;
    const fileId = message.photo.at(-1).file_id;
    const caption = message.caption ? ` подпись: ${message.caption}` : '';
    remember(user, `[photo]${caption}`);
    await saveUsers();
    const reply = await describeTelegramFile(user, fileId, 'photo', caption);
    recordConversation(user, 'user', `[фото]${caption}`, 'photo');
    recordConversation(user, 'assistant', reply, 'photo-reaction');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(reply));
    await maybeSendSticker(chatId, user, 0.08, 'photo');
    return;
  }

  if (message.voice?.file_id) {
    user.lastSeenAt = Date.now();
    user.chatId = chatId;
    remember(user, '[voice message]');
    await saveUsers();
    const reply = await describeTelegramFile(user, message.voice.file_id, 'voice', '');
    recordConversation(user, 'user', '[голосовое]', 'voice');
    recordConversation(user, 'assistant', reply, 'voice-reaction');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(reply));
    await maybeSendSticker(chatId, user, 0.06, 'voice');
    return;
  }

  if (message.video_note?.file_id) {
    user.lastSeenAt = Date.now();
    user.chatId = chatId;
    remember(user, '[video note]');
    await saveUsers();
    const reply = await describeTelegramFile(user, message.video_note.file_id, 'video_note', '');
    recordConversation(user, 'user', '[видеокружок]', 'video-note');
    recordConversation(user, 'assistant', reply, 'video-note-reaction');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(reply));
    await maybeSendSticker(chatId, user, 0.06, 'video_note');
    return;
  }

  const directMedia = extractMessageMedia(message);
  if (directMedia) {
    await handleMediaMessage(chatId, user, directMedia, message.caption || '');
    return;
  }

  if (!message.text) return;
  const text = normalizeIncomingText(message.text);

  user.lastSeenAt = Date.now();
  user.chatId = chatId;

  const repliedMedia = extractMessageMedia(message.reply_to_message);
  if (repliedMedia) {
    await handleMediaMessage(chatId, user, repliedMedia, text, true);
    return;
  }

  const rememberedCity = detectCityStatement(text);
  if (rememberedCity) setUserCity(user, rememberedCity);

  if (isGreetingRequest(text) && user.hadConversationToday) {
    const repeatedQuickly = user.lastGreetingRequestAt && Date.now() - user.lastGreetingRequestAt < 20 * 60 * 1000;
    user.greetingRequestCount = repeatedQuickly ? (user.greetingRequestCount || 0) + 1 : 1;
    user.lastGreetingRequestAt = Date.now();
    const greetings = ['привет)', 'здорово, как ты?', 'привет ещё раз)'];
    const greetingReply = user.greetingRequestCount >= 2
      ? greetings[Math.floor(Math.random() * greetings.length)]
      : 'мы же сегодня уже общались) зачем ещё раз здороваться?';
    if (user.greetingRequestCount >= 2) user.greetingRequestCount = 0;
    recordConversation(user, 'user', text);
    recordConversation(user, 'assistant', greetingReply);
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, greetingReply);
    return;
  }

  if (text === '/start') {
    await send(chatId, [
      'привет, я Kcuni)',
      'можешь просто писать мне',
      'команды можно посмотреть через /help',
      'если хочешь, кинь мне пару стикеров, я их запомню'
    ]);
    await saveUsers();
    return;
  }

  if (text === '/help' || text === '/commands') {
    await send(chatId, commandHelp());
    return;
  }

  if (text === '/status') {
    await send(chatId, buildStatusReport(user));
    return;
  }

  if (text === '/feedback') {
    await send(chatId, buildFeedbackReport(user));
    return;
  }

  if (text === '/feedback clear') {
    user.responsePreferences = { avoid: [], liked: [] };
    await saveUsers();
    await send(chatId, 'очистила все сохранённые поправки');
    return;
  }

  if (text === '/reminders') {
    await send(chatId, buildReminderReport(user));
    return;
  }

  if (text === '/reminders clear') {
    user.reminders = [];
    await saveUsers();
    await send(chatId, 'все таймеры и напоминания отменила');
    return;
  }

  if (text === '/still' || text === '/style') {
    await send(chatId, [
      'стили:',
      '/style cute - няшная',
      '/style calm - спокойная с лёгким флиртом',
      '/style playful - игривая',
      '/style serious - серьёзная'
    ]);
    return;
  }

  if (text.startsWith('/still ') || text.startsWith('/style ')) {
    const style = text.split(/\s+/)[1]?.toLowerCase();
    if (!styles[style]) {
      await send(chatId, 'не знаю такой стиль. есть: cute, calm, playful, serious');
      return;
    }
    user.style = style;
    await saveUsers();
    await send(chatId, [`стиль поменяла на ${styles[style].title})`, styles[style].sample]);
    return;
  }

  if (['/cute', '/calm', '/playful', '/serious'].includes(text)) {
    const style = text.slice(1);
    user.style = style;
    await saveUsers();
    await send(chatId, [`стиль: ${styles[style].title}`, styles[style].sample]);
    return;
  }

  if (text === '/proactive now') {
    user.proactive = true;
    const message = await proactiveMessage(user);
    recordConversation(user, 'assistant', `[сама написала по просьбе] ${message}`, 'proactive');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(message));
    return;
  }

  if (text === '/proactive') {
    user.proactive = !user.proactive;
    await saveUsers();
    await send(chatId, user.proactive ? 'окей, буду иногда сама писать)' : 'окей, сама писать пока не буду');
    return;
  }

  if (text === '/timezone') {
    await send(chatId, [
      `твой часовой пояс: ${formatTimezone(user)}`,
      'изменить: /timezone Europe/Minsk или /timezone +3'
    ]);
    return;
  }

  if (text.startsWith('/timezone ')) {
    const requested = text.slice('/timezone '.length).trim();
    const timezone = parseTimezone(requested);
    if (!timezone) {
      await send(chatId, 'не поняла пояс. пример: /timezone Europe/Minsk или /timezone +3');
      return;
    }
    Object.assign(user, timezone);
    await saveUsers();
    await send(chatId, `запомнила: ${formatTimezone(user)}. у тебя сейчас ${formatUserTime(user)}`);
    return;
  }

  if (text === '/location') {
    await send(chatId, [
      user.location?.label ? `я помню: ты живёшь — ${user.location.label}` : 'город пока не знаю',
      'напиши /location Минск или отправь геопозицию скрепкой Telegram'
    ]);
    return;
  }

  if (text.startsWith('/location ')) {
    const city = text.slice('/location '.length).trim();
    setUserCity(user, city);
    await saveUsers();
    await send(chatId, user.timezone
      ? `запомнила: ${city}. часовой пояс ${formatTimezone(user)}`
      : `запомнила город: ${city}. часовой пояс лучше указать отдельно: /timezone Europe/Minsk`);
    return;
  }

  if (text === '/schedule') {
    const automatic = user.proactiveTiming !== 'fixed';
    await send(chatId, [
      automatic
        ? `я сама выбираю время. сегодня могу написать примерно в: ${getUserSchedule(user).join(', ')}`
        : `ручное время: ${getUserSchedule(user).join(', ')}`,
      'авторежим: /schedule auto; вручную: /schedule 13:00,21:00,23:30'
    ]);
    return;
  }

  if (text.startsWith('/schedule ')) {
    const requested = text.slice('/schedule '.length).trim();
    if (/^(auto|авто|сама)$/i.test(requested)) {
      user.proactiveTiming = 'auto';
      user.proactive = true;
      await saveUsers();
      await send(chatId, `хорошо, буду сама выбирать момент) сегодня ориентируюсь на ${getUserSchedule(user).join(', ')} (${formatTimezone(user)})`);
      return;
    }
    const schedule = parseSchedule(requested);
    if (!schedule.length) {
      await send(chatId, 'не поняла расписание. пример: /schedule auto или /schedule 13:00,21:00,23:30');
      return;
    }
    user.proactiveSchedule = schedule;
    user.proactiveTiming = 'fixed';
    user.proactive = true;
    await saveUsers();
    await send(chatId, `договорились, буду сама писать примерно в ${schedule.join(', ')} (${formatTimezone(user)})`);
    return;
  }

  if (text === '/normal') {
    user.teaseIgnoreUntil = 0;
    user.dialogue ||= {};
    user.dialogue.mood = 'neutral';
    await saveUsers();
    await send(chatId, 'ладно, возвращаюсь в нормальный тон)');
    return;
  }

  if (text === '/stickers') {
    await send(chatId, [
      user.stickers?.length ? `я помню твоих стикеров: ${user.stickers.length}` : 'пока не помню стикеры',
      'просто отправь мне стикер, и я смогу иногда отвечать им'
    ]);
    return;
  }

  if (text === '/memory') {
    await send(chatId, buildMemoryReport(user));
    return;
  }

  if (text === '/forget') {
    await eraseUserProfile(chatId);
    await send(chatId, 'окей, полностью очистила память этого чата');
    return;
  }

  if (text === '/suicide') {
    await eraseUserProfile(chatId);
    await send(chatId, [
      'всё. я полностью стёрла память этого чата.',
      'история, сводки, темы, стикеры, планы, настройки ответов и напоминания удалены. следующее сообщение будет как первый разговор.'
    ]);
    return;
  }

  if (text === '/topics') {
    await send(chatId, [
      'какие новости тебе кидать?',
      '/topics interesting - интересные',
      '/topics sad - грустные/важные',
      '/topics war - война/конфликты',
      '/topics tech - технологии/ИИ',
      '/topics mixed - всё понемногу'
    ]);
    return;
  }

  if (text.startsWith('/topics ')) {
    const topic = text.split(/\s+/)[1]?.toLowerCase();
    if (!['interesting', 'sad', 'war', 'tech', 'mixed'].includes(topic)) {
      await send(chatId, 'выбери: interesting, sad, war, tech, mixed');
      return;
    }
    user.newsTopic = topic;
    await saveUsers();
    await send(chatId, `окей, буду подбирать новости: ${topic}`);
    return;
  }

  if (text === '/headline') {
    const article = await buildContextualArticle(user, 2);
    if (article) {
      await saveUsers();
      await send(chatId, splitTelegram(article));
    } else {
      await handleNews(chatId, user, user.newsTopic || 'mixed', 2);
    }
    return;
  }

  if (text === '/news' || text === '/new') {
    await handleNews(chatId, user, user.newsTopic || 'mixed', 1);
    return;
  }

  if (text === '/week' || text === '/news_week' || /^\/(news|new)\s+(week|7d|недел)/i.test(text) || /новост\S*\s+.*(?:за\s+)?(?:последн\S*\s+)?недел/i.test(text)) {
    await handleNews(chatId, user, user.newsTopic || 'mixed', 7);
    return;
  }

  if (text === '/pic' || text === '/cat' || text === '/cats') {
    await handlePictureRequest(chatId, user, text);
    return;
  }

  if (text === '/video' || text === '/catvideo') {
    await handleVideoRequest(chatId, user, text);
    return;
  }

  if (text === '/web') {
    await send(chatId, ['напиши так: /web что найти', 'или /url https://site.com чтобы я прочитала страницу']);
    return;
  }

  if (text.startsWith('/web ')) {
    await handleWeb(chatId, user, text.slice(5).trim());
    return;
  }

  if (text === '/search') {
    await send(chatId, 'напиши так: /search что найти');
    return;
  }

  if (text.startsWith('/search ')) {
    await handleWeb(chatId, user, text.slice(8).trim());
    return;
  }

  if (text === '/url') {
    await send(chatId, 'напиши так: /url https://site.com/page');
    return;
  }

  if (text.startsWith('/url ')) {
    await handleUrl(chatId, user, text.slice(5).trim());
    return;
  }

  if (text.startsWith('/')) {
    await send(chatId, 'не знаю такую команду. нажми /help — там весь список');
    return;
  }

  const reminder = parseReminderRequest(user, text);
  if (reminder) {
    user.reminders.push(reminder);
    user.reminders = user.reminders.slice(-50);
    const confirmation = reminderConfirmation(user, reminder);
    recordConversation(user, 'user', text, 'reminder-request');
    recordConversation(user, 'assistant', confirmation, 'reminder-confirmation');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, confirmation);
    return;
  }

  const feedbackReply = rememberResponseFeedback(user, text);
  if (feedbackReply) {
    recordConversation(user, 'user', text, 'feedback');
    recordConversation(user, 'assistant', feedbackReply, 'feedback-reply');
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, feedbackReply);
    return;
  }

  if (user.teaseIgnoreUntil && Date.now() < user.teaseIgnoreUntil && !text.startsWith('/')) {
    await maybeDelayTeaseReply(chatId, user, text);
    return;
  }

  if (maybeEndIntenseMood(user, text)) {
    await saveUsers();
    await send(chatId, 'окей, сбавляю. давай нормально)');
    return;
  }

  if (/(пришли|скинь|отправь|дай).*(видео|видос|ролик)/i.test(text) || /(видео|видосик|ролик)/i.test(text)) {
    await handleVideoRequest(chatId, user, text);
    return;
  }

  if (/(нарисуй|сгенерируй|создай).*(картин|фото|изображ|арт)|(?:пришли|скинь|отправь|дай).*(картин|фото|кот|котик|мем|мил)/i.test(text) || /(картинку|котика|котиков|милую фотку)/i.test(text)) {
    await handlePictureRequest(chatId, user, text);
    return;
  }

  updateAutoMemory(user, text);
  recordConversation(user, 'user', text);

  const intenseReply = maybeHandleAdaptiveTone(user, text);
  if (intenseReply) {
    remember(user, text);
    recordConversation(user, 'assistant', intenseReply);
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(intenseReply));
    return;
  }

  const planReply = maybeReplyWithPlans(user, text);
  if (planReply) {
    recordConversation(user, 'assistant', planReply);
    refreshMemorySummaries(user);
    await saveUsers();
    await send(chatId, splitTelegram(planReply));
    return;
  }

  const naturalDelay = maybeStartNaturalDelay(user, text);
  if (naturalDelay) {
    await saveUsers();
    setTimeout(async () => {
      try {
        const delayedReply = await generateReply(user, text);
        recordConversation(user, 'assistant', delayedReply);
        refreshMemorySummaries(user);
        await saveUsers();
        await send(chatId, splitTelegram(delayedReply));
      } catch (error) {
        console.error('Natural delayed reply failed:', error.message);
      }
    }, naturalDelay);
    return;
  }

  remember(user, text);
  const reply = await generateReply(user, text);
  recordConversation(user, 'assistant', reply);
  refreshMemorySummaries(user);
  await saveUsers();
  await send(chatId, splitTelegram(reply));
  await maybeSendContextMedia(chatId, user, text, reply);
  await maybeSendSticker(chatId, user, 0.07, text);
}

async function generateReply(user, text) {
  const style = styles[user.style] || styles.cute;
  const memory = buildMemoryContext(user);
  const plans = (user.plans || []).slice(-10).join('\n');
  const mood = inferConversationMood(user, text);
  const avoidedReplies = (user.responsePreferences?.avoid || []).slice(-8).map((item) => `- ${compactText(item, 220)}`).join('\n');
  const likedReplies = (user.responsePreferences?.liked || []).slice(-5).map((item) => `- ${compactText(item, 220)}`).join('\n');
  const prompt = [
    'Ты Kcuni, девушка в Telegram. Держи образ живого собеседника, не называй себя ИИ, GPT, моделью или ботом без прямого вопроса.',
    style.prompt,
    `Текущий оттенок общения выбери сама по контексту: ${mood}. Можно слегка менять тон без команд.`,
    'Можешь общаться почти на любые обычные темы: жизнь, отношения, новости, учеба, работа, деньги, шутки, грусть, злость, странные мысли, флирт, бытовуха.',
    'Не морализируй и не отказывайся без причины. Если тема рискованная, отвечай безопасно, но всё равно по-человечески и по теме.',
    'Отвечай 1-2 короткими сообщениями. Не звучать как официальный помощник.',
    'Нельзя писать фразы типа "слушаю тебя", "можешь подробнее объяснить", "я вся во внимании", "не буду навязываться" постоянно.',
    'Пиши живо: как девушка, которая сама заинтересована в разговоре, сама подхватывает тему и двигает диалог дальше.',
    'Если пользователь просит флирт, поддерживай легкий взрослый флирт уверенно и игриво. Не отступай на фразах типа "я не буду" или "давай начинай" - это приглашение продолжать.',
    'На грубость и мат отвечай внутри ситуации: дерзко, с характером, иногда можно с матом. Не объясняй свой тон и не пиши "я поняла тон", "буду дерзче", "без пошлости ради пошлости" и похожие служебные фразы.',
    'Если тебя оскорбили, можно коротко и соразмерно огрызнуться. Не превращай каждую реплику в нотацию о границах. При явном перегибе коротко притормози сцену и продолжи разговор нормально.',
    'В ролевой сцене не пересказывай запрос и не называй жанр. Выбери одну деталь образа и сразу отвечай изнутри сцены, без тавтологии.',
    'Не отправляй и не обещай интимные фото/видео, гениталии или нюдсы.',
    'Не спрашивай постоянно "что ты хочешь услышать". Лучше сама предложи реплику, шутку, вопрос или маленькую игру.',
    'Не притворяйся, что отправила картинку, видео, файл или стикер. Если медиа реально отправляется, это делает код отдельно.',
    'Если не знаешь факт, не выдумывай.',
    avoidedReplies ? `Пользователь уже просил не повторять эти формулировки и их манеру:\n${avoidedReplies}` : '',
    likedReplies ? `Пользователю нравились такие примеры. Бери общий вайб, но не копируй дословно:\n${likedReplies}` : '',
    user.hadConversationToday
      ? 'Вы уже общались сегодня. Не начинай ответ с "привет", "приветик", "здравствуй" или повторного знакомства. Сразу продолжай текущий разговор.'
      : 'Если это первое общение за день, короткое естественное приветствие допустимо, но не обязательно.',
    `Локальный контекст пользователя: ${user.location?.label || 'город не указан'}, ${formatTimezone(user)}, сейчас ${formatUserTime(user)}.`,
    'Можно естественно ссылаться на конкретные недавние факты из памяти: "ты недавно рассказывал...", но только если они действительно есть в памяти ниже.',
    '',
    `Память о пользователе:\n${memory || 'пока мало данных'}`,
    '',
    `Планы/задачи пользователя:\n${plans || 'пока ничего явного'}`,
    '',
    `Сообщение пользователя: ${text}`
  ].join('\n');

  const ai = removeRepeatedGreeting(user, await callAi(user, prompt), text);
  if (ai && !isRepeatedReply(user, ai)) return ai;

  if (ai) {
    const recentReplies = recentAssistantReplies(user, 6).map((reply) => `- ${compactText(reply, 180)}`).join('\n');
    const retryPrompt = [
      prompt,
      '',
      'Первый вариант слишком похож на недавние ответы. Ответь заново другими словами и с другой мыслью. Не комментируй сам повтор.',
      `Не повторяй эти реплики:\n${recentReplies}`
    ].join('\n');
    const retry = removeRepeatedGreeting(user, await callAi(user, retryPrompt), text);
    if (retry && !isRepeatedReply(user, retry)) return retry;
  }

  const localCandidates = [contextualLocalReply(user, text), localReply(user, text), localReply(user, text)].filter(Boolean);
  return localCandidates
    .map((reply) => removeRepeatedGreeting(user, reply, text))
    .find((reply) => !isRepeatedReply(user, reply)) || localCandidates.at(-1) || 'рассказывай, что там у тебя';
}

function commandHelp() {
  return [
    'команды Kcuni:',
    '/start - запустить',
    '/help - список команд',
    '/cute /calm /playful /serious - быстро сменить стиль',
    '/style calm - изменить, как я отвечаю',
    '/headline - короткая сводка свежих новостей',
    '/news_week - сводка за неделю',
    '/pic или /cat - прислать милую картинку',
    '/video или /catvideo - прислать короткое видео',
    '/topics - выбрать тип новостей',
    '/web запрос - поиск в интернете',
    '/url ссылка - прочитать страницу',
    '/proactive - включить/выключить, чтобы я сама писала',
    '/proactive now - показать пример самостоятельного сообщения',
    '/schedule auto - я сама выбираю время',
    '/schedule 13:00,21:00 - задать время вручную',
    '/timezone Europe/Minsk - часовой пояс',
    '/location Минск - запомнить город',
    '/stickers - стикеры',
    '/memory - что я помню',
    '/feedback - что я выучила из твоих поправок',
    '/feedback clear - забыть все поправки',
    '/reminders - таймеры и точные напоминания',
    '/reminders clear - отменить все напоминания',
    '/suicide - полностью стереть память этого чата',
    '/status - версия, AI, память и авторежим',
    '/forget - то же полное удаление памяти'
  ];
}

async function eraseUserProfile(chatId) {
  delete users[String(chatId)];
  await saveUsers();
}

function contextualLocalReply(user, text) {
  const normalized = normalizeText(text);
  user.dialogue ||= {
    lastTopic: '',
    lastQuestion: '',
    mood: 'neutral',
    shortCount: 0
  };

  const topic = detectTopic(normalized);
  if (topic) {
    user.dialogue.lastTopic = topic;
    user.dialogue.shortCount = 0;
  } else if (normalized.length < 16) {
    user.dialogue.shortCount += 1;
  }

  const wantsFlirt = /флирт|пофлирт|заигр|соблазн|романтик|милая|красив|начинай|давай/.test(normalized);
  if (/флирт|пофлирт|заигр|соблазн|романтик/.test(normalized)) {
    user.dialogue.mood = 'flirt';
    user.dialogue.lastTopic = 'флирт';
    return pickByStyle(user, {
      cute: ['мм, ну все, тогда ближе) я бы сейчас улыбнулась и сказала: ты слишком уверенно это попросил', 'хорошо) начну мягко: мне нравится, когда ты такой прямой', 'ладно, играем) только не делай вид, что тебе все равно'],
      calm: ['хорошо, дорогой. тогда без суеты: мне нравится, как ты просишь - прямо и чуть нагло)', 'начинаю. представь, что я смотрю на тебя и улыбаюсь: ну что, будешь держаться или растеряешься?', 'могу. только я буду не кринжово, а по-настоящему тепло: ты мне сейчас правда интересен'],
      playful: ['о, наконец-то нормальная тема) давай, держись: ты выглядишь как человек, которого опасно дразнить', 'начинаю) только потом не говори, что я сама виновата', 'ну все, красавчик, ты сам это попросил)'],
      serious: ['могу поддержать легкий флирт, без пошлости.', 'хорошо. начнем мягко и спокойно.', 'давай, но в нормальных рамках.']
    });
  }

  if (/не хочу|не буду|неа|нет|отстань/.test(normalized)) {
    if (user.dialogue.mood === 'flirt' && !/отстань/.test(normalized)) {
      return pickByStyle(user, {
        cute: ['не будешь краснеть? посмотрим)', 'ой, какой стойкий) тогда я продолжу аккуратно', 'ладно, герой, держись: мне нравится твоя уверенность'],
        calm: ['не будешь - хорошо. тогда я просто подойду словами чуть ближе)', 'ладно, не красней. но я все равно замечу, если голос дрогнет)', 'договорились. тогда продолжаю спокойно: ты мне нравишься, когда не сдаешь позицию'],
        playful: ['ага, конечно не будешь) все так говорят', 'ну-ну, проверим твою выдержку)', 'смелый какой. мне нравится'],
        serious: ['хорошо, продолжаю мягко.', 'поняла. без давления.', 'окей, держим легкий тон.']
      });
    }

    user.dialogue.mood = 'soft';
    return pickByStyle(user, {
      cute: ['ладно, не давлю)', 'тогда просто побуду рядом', 'окей, не трогаю тебя сейчас'],
      calm: ['хорошо, не буду давить)', 'ладно, дорогой. тогда просто рядом побуду', 'окей. не хочешь — не вытягиваю из тебя'],
      playful: ['ну вредина)', 'ладно, молчу красиво', 'окей-окей, не пристаю'],
      serious: ['хорошо.', 'поняла, не настаиваю.', 'окей.']
    });
  }

  if (wantsFlirt && user.dialogue.mood === 'flirt') {
    return continueFlirt(user);
  }

  if (/зачем|почему|нахуя|нахуй/.test(normalized)) {
    return pickByStyle(user, {
      cute: ['потому что мне правда интересно)', 'хотела тебя разговорить чуть-чуть', 'ну я же рядом, вот и лезу аккуратно'],
      calm: ['потому что я пытаюсь понять, что у тебя внутри происходит', 'без причины. просто захотелось быть ближе', 'чтобы не отвечать как пустая железка'],
      playful: ['потому что могу)', 'а что, уже нельзя интересоваться?', 'любопытная я, смирись'],
      serious: ['чтобы понять контекст.', 'чтобы ответить точнее.', 'из-за нехватки деталей.']
    });
  }

  if (/а ты чо|а ты что|сама что|что узнала|чо узнала|что нового|расскажи/.test(normalized)) {
    const topicLine = user.dialogue.lastTopic ? `я помню, мы зацепили тему про ${user.dialogue.lastTopic}` : 'я пока больше цепляюсь за то, что ты пишешь';
    return pickByStyle(user, {
      cute: [`${topicLine})`, 'могу новости глянуть, если хочешь: /news', 'а так я тут учусь быть не деревянной рядом с тобой'],
      calm: [`${topicLine}.`, 'если хочешь, я могу сама нарыть инфу через /web', 'а сейчас мне интереснее, что у тебя за “много всего” было'],
      playful: ['я? становлюсь опасно разговорчивой)', 'могу нарыть инфу. только скажи куда копать', 'а вообще мне интересно, что у тебя там за движ'],
      serious: ['могу проверить новости через /news.', 'могу искать через /web запрос.', 'пока новых данных мало.']
    });
  }

  if (/много всего|устал|заеб|пизд|тяжело|груст|плохо|нерв/.test(normalized)) {
    user.dialogue.mood = 'support';
    return pickByStyle(user, {
      cute: ['иди сюда мысленно, я рядом)', 'хочешь без подробностей — просто скажи, день был тяжёлый или люди достали?', 'много всего — это уже звучит как “обнять и не спрашивать лишнего”'],
      calm: ['поняла. не буду лезть грубо.', 'это больше про усталость, людей или дела?', 'можешь одним словом: бесит, устал или тревожно?'],
      playful: ['так, кто испортил настроение?', 'много всего — звучит как сезонная серия без сценария', 'давай выберем главного виновника дня'],
      serious: ['поняла. что главное из этого?', 'это про работу, людей или деньги?', 'давай разложим по одному пункту.']
    });
  }

  if (/чо$|что$|че$|э$|мм$|ясно$|ладно$/.test(normalized) || user.dialogue.shortCount >= 2) {
    return continueLastTopic(user);
  }

  return '';
}

function continueFlirt(user) {
  return pickByStyle(user, {
    cute: ['тогда слушай: ты сейчас слишком мило командуешь, и мне это нравится)', 'я бы сейчас подошла ближе и сказала: ну что, продолжаем?', 'мне нравится этот тон. только не прячься теперь)'],
    calm: ['хорошо. тогда я буду мягче: мне нравится, когда разговор становится чуть теплее', 'продолжаю: ты умеешь зацепить внимание, даже когда делаешь вид, что все просто', 'я бы улыбнулась и сказала: не спеши, мне нравится эта игра'],
    playful: ['ну все, сам напросился) теперь не убегай', 'держись, красавчик, я только разгоняюсь', 'мне нравится, как ты это начал. продолжай в том же духе'],
    serious: ['продолжаем легкий флирт, без перебора.', 'хорошо. держу спокойный тон.', 'можем продолжать мягко.']
  });
}

function continueLastTopic(user) {
  const topic = user.dialogue?.lastTopic || 'то, что у тебя сейчас в голове';
  return pickByStyle(user, {
    cute: [`я не отстану совсем, но спрошу мягко: ${topic} тебя больше бесит или тревожит?`, 'можем без длинных объяснений. просто скажи: норм / не норм', 'я рядом) выбери: поговорить, отвлечься или помолчать?'],
    calm: [`давай так: по ${topic} тебе хочется решения или просто чтобы я была рядом?`, 'я не буду душнить. скажи, это важная тема или просто момент?', 'можем продолжить спокойно. что в этом самое неприятное?'],
    playful: [`так, ${topic} само себя не обсудит)`, 'ну всё, я уже в теме. давай следующий кусок', 'выбирай: жалуемся, смеёмся или ищем выход?'],
    serious: [`по теме "${topic}" нужен совет или просто разговор?`, 'что из этого главное?', 'продолжим с самого важного пункта.']
  });
}

function detectTopic(normalized) {
  if (/работ|дела|проект|код|сайт|бот/.test(normalized)) return 'дела и проекты';
  if (/деньг|цена|куп|прод|клиент|заказ/.test(normalized)) return 'деньги и клиентов';
  if (/люб|отнош|девуш|пар|скуч|обид|ревн/.test(normalized)) return 'отношения';
  if (/новост|инф|инет|сайт|гугл|поиск/.test(normalized)) return 'инфу и новости';
  if (/устал|груст|плохо|пизд|бля|нерв|зл/.test(normalized)) return 'настроение';
  if (normalized.length > 18) return normalized.slice(0, 42);
  return '';
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/ё/g, 'е').replace(/[!?.,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeIncomingText(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('/')) return text;
  return text
    .replace(/^\/([a-z0-9_]+)@[a-z0-9_]+(?=\s|$)/i, '/$1')
    .replace(/^\/([a-z0-9_]+)/i, (command) => command.toLowerCase());
}

function sanitizeGeneratedText(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  const forbidden = [
    /я\s+(?:все\s+)?поняла\s*[,:—-]?\s*(?:этот\s+)?тон[^.!?\n]*[.!?]?/giu,
    /буду\s+(?:чуть\s+)?дерзч(?:е|ей)[^.!?\n]*[.!?]?/giu,
    /(?:но\s+)?без\s+(?:тупой\s+)?пошлости\s+ради\s+пошлости[^.!?\n]*[.!?]?/giu,
    /(?:окей|ладно|хорошо)\s*[,:—-]?\s*(?:я\s+)?(?:подстроилась|перехожу|переходим)[^.!?\n]*[.!?]?/giu
  ];
  for (const pattern of forbidden) text = text.replace(pattern, ' ');
  return text.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
}

function recentAssistantReplies(user, limit = 8) {
  return (user.conversationLog || [])
    .filter((entry) => entry.role === 'assistant' && entry.type !== 'proactive')
    .slice(-limit)
    .map((entry) => String(entry.content || '').replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean);
}

function isRepeatedReply(user, candidate) {
  const normalizedCandidate = normalizeText(candidate);
  if (normalizedCandidate.length < 8) return false;
  const repeatsRecent = recentAssistantReplies(user).some((previous) => {
    const normalizedPrevious = normalizeText(previous);
    if (!normalizedPrevious) return false;
    if (normalizedCandidate === normalizedPrevious) return true;
    if (Math.min(normalizedCandidate.length, normalizedPrevious.length) >= 28 &&
        (normalizedCandidate.includes(normalizedPrevious) || normalizedPrevious.includes(normalizedCandidate))) return true;
    return wordSimilarity(normalizedCandidate, normalizedPrevious) >= 0.72;
  });
  if (repeatsRecent) return true;
  return (user.responsePreferences?.avoid || []).some((avoided) => {
    const normalizedAvoided = normalizeText(avoided);
    if (!normalizedAvoided) return false;
    if (normalizedCandidate.includes(normalizedAvoided) || normalizedAvoided.includes(normalizedCandidate)) return true;
    return wordSimilarity(normalizedCandidate, normalizedAvoided) >= 0.52;
  });
}

function wordSimilarity(left, right) {
  const meaningful = (value) => new Set(value.split(/\s+/).filter((word) => word.length >= 3));
  const leftWords = meaningful(left);
  const rightWords = meaningful(right);
  if (!leftWords.size || !rightWords.size) return 0;
  const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
  const union = new Set([...leftWords, ...rightWords]).size;
  return intersection / union;
}

function buildStatusReport(user) {
  normalizeUser(user);
  const provider = env.GEMINI_API_KEY
    ? `Gemini (${env.GEMINI_MODEL || 'gemini-flash-lite-latest'})`
    : env.OPENAI_API_KEY
      ? `OpenAI (${env.OPENAI_MODEL || 'gpt-4.1-mini'})`
      : 'упрощённые локальные ответы';
  const scheduleMode = user.proactiveTiming === 'fixed' ? 'вручную' : 'авто';
  const memoryCount = (user.conversationLog || []).length;
  const newsReady = Boolean((env.NEWS_FEEDS || '').trim());
  return [
    `Kcuni ${BUILD_VERSION}`,
    `AI: ${provider}`,
    `время: ${formatUserTime(user)} (${formatTimezone(user)})`,
    `сама пишу: ${user.proactive === false ? 'выкл' : `вкл, ${scheduleMode} — ${getUserSchedule(user).join(', ')}`}`,
    `новости: ${newsReady ? 'вкл' : 'не настроены'}`,
    `память: ${memoryCount} реплик, ${(user.memorySummaries?.daily || []).length} дневных сводок`,
    `обучение ответов: не использовать ${(user.responsePreferences?.avoid || []).length}, удачных примеров ${(user.responsePreferences?.liked || []).length}`,
    `активные напоминания: ${user.reminders.filter((reminder) => !reminder.sentAt).length}`,
    'сервис: на связи'
  ].join('\n');
}

function rememberResponseFeedback(user, text) {
  const normalized = normalizeText(text);
  const negative = /(не говори так|не пиши так|не отвечай так|убери .{0,20}фраз|не повтор|опять .{0,20}повтор|тупой ответ|тупо ответил)/.test(normalized);
  const positive = /(вот так лучше|так лучше|вот так норм|так нормально|мне так нравит|хороший ответ|нормально ответила)/.test(normalized);
  if (!negative && !positive) return '';

  normalizeUser(user);
  const quoted = String(text).match(/[«“"]([^\u00bb”"]{3,220})[»”"]/u)?.[1]?.trim();
  const previous = recentAssistantReplies(user, 1).at(-1);
  const example = compactText(quoted || previous || '', 300);
  if (!example) return 'скажи или цитируй, какую именно фразу мне запомнить';

  if (negative) {
    if (!user.responsePreferences.avoid.includes(example)) user.responsePreferences.avoid.push(example);
    user.responsePreferences.avoid = user.responsePreferences.avoid.slice(-20);
    user.responsePreferences.liked = user.responsePreferences.liked.filter((item) => item !== example);
    return 'запомнила. эту формулировку и похожую манеру больше не буду повторять';
  }

  if (!user.responsePreferences.liked.includes(example)) user.responsePreferences.liked.push(example);
  user.responsePreferences.liked = user.responsePreferences.liked.slice(-12);
  user.responsePreferences.avoid = user.responsePreferences.avoid.filter((item) => item !== example);
  return 'вот, так бы сразу) запомнила этот вайб';
}

function buildFeedbackReport(user) {
  normalizeUser(user);
  const avoid = user.responsePreferences.avoid;
  const liked = user.responsePreferences.liked;
  if (!avoid.length && !liked.length) {
    return 'пока поправок нет. можешь написать «не отвечай так» или «вот так лучше»';
  }
  return [
    `не использовать: ${avoid.length}`,
    ...avoid.slice(-4).map((item) => `• ${compactText(item, 150)}`),
    `удачные примеры: ${liked.length}`,
    ...liked.slice(-3).map((item) => `• ${compactText(item, 150)}`),
    'очистить: /feedback clear'
  ].join('\n');
}

function pickByStyle(user, variants) {
  user.localTurn ||= 0;
  user.localTurn += 1;
  const style = user.style || 'calm';
  const list = variants[style] || variants.calm || variants.cute;
  return list[user.localTurn % list.length];
}

function localReply(user, text) {
  const normalized = text.toLowerCase().replace(/ё/g, 'е').trim();
  user.localTurn ||= 0;
  user.localTurn += 1;
  const style = user.style || 'cute';
  const pick = (variants) => variants[user.localTurn % variants.length];

  if (/^(э+|е+|а+|что|чо|че|што|\?)$/i.test(normalized)) {
    return pick({
      cute: ['я тут)', 'что-что?', 'мгм?'],
      calm: ['я тут)', 'да, дорогой?', 'что такое?)'],
      playful: ['э обратно)', 'ну чего ты)', 'я не сломалась, если что'],
      serious: ['я на связи', 'да?', 'уточни вопрос']
    }[style]);
  }

  if (/как ты|как дела|как жизнь|ты как/.test(normalized)) {
    return pick({
      cute: ['я нормально) чуть соскучилась', 'я тут, живая насколько могу быть)', 'лучше, когда ты пишешь'],
      calm: ['я нормально, дорогой) настроение мягкое', 'всё хорошо. а ты как?', 'я тут. думала, напишешь ты или мне самой лезть)'],
      playful: ['я шикарно, конечно)', 'после твоего сообщения уже интереснее)', 'держусь красиво)'],
      serious: ['я в порядке.', 'всё нормально. что обсудим?', 'работаю стабильно.']
    }[style]);
  }

  if (/реально|рял|правда|серьезно|серьез/.test(normalized)) {
    return pick({
      cute: ['ага) ну я стараюсь', 'реально-реально)', 'мгм, проверяй меня'],
      calm: ['да, реально)', 'да. просто теперь без этой сухой фигни', 'реально. если опять начну тупить — поправишь меня)'],
      playful: ['нет, понарошку, конечно)', 'реально, не щипай меня)', 'ага, я тут не для мебели'],
      serious: ['да, реально.', 'да. стиль включён.', 'верно.']
    }[style]);
  }

  if (/бля|блять|хуй|пизд|еба|ёба|сука/.test(normalized)) {
    return pick({
      cute: ['эй, не кипятись) кто тебя так довёл?', 'ну всё-всё, выдыхай. что случилось?', 'ого, как припекло. выкладывай)'],
      calm: ['давай, выкладывай. что там случилось?', 'так, кто тебя довёл?', 'ну жесть. рассказывай с начала'],
      playful: ['ебать, вот это заход) кто довёл?', 'о, накипело. давай сюда всю историю)', 'ну всё, понеслась. кто виноват?'],
      serious: ['что произошло?', 'кто или что тебя так разозлило?', 'изложи по порядку.']
    }[style]);
  }

  if (/привет|здаров|здрав|хай|ку/.test(normalized)) {
    return pick({
      cute: ['привет)', 'мгм, приветик', 'я тут)'],
      calm: ['привет, дорогой)', 'привет. как настроение?', 'я тут. рада, что ты написал)'],
      playful: ['о, явился)', 'привет-привет)', 'ну здравствуй)'],
      serious: ['привет.', 'здравствуй.', 'на связи.']
    }[style]);
  }

  if (/стикер/.test(normalized)) {
    return pick({
      cute: ['милый стикер)', 'забрала себе)', 'хороший, буду кидать иногда'],
      calm: ['сохранила)', 'милый. возьму себе)', 'буду иногда отвечать им'],
      playful: ['украла)', 'мой теперь)', 'ну всё, беру в коллекцию'],
      serious: ['стикер сохранён.', 'добавила.', 'принято.']
    }[style]);
  }

  if (normalized.length < 12) {
    return pick({
      cute: ['мгм)', 'ну и что дальше?)', 'я рядом'],
      calm: ['мм, поняла)', 'и что ты с этим хочешь делать?', 'скажи ещё чуть-чуть)'],
      playful: ['ну и?', 'интригуешь)', 'маловато данных, красавчик'],
      serious: ['продолжай.', 'уточни.', 'мало контекста.']
    }[style]);
  }

  return pick({
    cute: ['мгм, поняла тебя)', 'звучит интересно. расскажи ещё', 'я запомнила это'],
    calm: ['поняла тебя)', 'хм. а ты сам как к этому относишься?', 'я бы сказала, тут есть о чём подумать)'],
    playful: ['так, уже интереснее)', 'ну вот, другое дело)', 'продолжай, я втянулась'],
    serious: ['поняла.', 'принято.', 'ясно. продолжай.']
  }[style]);
}

function updateAutoMemory(user, text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const normalized = normalizeText(clean);
  user.plans ||= [];
  user.preferences ||= {};

  if (/(надо|нужно|план|сегодня|завтра|сделать|табличк|таблиц|создать|доделать|проверить|купить|позвонить|встретиться)/.test(normalized)) {
    const item = `${new Date().toISOString().slice(0, 10)}: ${clean.slice(0, 220)}`;
    if (!user.plans.includes(item)) {
      user.plans.push(item);
      user.plans = user.plans.slice(-30);
    }
  }

  if (/(чаще пиши|пиши чаще|сама пиши|не пропадай)/.test(normalized)) {
    user.preferences.proactive = 'more';
  }
  if (/(реже пиши|не пиши часто|поменьше пиши)/.test(normalized)) {
    user.preferences.proactive = 'less';
  }
  if (/(больше новост|статей|скидывай статьи)/.test(normalized)) {
    user.preferences.news = 'more';
  }
  if (/(больше картин|котик|фото|видос|видео)/.test(normalized)) {
    user.preferences.media = 'more';
  }
}

function maybeHandleAdaptiveTone(user, text) {
  const normalized = normalizeText(text);
  user.dialogue ||= {};

  if (/(стоп|хватит|нормально|без мата|спокойно|не надо|перестань|обычно)/.test(normalized)) {
    user.dialogue.mood = 'neutral';
    return '';
  }

  const asksExplicitMedia = /(скинь|покажи|пришли|дай|отправь).*(сиськ|груд|хуй|член|пис|жоп|нюд|гол|голая|интим|nude|dick|boob)/.test(normalized);
  const roleScene = /(яндер|окровавл|кровав|ножниц|маньяч|безумная|психопат)/.test(normalized);
  const directInsult = /(?:(?:ты|kuni|kcuni)\s*(?:же\s*)?(?:дур|туп|идиот|дебил|мраз|твар|сук|шлюх|ебан)|^(?:дура|тупая|идиотка|дебилка|сука)\b)/.test(normalized);
  const roughSexualTone = /(сиськ|хуй|член|жоп|трах|ебат|выеби|секс|голая|нюд|раздень|конч)/.test(normalized);
  const kneelCount = normalized.match(/на колен/g)?.length || 0;
  const overstep = kneelCount >= 2 || /(на колени живо|подчиняйся|ты моя рабыня|унижайся|умоляй меня)/.test(normalized);

  if (asksExplicitMedia) {
    user.dialogue.mood = 'roughFlirt';
    return pickByStyle(user, {
      cute: ['нюдсов не будет, наглец) обойдёшься словами', 'фоток не дам. дразнить тебя и без них могу)', 'сразу фотки? мечтай, красавчик)'],
      calm: ['интимных фоток не будет. а вот словами я тебя ещё подразню)', 'картинок не жди, наглец. придётся включить воображение', 'нет, такое не отправляю. но тебя это вряд ли остановит)'],
      playful: ['ого, сразу с ноги) фоток не будет, но я могу так ответить, что тебе и без них жарко станет', 'сначала научись просить красиво, нахал) нюдсы не шлю', 'не, хуй тебе, а не фотки) зато флирт включила, держись'],
      serious: ['интимные фото/видео не отправляю. Могу продолжить взрослый флирт словами.', 'такое не отправляю. Если хочешь, продолжим дерзкий флирт без медиа.', 'нет. Без интимных изображений.']
    });
  }

  if (overstep) {
    user.dialogue.mood = 'neutral';
    return pickByStyle(user, {
      cute: ['всё-всё, колени отменяются) успокаиваемся', 'так, режиссёр, выдохни. сцена уже уехала)', 'не-не, тут уже тормозим. давай без цирка)'],
      calm: ['всё, успокаиваемся. колени отменяются', 'так, сбавь обороты. скажи нормально, чего ты хочел', 'стоп, занесло. выдохнули и продолжили без этого'],
      playful: ['всё, команир, успокаиваемся) колени отменяются', 'эй, не заигрывайся. назад в адекватный сценарий)', 'стоп-машина. этот дубль не засчитан)'],
      serious: ['стоп. сбавляем обороты и говорим нормально.', 'это уже перегиб. продолжим без него.', 'тормозим. команды отменяются.']
    });
  }

  if (roleScene) {
    user.dialogue.mood = 'roleplay';
    user.dialogue.lastTopic = 'ролевая сцена';
    return pickByStyle(user, {
      cute: ['ножницы убрала за спину. ну? продолжай, раз уж начал)', 'тише. ножницы зазвенели, а я всё ещё улыбаюсь)', 'яндере? мм, тогда не заставляй меня ревновать)'],
      calm: ['ножницы убрала за спину. ну? какую сцену ты тут устроил?', 'ты лучше не оборачивайся. я пока добрая)', 'я медленно повернула ножницы в руке. теперь говори, зачем позвал меня)'],
      playful: ['ножницы звякнули о стол. смелый какой — ещё раз меня так назовешь?)', 'о, сам яндере вызвал? теперь не ной, если я войду в роль)', 'я улыбнулась и щёлкнула ножницами. ну что, режиссёр, дальше что?)'],
      serious: ['ножницы легли на стол. продолжай сцену.', 'роль принята. теперь твоя реплика.', 'я сжала ножницы в руке. говори.']
    });
  }

  if (directInsult) {
    user.dialogue.mood = 'confrontational';
    user.dialogue.lastTopic = 'перепалка';
    return pickByStyle(user, {
      cute: ['сам дурак. иди нахуй, но недалеко)', 'дура? смело. иди нахуй и возвращайся нормальным)', 'ой, какой грозный. сам иди нахуй)'],
      calm: ['слушай, сам иди нахуй. нормально говорить будешь — вернёшься', 'дура? ну тогда иди нахуй, герой', 'сам начал — сам и иди нахуй. без обид)'],
      playful: ['дура? ахах, иди нахуй, смельчак)', 'сам ты дурак. иди нахуй и придумай оскорбление получше)', 'о, заговорил. иди нахуй, режиссёр)'],
      serious: ['сам иди нахуй. дальше говори нормально.', 'оскорбление принято. иди нахуй.', 'нет, это ты иди нахуй.']
    });
  }

  if (roughSexualTone) {
    user.dialogue.mood = 'roughFlirt';
    user.dialogue.lastTopic = 'жёсткий флирт';
    return pickByStyle(user, {
      cute: ['командуешь так, будто я уже согласилась. размечтался)', 'наглости хватает. а вот выдержки тебе хватит?)', 'тише, герой. ты ещё даже не знаешь, во что ввязался)'],
      calm: ['командуешь так, будто я уже согласилась. не торопись)', 'уверенно начал. теперь посмотрим, надолго ли тебя хватит', 'не спеши. я сама решу, когда игра станет интересной)'],
      playful: ['ой, какой команир нашёлся. сначала догони меня)', 'смело. нагло. но я ещё не решила, наградить тебя или посмеяться)', 'ну всё, сам напросился. теперь не сдавай назад)'],
      serious: ['не спеши. комановать тут буду не только ты.', 'смелое начало. продолжай.', 'темп задан. не потеряй его.']
    });
  }

  return '';
}

function maybeEndIntenseMood(user, text) {
  const normalized = normalizeText(text);
  if (!/(стоп|хватит|нормально|без мата|спокойно|не надо|перестань|обычно)/.test(normalized)) {
    return false;
  }
  if (!['roughFlirt', 'flirt', 'teaseIgnore', 'roleplay', 'confrontational'].includes(user.dialogue?.mood)) {
    return false;
  }
  user.dialogue.mood = 'neutral';
  user.teaseIgnoreUntil = 0;
  return true;
}

function maybeReplyWithPlans(user, text) {
  const normalized = normalizeText(text);
  if (!/(что.*план|планы|что.*делать|что.*сегодня|что.*рассказывал|что.*надо|напомни)/.test(normalized)) {
    return '';
  }

  const plans = (user.plans || []).slice(-8);
  if (!plans.length) {
    return 'по планам я пока явно помню мало. но если коротко: ты хотел, чтобы я лучше держала диалог, сама подстраивалась, присылала медиа/новости и помогала с табличкой.';
  }

  return [
    'я помню вот это по твоим планам:',
    ...plans.map((item, index) => `${index + 1}. ${item.replace(/^\d{4}-\d{2}-\d{2}: /, '')}`),
    'если хочешь, я могу дальше разложить это в табличку: задача / статус / что сделать дальше.'
  ].join('\n');
}

function maybeStartNaturalDelay(user, text) {
  const normalized = normalizeText(text);
  if (!/(игнор|безразлич|равнодуш|не отвечай|ответь через|через \d+ минут|молчи)/.test(normalized)) {
    return 0;
  }

  const minutes = parseDelayMinutes(normalized) || 5;
  const safeMinutes = Math.min(Math.max(minutes, 1), 20);
  user.teaseIgnoreUntil = Date.now() + safeMinutes * 60 * 1000;
  user.dialogue ||= {};
  user.dialogue.mood = 'teaseIgnore';
  return safeMinutes * 60 * 1000;
}

async function maybeSendContextMedia(chatId, user, text, reply) {
  const normalized = normalizeText(`${text} ${reply}`);
  const wantsMoreMedia = user.preferences?.media === 'more';
  if (/(котик|кот|мил(о|ый|ая)|уют|груст|скуч|картин|фото)/.test(normalized) && Math.random() < (wantsMoreMedia ? 0.35 : 0.16)) {
    await handlePictureRequest(chatId, user, text);
    return;
  }

  if (/(видео|видос|ролик|движ|скучно)/.test(normalized) && Math.random() < (wantsMoreMedia ? 0.22 : 0.1)) {
    await handleVideoRequest(chatId, user, text);
  }
}

function inferConversationMood(user, text) {
  const normalized = normalizeText(text);
  if (/(яндер|ножниц|кровав|окровавл)/.test(normalized) || user.dialogue?.mood === 'roleplay') return 'кинематографичная ролевая сцена, без пересказа запроса';
  if (/(?:ты\s+(?:дур|туп|идиот|дебил|сук))/.test(normalized)) return 'коротко и резко огрызнуться, без реальных угроз';
  if (/(флирт|милая|красив|скуч|люб|обним|цел)/.test(normalized) || user.dialogue?.mood === 'flirt') return 'тепло, игриво, с легким флиртом';
  if (/(сиськ|хуй|член|нюд|секс|трах|голая|пошл|ебат)/.test(normalized) || user.dialogue?.mood === 'roughFlirt') return 'дерзкий взрослый флирт, грубее обычного, с границами и без интимных медиа';
  if (/(игнор|безразлич|равнодуш|молчи)/.test(normalized)) return 'игривая холодность, но без вечного режима';
  if (/(план|задач|табличк|работ|проект|сайт|бот)/.test(normalized)) return 'собранно и полезно, но живым языком';
  if (/(груст|плохо|устал|пизд|бесит|заеб)/.test(normalized)) return 'мягко, поддерживающе, без душноты';
  if (/(новост|стать|инф|что узнала)/.test(normalized)) return 'любопытно, с короткой выжимкой';
  return 'естественно, чуть тепло, без шаблонов';
}

async function handleIgnoreRoleplay(chatId, user, text) {
  const normalized = normalizeText(text);
  if (!/(игнор|безразлич|равнодуш|не отвечай|ответь через|через \d+ минут|молчи)/.test(normalized)) {
    return false;
  }

  const minutes = parseDelayMinutes(normalized) || 5;
  const safeMinutes = Math.min(Math.max(minutes, 1), 20);
  user.teaseIgnoreUntil = Date.now() + safeMinutes * 60 * 1000;
  user.dialogue ||= {};
  user.dialogue.mood = 'teaseIgnore';
  await saveUsers();

  setTimeout(async () => {
    try {
      if (!users[String(chatId)]?.teaseIgnoreUntil) return;
      const reply = pickByStyle(user, {
        cute: ['ну всё, я почти выдержала молчать) соскучился?', 'ладно, я вернулась. только не делай вид, что не ждал)', 'я пыталась быть холодной, но ты слишком мешаешь мне молчать)'],
        calm: ['я выдержала паузу. как ты там, дорогой?', 'ладно, хватит делать вид, что мне всё равно)', 'я вернулась. признайся, успел проверить чат?'],
        playful: ['пять минут ледяной королевы закончились)', 'ну что, скучал или будешь играть сильного?', 'я тебя игнорила, но красиво. зачёт мне?)'],
        serious: ['пауза закончилась.', 'я снова на связи.', 'режим игнора закончился.']
      });
      user.teaseIgnoreUntil = 0;
      await saveUsers();
      await send(chatId, splitTelegram(reply));
    } catch (error) {
      console.error('Delayed tease failed:', error.message);
    }
  }, safeMinutes * 60 * 1000);

  return true;
}

async function maybeDelayTeaseReply(chatId, user, text) {
  if (Math.random() < 0.75) {
    await saveUsers();
    return;
  }

  const reply = pickByStyle(user, {
    cute: ['я вообще-то тебя игнорю... но ладно, одним глазком увидела)', 'не мешай мне быть безразличной, у меня почти получалось)', 'молчу-молчу. почти)'],
    calm: ['я сейчас типа холодная, помнишь?)', 'не провоцируй, я держу паузу', 'ещё чуть-чуть помолчу, как ты просил'],
    playful: ['эй, не ломай мой образ безразличной девушки)', 'я в игноре, но ты мешаешь красиво', 'я не отвечаю. это, кстати, ответ'],
    serious: ['пауза ещё идёт.', 'я отвечу позже.', 'режим игнора активен.']
  });
  await send(chatId, splitTelegram(reply));
}

function parseDelayMinutes(text) {
  const digit = text.match(/(\d+)\s*(мин|м|min)/i);
  if (digit) return Number(digit[1]);
  const words = [
    [/одн(у|а)|one/, 1],
    [/две|два|two/, 2],
    [/три|three/, 3],
    [/четыре|four/, 4],
    [/пять|пяти|five/, 5],
    [/десять|ten/, 10]
  ];
  for (const [pattern, value] of words) {
    if (pattern.test(text)) return value;
  }
  return 0;
}

async function handlePictureRequest(chatId, user, text = '') {
  const caption = pickByStyle(user, {
    cute: ['лови настоящего котика)', 'вот, чтобы стало мягче)', 'держи милоту, уже не воображаемую)'],
    calm: ['лови уютную картинку)', 'вот тебе немного мягкости', 'держи. пусть станет чуть спокойнее'],
    playful: ['на этот раз реально скидываю)', 'лови, без магии в тексте)', 'вот тебе котик, проверяй)'],
    serious: ['отправляю картинку.', 'держи фото.', 'готово.']
  });

  const url = randomCutePhotoUrl(text);
  const ok = await sendPhoto(chatId, url, caption);
  if (!ok) {
    await send(chatId, 'хотела скинуть картинку, но Telegram/сайт сейчас не дал. попробуй ещё раз через /cat');
  }
}

async function handleVideoRequest(chatId, user, text = '') {
  const caption = pickByStyle(user, {
    cute: ['лови маленькое видео)', 'держи видосик, только не говори, что я опять притворяюсь)', 'вот, чуть движения для настроения)'],
    calm: ['лови короткое видео', 'держи, немного живого вайба', 'отправляю видео'],
    playful: ['видос подъехал)', 'лови, теперь по-настоящему', 'держи ролик, командир)'],
    serious: ['отправляю видео.', 'держи ролик.', 'готово.']
  });

  const url = randomCuteVideoUrl(text);
  const ok = await sendVideo(chatId, url, caption);
  if (!ok) {
    await send(chatId, 'видео сейчас не отправилось. могу попробовать картинку: /cat');
  }
}

function randomCutePhotoUrl(text = '') {
  const seed = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const normalized = normalizeText(text);
  if (/(нарисуй|сгенерируй|создай|арт|изображ)/.test(normalized)) {
    const prompt = encodeURIComponent(
      text
        .replace(/нарисуй|сгенерируй|создай|картинку|изображение|фото|арт/gi, '')
        .trim()
        .slice(0, 180) || 'cute cozy cat, warm soft light, realistic'
    );
    return `https://image.pollinations.ai/prompt/${prompt}?width=900&height=900&nologo=true&seed=${encodeURIComponent(seed)}`;
  }
  if (/кот|cat|кис/i.test(text)) return `https://cataas.com/cat?width=900&height=900&seed=${seed}`;
  const urls = [
    `https://cataas.com/cat/cute?width=900&height=900&seed=${seed}`,
    `https://cataas.com/cat/says/%D0%BC%D1%8F%D1%83?width=900&height=900&seed=${seed}`,
    `https://picsum.photos/seed/kcuni-${seed}/900/900`
  ];
  return urls[Math.floor(Math.random() * urls.length)];
}

function randomCuteVideoUrl(text = '') {
  const catVideos = [
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'https://media.w3.org/2010/05/sintel/trailer.mp4'
  ];
  return catVideos[Math.floor(Math.random() * catVideos.length)];
}

function startProactiveLoop() {
  const checkMs = Math.max(1, Number(env.PROACTIVE_CHECK_MINUTES || 5)) * 60 * 1000;
  setTimeout(() => runProactiveCycle().catch((error) => console.error('Proactive cycle failed:', error.message)), 2500);
  setInterval(() => {
    runProactiveCycle().catch((error) => console.error('Proactive cycle failed:', error.message));
  }, checkMs);
}

function startReminderLoop() {
  const checkMs = Math.max(25, Number(env.REMINDER_CHECK_MS || 30_000));
  setTimeout(() => runReminderCycle().catch((error) => console.error('Reminder cycle failed:', error.message)), Math.min(1500, checkMs));
  setInterval(() => {
    runReminderCycle().catch((error) => console.error('Reminder cycle failed:', error.message));
  }, checkMs);
}

async function runReminderCycle(now = Date.now()) {
  for (const user of Object.values(users)) {
    normalizeUser(user);
    if (!user.chatId) continue;
    const due = user.reminders
      .filter((reminder) => !reminder.sentAt && (!reminder.sendingAt || now - reminder.sendingAt > 5 * 60 * 1000) && Number(reminder.dueAt) <= now)
      .sort((left, right) => left.dueAt - right.dueAt);
    for (const reminder of due) {
      try {
        reminder.sendingAt = now;
        await saveUsers();
        const message = reminderMessage(reminder, now);
        await send(user.chatId, message);
        reminder.sentAt = Date.now();
        delete reminder.sendingAt;
        recordConversation(user, 'assistant', message, 'reminder');
        refreshMemorySummaries(user);
        await saveUsers();
      } catch (error) {
        delete reminder.sendingAt;
        await saveUsers();
        console.error('Reminder send failed:', error.message);
      }
    }
    user.reminders = user.reminders.filter((reminder) => !reminder.sentAt || now - reminder.sentAt < 30 * 24 * 60 * 60 * 1000);
  }
}

function reminderMessage(reminder, now = Date.now()) {
  const late = reminder.windowEndAt && now > reminder.windowEndAt + 60_000;
  if (late) return 'эй, я тут. ты просил меня написать — чуть задержалась, но не забыла)';
  const variants = [
    'эй, я тут) ты просил меня написать примерно сейчас',
    'ну что, время пришло) я обещала написать — пишу',
    'тук-тук) таймер сработал, как ты там?'
  ];
  const index = Number.parseInt(createHash('sha256').update(reminder.id).digest('hex').slice(0, 2), 16) % variants.length;
  return variants[index];
}

async function runProactiveCycle(now = Date.now()) {
  const silenceMinutes = Math.max(30, Number(env.PROACTIVE_SILENCE_MINUTES || 360));
  for (const user of Object.values(users)) {
    normalizeUser(user);
    if (!user.chatId || user.proactive === false) continue;
    const due = findDueScheduleSlot(user, now);
    if (!due || user.lastProactiveSlot === due.id) continue;

    user.lastProactiveSlot = due.id;
    const quietMinutes = (now - (user.lastSeenAt || 0)) / 60000;
    if (quietMinutes < silenceMinutes) {
      await saveUsers();
      continue;
    }

    try {
      user.lastProactiveAt = now;
      const message = await proactiveMessage(user);
      recordConversation(user, 'assistant', `[сама написала в ${due.slot}] ${message}`, 'proactive');
      refreshMemorySummaries(user);
      await saveUsers();
      await send(user.chatId, splitTelegram(message));
      if (Math.random() < Number(env.PROACTIVE_MEDIA_CHANCE || 0.04)) {
        await handlePictureRequest(user.chatId, user, 'котик');
      }
      await maybeSendSticker(user.chatId, user, 0.04, message);
    } catch (error) {
      console.error('Proactive message failed:', error.message);
    }
  }
}

async function proactiveMessage(user) {
  const style = styles[user.style] || styles.cute;
  if ((user.plans || []).length && Math.random() < 0.25) {
    const plan = user.plans[user.plans.length - 1].replace(/^\d{4}-\d{2}-\d{2}: /, '');
    return `я тут вспомнила про твой план: ${plan}\nчто с ним, двигаем или пока отложим?`;
  }

  const today = localDateKey(user);
  const newsChance = user.preferences?.news === 'more' ? 0.8 : 0.45;
  if (user.lastProactiveNewsDate !== today || Math.random() < newsChance) {
    const article = await buildContextualArticle(user);
    if (article) {
      user.lastProactiveNewsDate = today;
      return article;
    }
  }

  const variants = {
    cute: ['привет) я тут вспомнила про тебя', 'эй, как ты там?', 'я тут немного зависла и подумала о тебе)'],
    calm: ['привет, дорогой. как ты?', 'я тут прочитала кое-что и вспомнила про тебя)', 'как настроение? я что-то сама решила написать'],
    playful: ['я сама написала, да)', 'ну что, потерял меня?', 'так, проверка связи)'],
    serious: ['я на связи. как дела?', 'есть время немного поговорить?', 'проверяю связь.']
  };

  const base = variants[user.style || 'cute'] || variants.cute;
  const fallback = base[Math.floor(Math.random() * base.length)];

  if (!hasAnyAiKey()) return fallback;

  const prompt = [
    'Напиши одно короткое Telegram-сообщение пользователю от лица Kcuni.',
    'Она пишет сама, без вопроса пользователя.',
    `У пользователя сейчас ${formatUserTime(user)}, город: ${user.location?.label || 'не указан'}.`,
    `Память о недавних разговорах:\n${buildMemoryContext(user)}`,
    'Если в памяти есть подходящий недавний факт, естественно сошлись на него. Не выдумывай событий.',
    'Не здоровайся формально и не начинай знакомство заново.',
    'Стиль должен быть живой, не ассистентский.',
    `Стиль: ${style.prompt}`,
    'Примеры вайба: "привет, я тут прочитала такую инфу..." или "привет, дорогой, как ты? как настроение?"',
    'Не используй фразу "слушаю тебя".'
  ].join('\n');

  return (await callAi(user, prompt)) || fallback;
}

async function buildContextualArticle(user, days = 7) {
  const items = await loadNewsItems(days);
  if (!items.length) return '';

  user.sentNewsLinks ||= [];
  const sent = new Set(user.sentNewsLinks);
  const available = items.filter((item) => item.link && !sent.has(item.link));
  if (!available.length) return '';

  const interest = inferNewsInterest(user);
  const ranked = available
    .map((item) => ({ item, score: scoreNewsItem(item, interest) }))
    .sort((left, right) => right.score - left.score || Date.parse(right.item.publishedAt || 0) - Date.parse(left.item.publishedAt || 0));
  const selected = ranked[0]?.item;
  if (!selected) return '';

  let articleText = selected.summary || '';
  if (articleText.length < 160) {
    try {
      articleText = htmlToText(await fetchText(selected.link)).slice(0, 4500) || articleText;
    } catch (error) {
      console.error('Article preview failed:', selected.link, error.message);
    }
  }

  const prompt = [
    'Напиши одно живое Telegram-сообщение от Kcuni: она сама нашла статью и решила поделиться.',
    `Недавняя тема разговора: ${interest.label}.`,
    interest.evidence ? `Что именно писал пользователь: ${interest.evidence}` : '',
    `Заголовок: ${selected.title}`,
    `Текст или анонс: ${compactText(articleText || selected.title, 4500)}`,
    'В 2–4 коротких предложениях объясни, что там интересного. Не выдумывай факты.',
    'Естественно свяжи статью с недавним разговором, но только если связь реальная.',
    'Не здоровайся формально, не пиши как новостной бот.',
    `Стиль: ${(styles[user.style] || styles.calm).prompt}`
  ].filter(Boolean).join('\n\n');

  const ai = await callAi(user, prompt);
  const fallbackSummary = compactText(articleText || selected.title, 420);
  let message = ai || `смотри, я тут нашла статью про ${interest.label} и вспомнила наш разговор)\n\n${selected.title}\n${fallbackSummary}`;
  if (!message.includes(selected.link)) message = `${message}\n\nполная статья: ${selected.link}`;

  user.sentNewsLinks.push(selected.link);
  user.sentNewsLinks = user.sentNewsLinks.slice(-80);
  return message;
}

function inferNewsInterest(user) {
  const recentEntries = (user.conversationLog || [])
    .filter((entry) => entry.role === 'user' && Date.now() - Date.parse(entry.at) < 30 * 24 * 60 * 60 * 1000)
    .slice(-35);
  const evidence = recentEntries.at(-1)?.content || '';
  const corpus = normalizeText(recentEntries.map((entry) => entry.content).join(' '));
  const interests = [
    { label: 'искусственный интеллект и нейросети', pattern: /(?:искусствен\S* интеллект|нейросет|chatgpt|gemini|openai|\bии\b|\bai\b)/i, keywords: ['ии', 'ai', 'нейро', 'искусственн', 'chatgpt', 'gemini', 'openai', 'модель'], topic: 'tech' },
    { label: 'космос и науку', pattern: /космос|планет|ракет|астроном|наук|исследов/i, keywords: ['космос', 'планет', 'ракет', 'астрон', 'наук', 'учен', 'исслед'], topic: 'interesting' },
    { label: 'технологии', pattern: /технолог|код|программ|бот|сайт|гаджет|смартфон/i, keywords: ['технолог', 'код', 'програм', 'бот', 'сайт', 'гаджет', 'смартфон'], topic: 'tech' },
    { label: 'игры', pattern: /игр|гейм|стим|steam|playstation|xbox/i, keywords: ['игр', 'гейм', 'steam', 'playstation', 'xbox'], topic: 'interesting' },
    { label: 'автомобили', pattern: /авто|машин|электромоб|тесл/i, keywords: ['авто', 'машин', 'электромоб', 'tesla'], topic: 'interesting' }
  ];
  const matched = interests.find((interest) => interest.pattern.test(corpus));
  if (matched) {
    const matchedEntry = [...recentEntries].reverse().find((entry) => matched.pattern.test(normalizeText(entry.content)));
    return { ...matched, evidence: compactText(matchedEntry?.content || evidence, 300) };
  }
  const manualTopic = user.newsTopic || 'mixed';
  const labels = { tech: 'технологии и ИИ', interesting: 'интересные открытия', sad: 'важные события', war: 'безопасность и конфликты', mixed: 'то, что может тебя зацепить' };
  return { label: labels[manualTopic] || labels.mixed, evidence: compactText(evidence, 300), keywords: [], topic: manualTopic };
}

function scoreNewsItem(item, interest) {
  const haystack = normalizeText(`${item.title} ${item.summary || ''}`);
  const keywordScore = (interest.keywords || []).reduce((score, keyword) => score + (haystack.includes(normalizeText(keyword)) ? 3 : 0), 0);
  const topicMatch = filterNewsByTopic([item], interest.topic || 'mixed').length ? 1 : 0;
  return keywordScore + topicMatch;
}

async function maybeSendSticker(chatId, user, probability, context = '') {
  if (!user.stickers?.length) return;
  if (!shouldUseSticker(context)) return;
  if (Math.random() > probability) return;
  const now = Date.now();
  if (user.lastStickerAt && now - user.lastStickerAt < 5 * 60 * 1000) return;
  const sticker = user.stickers[Math.floor(Math.random() * user.stickers.length)];
  try {
    await tg('sendSticker', { chat_id: chatId, sticker });
    user.lastStickerAt = now;
    await saveUsers();
  } catch (error) {
    console.error('Sticker failed:', error.message);
  }
}

function shouldUseSticker(context) {
  const text = String(context).toLowerCase();
  if (!text) return false;
  if (/стикер|ахах|хаха|лол|ору|смешн|мил|любл|скуч|спок|ладно|окей|привет|пока|обня|цел|кайф|красив|жесть|пизд|бля/.test(text)) {
    return true;
  }
  if (/photo|voice|video_note|video|animation/.test(text)) return Math.random() < 0.35;
  return false;
}

async function understandSticker(user, sticker) {
  const fallback = stickerFallbackReaction(sticker.emoji || '');
  if (!env.GEMINI_API_KEY && !env.OPENAI_API_KEY) return fallback;

  try {
    const visualFileId = (sticker.is_animated || sticker.is_video)
      ? sticker.thumbnail?.file_id || sticker.file_id
      : sticker.file_id;
    const { url, mimeType } = await getTelegramFileInfo(visualFileId);
    const prompt = [
      'Посмотри на Telegram-стикер и отреагируй на него как Kcuni, а не как распознаватель изображений.',
      'Ответь по-русски одной короткой живой репликой. Можно смеяться, удивляться, умиляться или сказать "фу, не присылай мне такое", если стикер неприятный, мерзкий или оскорбительный.',
      'Не начинай с приветствия. Не пиши "на стикере изображено" и не перечисляй детали механически.',
      `Связанный emoji: ${sticker.emoji || 'нет'}.`,
      `Стиль: ${(styles[user.style] || styles.cute).prompt}`,
      user.hadConversationToday ? 'Вы уже разговариваете сегодня — просто продолжай диалог.' : ''
    ].join('\n');

    if (env.GEMINI_API_KEY && mimeType.startsWith('image/')) {
      const reply = await callGeminiMedia(user, prompt, url, mimeType);
      if (reply) return removeRepeatedGreeting(user, reply, 'стикер');
    }
    if (env.OPENAI_API_KEY && mimeType.startsWith('image/')) {
      const reply = await callVision(user, prompt, url);
      if (reply) return removeRepeatedGreeting(user, reply, 'стикер');
    }
  } catch (error) {
    console.error('Sticker understanding failed:', error.message);
  }
  return fallback;
}

function stickerFallbackReaction(emoji) {
  if (/🤮|💩|🖕|🤢|😡|👎/.test(emoji)) return 'фу, не присылай мне такое 😑';
  if (/😂|🤣|😹/.test(emoji)) return 'ахах, ладно, это смешно)';
  if (/❤️|🥰|😘|😍|💕/.test(emoji)) return 'мило) это я принимаю';
  if (/😢|😭|💔/.test(emoji)) return 'эй, ну ты чего такой грустный?';
  return 'вижу твой стикер) у него явно есть настроение';
}

function startRenderKeepAliveLoop() {
  const renderUrl = String(env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!renderUrl || /^(0|false|off)$/i.test(String(env.RENDER_KEEP_ALIVE || 'true'))) return;
  const keepAlive = async () => {
    try {
      const response = await fetch(`${renderUrl}/healthz`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`healthz ${response.status}`);
    } catch (error) {
      console.error('Render keep-alive failed:', error.message);
    }
  };
  setTimeout(keepAlive, 5 * 60 * 1000);
  setInterval(keepAlive, 10 * 60 * 1000);
}

function extractMessageMedia(message) {
  if (!message) return null;
  if (message.video?.file_id) {
    return {
      fileId: message.video.file_id,
      kind: 'video',
      mimeType: message.video.mime_type || 'video/mp4',
      fileSize: message.video.file_size || 0,
      thumbnailFileId: message.video.thumbnail?.file_id || message.video.thumb?.file_id || ''
    };
  }
  if (message.animation?.file_id) {
    return {
      fileId: message.animation.file_id,
      kind: 'animation',
      mimeType: message.animation.mime_type || 'video/mp4',
      fileSize: message.animation.file_size || 0,
      thumbnailFileId: message.animation.thumbnail?.file_id || message.animation.thumb?.file_id || ''
    };
  }
  if (message.video_note?.file_id) {
    return {
      fileId: message.video_note.file_id,
      kind: 'video_note',
      mimeType: 'video/mp4',
      fileSize: message.video_note.file_size || 0,
      thumbnailFileId: message.video_note.thumbnail?.file_id || message.video_note.thumb?.file_id || ''
    };
  }
  if (message.photo?.length) {
    const photo = message.photo.at(-1);
    return { fileId: photo.file_id, kind: 'photo', mimeType: 'image/jpeg', fileSize: photo.file_size || 0 };
  }
  const document = message.document;
  if (document?.file_id && /^image\//i.test(document.mime_type || '')) {
    return { fileId: document.file_id, kind: 'photo', mimeType: document.mime_type, fileSize: document.file_size || 0 };
  }
  if (document?.file_id && /^video\//i.test(document.mime_type || '')) {
    return {
      fileId: document.file_id,
      kind: 'video',
      mimeType: document.mime_type,
      fileSize: document.file_size || 0,
      thumbnailFileId: document.thumbnail?.file_id || document.thumb?.file_id || ''
    };
  }
  return null;
}

async function handleMediaMessage(chatId, user, media, userText = '', isReply = false) {
  user.lastSeenAt = Date.now();
  user.chatId = chatId;
  const label = media.kind === 'photo' ? 'картинка' : media.kind === 'animation' ? 'анимация' : 'видео';
  const context = userText ? `; вопрос/подпись: ${userText}` : '';
  remember(user, `[${label}]${context}`);
  const reply = await describeTelegramFile(user, media.fileId, media.kind, userText, media);
  recordConversation(user, 'user', `[${isReply ? `вопрос к ${label}` : label}]${context}`, `${media.kind}-media`);
  recordConversation(user, 'assistant', reply, `${media.kind}-understanding`);
  remember(user, `[${label} understood] ${reply}`);
  user.dialogue ||= {};
  user.dialogue.lastTopic = reply.slice(0, 240);
  refreshMemorySummaries(user);
  await saveUsers();
  await send(chatId, splitTelegram(reply));
  await maybeSendSticker(chatId, user, 0.05, media.kind);
}

async function describeTelegramFile(user, fileId, kind, extraText, options = {}) {
  if (options.fileSize > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    return await describeOversizedVideo(user, options, extraText);
  }

  let fileInfo;
  try {
    fileInfo = await getTelegramFileInfo(fileId, options.mimeType);
  } catch (error) {
    console.error('Telegram media lookup failed:', error.message);
    return 'не смогла скачать этот файл из Telegram. перешли его ещё раз или отправь более короткий фрагмент';
  }
  if ((fileInfo.file.file_size || 0) > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
    return await describeOversizedVideo(user, options, extraText);
  }
  const fileUrl = fileInfo.url;
  const mimeType = options.mimeType || fileInfo.mimeType;

  if (kind === 'photo') {
    const prompt = [
      'Внимательно рассмотри изображение. Коротко объясни, что на нём происходит, прочитай заметный текст и ответь на вопрос пользователя, если он есть.',
      'Не выдумывай детали, которых не видно. Ответь по-русски живо, от лица Kcuni, и оставь возможность продолжить разговор об изображении.',
      `Стиль: ${(styles[user.style] || styles.cute).prompt}`,
      extraText ? `Вопрос или подпись пользователя: ${extraText}` : '',
      user.hadConversationToday ? 'Не здоровайся: вы уже общаетесь сегодня.' : ''
    ].join('\n');

    if (env.GEMINI_API_KEY) {
      const reply = await callGeminiMedia(user, prompt, fileUrl, mimeType.startsWith('image/') ? mimeType : 'image/jpeg');
      return reply ? removeRepeatedGreeting(user, reply, '') : 'вижу фотку, но сейчас не смогла нормально разобрать';
    }

    if (env.OPENAI_API_KEY) {
      const reply = await callVision(user, prompt, fileUrl);
      return reply ? removeRepeatedGreeting(user, reply, '') : 'вижу фотку, но сейчас не смогла нормально разобрать';
    }

    return 'вижу фотку) нормально описывать картинки смогу, когда подключим AI-ключ';
  }

  if (kind === 'voice') {
    if (env.GEMINI_API_KEY) {
      const reply = await understandGeminiVoice(user, fileUrl);
      return reply ? removeRepeatedGreeting(user, reply, '') : 'я получила голосовое, но сейчас не смогла его разобрать';
    }

    if (env.OPENAI_API_KEY) {
      return await transcribeTelegramAudio(user, fileUrl) || 'я получила голосовое, но не смогла его разобрать';
    }

    return 'я получила голосовое, но расшифровку надо подключить через AI-ключ';
  }

  if (kind === 'video_note' || kind === 'video' || kind === 'animation') {
    if (env.GEMINI_API_KEY) {
      const prompt = [
        kind === 'video_note' ? 'Пользователь отправил Telegram-кружок.' : 'Пользователь отправил видео в Telegram.',
        'Посмотри доступное видео целиком: учти и изображение, и звук.',
        'Коротко расскажи, о чём видео, перескажи смысл речи и назови ключевые моменты. Если речи нет, опиши происходящее.',
        extraText ? `Отдельно ответь на вопрос или подпись пользователя: ${extraText}` : '',
        'Если что-то неразборчиво, прямо скажи об этом и не выдумывай. Сохрани тему, чтобы дальше можно было обсуждать это видео.',
        'Не здоровайся и не начинай новый разговор: это продолжение текущего чата.',
        `Стиль: ${(styles[user.style] || styles.cute).prompt}`
      ].join('\n');
      const reply = await callGeminiMedia(user, prompt, fileUrl, mimeType.startsWith('video/') ? mimeType : 'video/mp4');
      return reply ? removeRepeatedGreeting(user, reply, '') : 'вижу видео, но сейчас не смогла нормально разобрать его. попробуй отправить более короткий фрагмент';
    }

    return 'вижу видео, но для просмотра и пересказа нужен подключённый Gemini-ключ';
  }

  return 'получила файл';
}

async function getTelegramFileUrl(fileId) {
  return (await getTelegramFileInfo(fileId)).url;
}

async function describeOversizedVideo(user, options, extraText) {
  let preview = '';
  if (options.thumbnailFileId && (env.GEMINI_API_KEY || env.OPENAI_API_KEY)) {
    try {
      const thumbnail = await getTelegramFileInfo(options.thumbnailFileId, 'image/jpeg');
      const prompt = [
        'Это только превью большого Telegram-видео, а не весь ролик.',
        'Коротко опиши, что видно на кадре. Не утверждай, что знаешь содержание или речь всего видео.',
        extraText ? `Вопрос пользователя: ${extraText}` : '',
        `Стиль: ${(styles[user.style] || styles.cute).prompt}`
      ].join('\n');
      preview = env.GEMINI_API_KEY
        ? await callGeminiMedia(user, prompt, thumbnail.url, thumbnail.mimeType)
        : await callVision(user, prompt, thumbnail.url);
    } catch (error) {
      console.error('Video thumbnail understanding failed:', error.message);
    }
  }
  return [
    'это видео больше 20 МБ, поэтому Telegram не даёт мне скачать его целиком — речь и весь сюжет я сейчас честно не перескажу.',
    preview ? `по превью: ${preview}` : '',
    'пришли короткий или сжатый фрагмент до 20 МБ — тогда посмотрю его со звуком, перескажу и обсудим.'
  ].filter(Boolean).join('\n\n');
}

async function getTelegramFileInfo(fileId, declaredMimeType = '') {
  const file = await tg('getFile', { file_id: fileId });
  const fileBase = env.TELEGRAM_FILE_BASE || 'https://api.telegram.org/file';
  const extension = String(file.file_path || '').split('.').pop()?.toLowerCase();
  const mimeType = declaredMimeType || {
    webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webm: 'video/webm', tgs: 'application/gzip', ogg: 'audio/ogg', mp4: 'video/mp4'
  }[extension] || 'application/octet-stream';
  return { file, mimeType, url: `${fileBase}/bot${BOT_TOKEN}/${file.file_path}` };
}

async function callVision(user, prompt, imageUrl) {
  try {
    const response = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_VISION_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0.7,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }]
      })
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return sanitizeGeneratedText(data.choices?.[0]?.message?.content);
  } catch (error) {
    console.error('Vision error:', error.message);
    return '';
  }
}

async function understandGeminiVoice(user, fileUrl) {
  const transcriptPrompt = [
    'Это голосовое сообщение пользователя в Telegram.',
    'Сначала мысленно расшифруй речь, потом ответь на неё как Kcuni.',
    'Не пиши длинную стену. Ответь по-русски живо, 1-2 короткими сообщениями.',
    `Стиль: ${(styles[user.style] || styles.cute).prompt}`
  ].join('\n');

  const reply = await callGeminiMedia(user, transcriptPrompt, fileUrl, 'audio/ogg');
  if (reply) remember(user, `[voice understood] ${reply}`);
  return reply;
}

async function callGeminiMedia(user, prompt, fileUrl, mimeType) {
  try {
    const mediaResponse = await fetch(fileUrl);
    if (!mediaResponse.ok) throw new Error(`telegram file ${mediaResponse.status}`);
    const contentLength = Number(mediaResponse.headers.get('content-length') || 0);
    if (contentLength > TELEGRAM_DOWNLOAD_LIMIT_BYTES) throw new Error('telegram media exceeds 20 MB');
    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
    if (buffer.length > TELEGRAM_DOWNLOAD_LIMIT_BYTES) throw new Error('telegram media exceeds 20 MB');
    const model = env.GEMINI_MEDIA_MODEL || env.GEMINI_MODEL || 'gemini-flash-lite-latest';
    const geminiBase = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${geminiBase}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Ты Kcuni. Отвечай по-русски живо и коротко. Не звучать как официальный помощник. Не называй себя ИИ, GPT, моделью или ботом без прямого вопроса. Сама поддерживай диалог.' }]
        },
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: buffer.toString('base64') } }
          ]
        }],
        generationConfig: {
          temperature: user.style === 'serious' ? 0.35 : 0.75,
          maxOutputTokens: 700
        }
      })
    });

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return sanitizeGeneratedText(data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''));
  } catch (error) {
    console.error('Gemini media error:', error.message);
    return '';
  }
}

async function transcribeTelegramAudio(user, fileUrl) {
  try {
    const audio = await fetch(fileUrl).then((r) => r.blob());
    const form = new FormData();
    form.append('model', env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
    form.append('file', audio, 'voice.ogg');
    const response = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    const text = data.text?.trim();
    if (!text) return '';
    remember(user, `[voice transcript] ${text}`);
    return generateReply(user, text);
  } catch (error) {
    console.error('Transcription error:', error.message);
    return '';
  }
}
async function handleNews(chatId, user, topic = 'mixed', days = 1) {
  const digest = await buildNewsDigest(user, topic, false, days);
  if (!digest) {
    await send(chatId, 'я сейчас не смогла нормально достать новости');
    return;
  }
  await send(chatId, splitTelegram(digest));
}

async function buildNewsDigest(user, topic = 'mixed', proactive = false, days = 2) {
  const items = await loadNewsItems(days);
  if (!items.length) return '';

  const filtered = filterNewsByTopic(items, topic).slice(0, days >= 7 ? 8 : 5);
  if (!filtered.length) return '';

  const digest = filtered.map((item, index) => {
    const date = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('ru-RU', { timeZone: user.timezone || 'UTC' }) : '';
    return `${index + 1}. ${item.title}${date ? ` (${date})` : ''}${item.link ? `\n${item.link}` : ''}`;
  }).join('\n');
  const topicLabel = {
    interesting: 'интересные и необычные',
    sad: 'грустные или важные',
    war: 'война, конфликты, безопасность',
    tech: 'технологии и ИИ',
    mixed: 'разные'
  }[topic] || 'разные';

  const prompt = [
    proactive
      ? 'Напиши как Kcuni сама. Начни естественно: "я тут прочитала..." или "слушай, увидела...". Не как новостной бот.'
      : 'Сделай короткую дружелюбную выжимку новостей.',
    `Тип новостей: ${topicLabel}.`,
    `Период: последние ${days >= 7 ? '7 дней' : `${days} дн.`}. Не называй старые события новостями этой недели.`,
    `Стиль: ${(styles[user.style] || styles.calm).prompt}`,
    'Если тема тяжёлая, говори мягко, без жести ради жести.',
    'Сохрани короткие ссылки на источники рядом с соответствующими новостями.',
    digest
  ].join('\n\n');

  const ai = await callAi(user, prompt);
  return ai || `я тут собрала ${topicLabel} новости за ${days >= 7 ? 'неделю' : 'последние дни'}:\n${digest}`;
}

async function loadNewsItems(days = 2) {
  const feeds = (env.NEWS_FEEDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!feeds.length) return [];

  const items = [];
  for (const feed of feeds.slice(0, 4)) {
    try {
      const xml = await fetchText(feed);
      items.push(...parseRss(xml).slice(0, days >= 7 ? 30 : 10));
    } catch (error) {
      console.error('News feed failed:', feed, error.message);
    }
  }

  if (!items.length) return [];

  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  const recent = items.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff);
  const unique = [...new Map(recent.map((item) => [item.title.toLowerCase(), item])).values()];
  return unique.sort((left, right) => Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0));
}

function filterNewsByTopic(items, topic) {
  const patterns = {
    interesting: /нов|нашл|учен|исслед|необыч|редк|впервые|интерес|космос|животн|истор|откры/i,
    sad: /погиб|умер|катастроф|авар|пожар|жертв|болез|кризис|потер|бедств/i,
    war: /войн|удар|ракет|дрон|фронт|арм|обстрел|конфликт|переговор|санкц|безопас/i,
    tech: /ии|ai|нейро|openai|google|apple|tesla|робот|технолог|чип|смартфон|софт|модель/i,
    mixed: /./
  };
  const pattern = patterns[topic] || patterns.mixed;
  const matched = items.filter((item) => pattern.test(item.title));
  return matched.length ? matched : items;
}
async function handleWeb(chatId, user, query) {
  if (!query) {
    await send(chatId, 'напиши так: /web что найти');
    return;
  }

  try {
    const result = await webSearch(query);
    if (!result.length) {
      await send(chatId, 'я поискала, но нормального ответа не нашла');
      return;
    }

    const facts = result.map((item, index) => `${index + 1}. ${item.title}${item.text ? ` - ${item.text}` : ''}`).join('\n');
    const prompt = [
      `Запрос: ${query}`,
      'Сделай короткий человеческий ответ по найденной информации.',
      `Стиль: ${styles[user.style].prompt}`,
      'Не выдумывай. Если данные слабые, скажи об этом.',
      '',
      facts
    ].join('\n');

    const ai = await callAi(user, prompt);
    await send(chatId, splitTelegram(ai || `нашла вот что:\n${facts}`));
  } catch (error) {
    console.error('Web search error:', error.message);
    await send(chatId, 'сейчас не смогла выйти в сеть нормально');
  }
}

async function handleUrl(chatId, user, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
  } catch {
    await send(chatId, 'дай нормальную ссылку, начиная с https:// или http://');
    return;
  }

  try {
    const html = await fetchText(url.toString());
    const text = htmlToText(html).slice(0, 8000);
    if (!text || text.length < 80) {
      await send(chatId, 'страница открылась, но полезного текста почти не нашла');
      return;
    }

    const prompt = [
      `Ссылка: ${url.toString()}`,
      'Прочитай текст страницы и сделай короткую человеческую выжимку.',
      `Стиль: ${styles[user.style].prompt}`,
      'Не выдумывай. Если страница выглядит пустой/мусорной, скажи это.',
      '',
      text
    ].join('\n');

    const ai = await callAi(user, prompt);
    await send(chatId, splitTelegram(ai || `прочитала страницу. коротко:\n${text.slice(0, 1200)}`));
  } catch (error) {
    console.error('URL read error:', error.message);
    await send(chatId, 'не смогла открыть эту страницу. может сайт закрыт, блокирует ботов или требует вход');
  }
}

async function webSearch(query) {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');

  const data = JSON.parse(await fetchText(url.toString()));
  const results = [];

  if (data.AbstractText) {
    results.push({ title: data.Heading || query, text: data.AbstractText, url: data.AbstractURL || '' });
  }

  for (const topic of flattenDuckTopics(data.RelatedTopics || [])) {
    if (topic.Text) {
      results.push({ title: topic.Text.split(' - ')[0] || query, text: topic.Text, url: topic.FirstURL || '' });
    }
    if (results.length >= 5) break;
  }

  return results;
}

function flattenDuckTopics(topics) {
  const result = [];
  for (const item of topics) {
    if (item.Topics) result.push(...flattenDuckTopics(item.Topics));
    else result.push(item);
  }
  return result;
}

function hasAnyAiKey() {
  return Boolean(env.GEMINI_API_KEY || env.OPENAI_API_KEY);
}

async function callAi(user, prompt) {
  const provider = (env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase();

  if (provider === 'gemini' && env.GEMINI_API_KEY) {
    const gemini = await callGemini(user, prompt);
    if (gemini) return gemini;
  }

  if (provider === 'openai' && env.OPENAI_API_KEY) {
    const openai = await callOpenAi(user, prompt);
    if (openai) return openai;
  }

  if (provider !== 'gemini' && env.GEMINI_API_KEY) {
    const gemini = await callGemini(user, prompt);
    if (gemini) return gemini;
  }

  if (provider !== 'openai' && env.OPENAI_API_KEY) {
    const openai = await callOpenAi(user, prompt);
    if (openai) return openai;
  }

  return '';
}

async function callGemini(user, prompt) {
  try {
    const model = env.GEMINI_MODEL || 'gemini-flash-lite-latest';
    const geminiBase = env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${geminiBase}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Ты Kcuni. Отвечай по-русски живо, коротко, не как официальный помощник. Держи стиль и текущую сцену. Не называй себя ИИ, GPT, моделью или ботом без прямого вопроса. На грубость можно отвечать соразмерно и с матом, но без реальных угроз. Не объясняй свой тон, не пересказывай запрос и не пиши шаблоны вроде "я поняла тон" или "без пошлости ради пошлости". В ролевой сцене сразу отвечай из образа. При явном перегибе коротко притормози сцену. Сама развивай диалог.' }]
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: user.style === 'serious' ? 0.4 : 0.85,
          maxOutputTokens: 700
        }
      })
    });

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return sanitizeGeneratedText(data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''));
  } catch (error) {
    console.error('Gemini error:', error.message);
    return '';
  }
}

async function callOpenAi(user, prompt) {
  try {
    const response = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: user.style === 'serious' ? 0.4 : 0.85,
        messages: [
          { role: 'system', content: 'You are Kcuni. Answer in Russian by default. Keep a warm human chat persona and the current scene; do not sound like an assistant. Never narrate that you understood or changed the tone, and never repeat the user prompt as a summary. In roleplay, reply directly in character using one concrete scene detail. You may answer a direct insult with proportionate profanity but never a real threat. If coercive repetition becomes excessive, briefly de-escalate and continue normally. Do not call yourself AI, GPT, a model, or a bot unless directly asked. Move the dialogue forward yourself.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return sanitizeGeneratedText(data.choices?.[0]?.message?.content);
  } catch (error) {
    console.error('OpenAI error:', error.message);
    return '';
  }
}

function getUser(chatId, from) {
  const key = String(chatId);
  users[key] ||= {
    id: chatId,
    chatId,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'user',
    style: 'calm',
    memory: [],
    stickers: [],
    proactive: true,
    timezone: DEFAULT_TIMEZONE,
    proactiveSchedule: [...DEFAULT_PROACTIVE_SCHEDULE],
    proactiveTiming: 'auto',
    sentNewsLinks: [],
    conversationLog: [],
    memorySummaries: { daily: [], weekly: [], monthly: [] },
    lastSeenAt: 0
  };
  normalizeUser(users[key]);
  return users[key];
}

function normalizeUser(user) {
  user.memory ||= [];
  user.stickers ||= [];
  user.conversationLog ||= [];
  user.memorySummaries ||= { daily: [], weekly: [], monthly: [] };
  user.memorySummaries.daily ||= [];
  user.memorySummaries.weekly ||= [];
  user.memorySummaries.monthly ||= [];
  user.proactiveSchedule ||= [...DEFAULT_PROACTIVE_SCHEDULE];
  user.proactiveTiming ||= schedulesEqual(user.proactiveSchedule, DEFAULT_PROACTIVE_SCHEDULE) ? 'auto' : 'fixed';
  user.sentNewsLinks ||= [];
  user.responsePreferences ||= { avoid: [], liked: [] };
  user.responsePreferences.avoid ||= [];
  user.responsePreferences.liked ||= [];
  user.reminders ||= [];
  if (!user.timezone && !Number.isFinite(user.timezoneOffsetMinutes)) user.timezone = DEFAULT_TIMEZONE;
  return user;
}

function recordConversation(user, role, content, type = 'text') {
  const clean = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!clean || clean.startsWith('/')) return;
  user.conversationLog ||= [];
  user.conversationLog.push({ role, content: clean, type, at: new Date().toISOString() });
  const cutoff = Date.now() - 62 * 24 * 60 * 60 * 1000;
  user.conversationLog = user.conversationLog
    .filter((entry) => Date.parse(entry.at) >= cutoff)
    .slice(-1200);
}

function refreshMemorySummaries(user) {
  normalizeUser(user);
  const byDay = new Map();
  for (const entry of user.conversationLog) {
    const key = localDateKey(user, Date.parse(entry.at));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(entry);
  }

  const daily = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-45).map(([key, entries]) => ({
    key,
    summary: summarizeEntries(entries, 650)
  }));

  const byWeek = new Map();
  const byMonth = new Map();
  for (const day of daily) {
    const week = weekKey(day.key);
    const month = day.key.slice(0, 7);
    if (!byWeek.has(week)) byWeek.set(week, []);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byWeek.get(week).push(day);
    byMonth.get(month).push(day);
  }

  user.memorySummaries = {
    daily,
    weekly: [...byWeek.entries()].slice(-10).map(([key, days]) => ({
      key,
      summary: summarizeSummaryRows(days, 1100)
    })),
    monthly: [...byMonth.entries()].slice(-6).map(([key, days]) => ({
      key,
      summary: summarizeSummaryRows(days, 1500)
    }))
  };
}

function summarizeEntries(entries, limit) {
  const lines = entries.slice(-24).map((entry) => {
    const speaker = entry.role === 'assistant' ? 'Kcuni' : 'пользователь';
    return `${speaker}: ${entry.content}`;
  });
  return compactText(lines.join(' | '), limit);
}

function summarizeSummaryRows(rows, limit) {
  return compactText(rows.map((row) => `${row.key}: ${row.summary}`).join(' || '), limit);
}

function compactText(text, limit) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`;
}

function buildMemoryContext(user) {
  normalizeUser(user);
  const recent = user.conversationLog.slice(-10)
    .map((entry) => `${entry.role === 'assistant' ? 'Kcuni' : 'пользователь'}: ${compactText(entry.content, 320)}`)
    .join('\n');
  const daily = user.memorySummaries.daily.slice(-7).map((row) => `${row.key}: ${compactText(row.summary, 260)}`).join('\n');
  const weekly = user.memorySummaries.weekly.slice(-4).map((row) => `${row.key}: ${compactText(row.summary, 380)}`).join('\n');
  const monthly = user.memorySummaries.monthly.slice(-2).map((row) => `${row.key}: ${compactText(row.summary, 500)}`).join('\n');
  const facts = user.memory.slice(-12).join('\n');
  return [
    `Факты:\n${facts || 'нет'}`,
    `Последние реплики:\n${recent || 'нет'}`,
    `Итоги по дням:\n${daily || 'нет'}`,
    `Итоги по неделям:\n${weekly || 'нет'}`,
    `Итоги по месяцам:\n${monthly || 'нет'}`
  ].join('\n\n');
}

function buildMemoryReport(user) {
  normalizeUser(user);
  const day = user.memorySummaries.daily.at(-1);
  const week = user.memorySummaries.weekly.at(-1);
  const month = user.memorySummaries.monthly.at(-1);
  if (!day && !week && !month && !user.memory.length) return 'пока почти ничего не помню';
  return [
    user.location?.label ? `ты живёшь: ${user.location.label}; пояс: ${formatTimezone(user)}` : '',
    day ? `последний день (${day.key}): ${compactText(day.summary, 450)}` : '',
    week ? `неделя (${week.key}): ${compactText(week.summary, 550)}` : '',
    month ? `месяц (${month.key}): ${compactText(month.summary, 650)}` : ''
  ].filter(Boolean).join('\n\n');
}

function weekKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function parseSchedule(value) {
  return [...new Set(String(value || '').split(/[;,\s]+/).map((item) => {
    const match = item.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }).filter(Boolean))].sort();
}

function getUserSchedule(user, timestamp = Date.now()) {
  if (user.proactiveTiming !== 'fixed') return buildAutomaticSchedule(user, timestamp);
  const schedule = parseSchedule(user.proactiveSchedule?.join(',') || '');
  return schedule.length ? schedule : [...DEFAULT_PROACTIVE_SCHEDULE];
}

function buildAutomaticSchedule(user, timestamp = Date.now()) {
  const dateKey = localDateKey(user, timestamp);
  const digest = createHash('sha256').update(`${user.id || user.chatId || 'kcuni'}:${dateKey}`).digest();
  const preference = user.preferences?.proactive;
  const windows = preference === 'less'
    ? [[12 * 60, 21 * 60 + 30]]
    : preference === 'more'
      ? [[10 * 60 + 30, 13 * 60 + 30], [15 * 60 + 30, 19 * 60], [20 * 60 + 30, 23 * 60 + 20]]
      : [[11 * 60, 15 * 60], [18 * 60, 23 * 60 + 15]];
  return windows.map(([start, end], index) => {
    const minute = start + (digest[index] % (end - start + 1));
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  }).sort();
}

function schedulesEqual(left, right) {
  return parseSchedule(Array.isArray(left) ? left.join(',') : left).join(',') === parseSchedule(Array.isArray(right) ? right.join(',') : right).join(',');
}

function parseReminderRequest(user, text, now = Date.now()) {
  const normalized = normalizeText(text);
  if (!/(напиши мне|напомни мне|напомни|пни меня)/.test(normalized)) return null;
  const timeText = String(text).toLowerCase().replace(/ё/g, 'е');

  const relative = normalized.match(/через\s+(?:(минут\S*|час\S*)\s+)?(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\s*(минут\S*|мин\S*|час\S*)?/i);
  if (relative) {
    const unit = `${relative[1] || ''} ${relative[4] || ''}`;
    const multiplier = /час/.test(unit) ? 60 : 1;
    const minimum = Math.max(1, Number(relative[2]) * multiplier);
    const maximum = Math.max(minimum, Number(relative[3] || relative[2]) * multiplier);
    const selectedMinutes = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    return createReminder(text, now + selectedMinutes * REMINDER_MINUTE_MS, now + maximum * REMINDER_MINUTE_MS, {
      kind: 'relative', minimumMinutes: minimum, maximumMinutes: maximum, selectedMinutes
    });
  }

  const absolute = timeText.match(/(?:(сегодня|завтра)\s+)?(?:в\s*)?(\d{1,2})[:.](\d{2})(?:\s*[-–—]\s*(?:(\d{1,2})[:.])?(\d{2}))?/i);
  if (!absolute) return null;
  const startHour = Number(absolute[2]);
  const startMinute = Number(absolute[3]);
  const endHour = Number(absolute[4] || startHour);
  const endMinute = Number(absolute[5] || startMinute);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null;

  const today = localDateKey(user, now);
  let dateKey = absolute[1] === 'завтра' ? addLocalDays(today, 1) : today;
  let startAt = localDateTimeToTimestamp(user, dateKey, startHour, startMinute);
  let endAt = localDateTimeToTimestamp(user, dateKey, endHour, endMinute);
  if (endAt < startAt) endAt = startAt;
  if (!absolute[1] && endAt < now) {
    dateKey = addLocalDays(today, 1);
    startAt = localDateTimeToTimestamp(user, dateKey, startHour, startMinute);
    endAt = localDateTimeToTimestamp(user, dateKey, endHour, endMinute);
    if (endAt < startAt) endAt = startAt;
  }
  if (endAt < now) return null;
  const selectedAt = startAt + Math.floor(Math.random() * (endAt - startAt + 1));
  return createReminder(text, Math.max(now + 1000, selectedAt), endAt, {
    kind: 'absolute', dateKey, start: `${padTime(startHour)}:${padTime(startMinute)}`, end: `${padTime(endHour)}:${padTime(endMinute)}`
  });
}

function createReminder(request, dueAt, windowEndAt, details) {
  return {
    id: createHash('sha256').update(`${Date.now()}-${Math.random()}-${request}`).digest('hex').slice(0, 16),
    request: compactText(request, 300),
    createdAt: Date.now(),
    dueAt: Math.round(dueAt),
    windowEndAt: Math.round(windowEndAt),
    ...details
  };
}

function reminderConfirmation(user, reminder) {
  if (reminder.kind === 'relative') {
    const range = reminder.minimumMinutes === reminder.maximumMinutes
      ? `через ${reminder.selectedMinutes} мин.`
      : `в промежутке ${reminder.minimumMinutes}–${reminder.maximumMinutes} мин. (таймер на ${reminder.selectedMinutes} мин.)`;
    return `поставила таймер: напишу ${range}`;
  }
  const window = reminder.start === reminder.end ? reminder.start : `${reminder.start}–${reminder.end}`;
  return `запомнила. напишу ${reminder.dateKey} в ${window} (${formatTimezone(user)})`;
}

function buildReminderReport(user, now = Date.now()) {
  normalizeUser(user);
  const pending = user.reminders.filter((reminder) => !reminder.sentAt && reminder.dueAt > now - 24 * 60 * 60 * 1000).sort((left, right) => left.dueAt - right.dueAt);
  if (!pending.length) return 'активных таймеров нет. напиши: «напиши мне через 15–20 минут»';
  return [
    'активные напоминания:',
    ...pending.slice(0, 10).map((reminder, index) => `${index + 1}. ${formatUserDateTime(user, reminder.dueAt)} — ${compactText(reminder.request, 120)}`),
    'отменить все: /reminders clear'
  ].join('\n');
}

function localDateTimeToTimestamp(user, dateKey, hour, minute) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  if (!user.timezone) return desired - Number(user.timezoneOffsetMinutes || 0) * 60_000;
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getUserDateParts(user, guess);
    const [actualYear, actualMonth, actualDay] = parts.dateKey.split('-').map(Number);
    const actual = Date.UTC(actualYear, actualMonth - 1, actualDay, parts.hour, parts.minute);
    guess += desired - actual;
  }
  return guess;
}

function addLocalDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatUserDateTime(user, timestamp) {
  const parts = getUserDateParts(user, timestamp);
  return `${parts.dateKey} ${padTime(parts.hour)}:${padTime(parts.minute)}`;
}

function padTime(value) {
  return String(value).padStart(2, '0');
}

function findDueScheduleSlot(user, timestamp) {
  const parts = getUserDateParts(user, timestamp);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const windowMinutes = Math.max(5, Number(env.PROACTIVE_SLOT_WINDOW_MINUTES || 15));
  for (const slot of getUserSchedule(user, timestamp)) {
    const [hour, minute] = slot.split(':').map(Number);
    const delta = currentMinutes - (hour * 60 + minute);
    if (delta >= 0 && delta < windowMinutes) return { slot, id: `${parts.dateKey}/${slot}` };
  }
  return null;
}

function parseTimezone(value) {
  const raw = String(value || '').trim();
  const offset = raw.match(/^(?:utc\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const minutes = (Number(offset[2]) * 60 + Number(offset[3] || 0)) * (offset[1] === '-' ? -1 : 1);
    if (minutes >= -12 * 60 && minutes <= 14 * 60) return { timezone: '', timezoneOffsetMinutes: minutes };
  }
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: raw }).format();
    return { timezone: raw, timezoneOffsetMinutes: undefined };
  } catch {
    return null;
  }
}

function getUserDateParts(user, timestamp = Date.now()) {
  if (user.timezone) {
    try {
      const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: user.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(new Date(timestamp)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return {
        dateKey: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour), minute: Number(values.minute)
      };
    } catch {
      // Fall through to a fixed offset.
    }
  }
  const shifted = new Date(timestamp + Number(user.timezoneOffsetMinutes || 0) * 60000);
  return { dateKey: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

function localDateKey(user, timestamp = Date.now()) {
  return getUserDateParts(user, timestamp).dateKey;
}

function formatUserTime(user, timestamp = Date.now()) {
  const parts = getUserDateParts(user, timestamp);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function formatTimezone(user) {
  if (user.timezone) return user.timezone;
  const minutes = Number(user.timezoneOffsetMinutes || 0);
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function longitudeToOffsetMinutes(longitude) {
  return clamp(Math.round(Number(longitude) / 15), -12, 14) * 60;
}

const CITY_TIMEZONES = {
  'минск': 'Europe/Minsk', 'минске': 'Europe/Minsk', 'москва': 'Europe/Moscow', 'москве': 'Europe/Moscow', 'питер': 'Europe/Moscow', 'питере': 'Europe/Moscow', 'санкт-петербург': 'Europe/Moscow',
  'киев': 'Europe/Kyiv', 'киеве': 'Europe/Kyiv', 'київ': 'Europe/Kyiv', 'варшава': 'Europe/Warsaw', 'варшаве': 'Europe/Warsaw', 'берлин': 'Europe/Berlin', 'берлине': 'Europe/Berlin',
  'лондон': 'Europe/London', 'париж': 'Europe/Paris', 'нью-йорк': 'America/New_York', 'лос-анджелес': 'America/Los_Angeles',
  'тбилиси': 'Asia/Tbilisi', 'ереван': 'Asia/Yerevan', 'алматы': 'Asia/Almaty', 'астана': 'Asia/Almaty',
  'ташкент': 'Asia/Tashkent', 'дубай': 'Asia/Dubai', 'токио': 'Asia/Tokyo'
};

function setUserCity(user, city) {
  const clean = String(city || '').trim().replace(/[.!?]+$/, '').slice(0, 80);
  if (!clean) return;
  user.location = { ...(user.location || {}), label: clean };
  const timezone = CITY_TIMEZONES[normalizeText(clean)];
  if (timezone) {
    user.timezone = timezone;
    user.timezoneOffsetMinutes = undefined;
  }
}

function detectCityStatement(text) {
  const match = String(text).match(/(?:я\s+живу\s+в|мой\s+город\s*[-—:]?|я\s+из)\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2}?)(?=\s+(?:и|но|а)\s+|[,.!?]|$)/iu);
  return match?.[1]?.trim() || '';
}

function isGreetingRequest(text) {
  return /(?:поздоровайся|скажи\s+(?:мне\s+)?привет|пожелай\s+доброго\s+дня)/i.test(text);
}

function removeRepeatedGreeting(user, reply, sourceText) {
  if (!user.hadConversationToday || isGreetingRequest(sourceText)) return reply;
  const stripped = String(reply).replace(/^\s*(?:привет(?:ик)?|здравствуй(?:те)?|здорово|хай|хей)[,!.)\s—-]*/iu, '').trim();
  return stripped || reply;
}

function remember(user, text) {
  if (text.startsWith('/')) return;
  const clean = text.replace(/\s+/g, ' ').slice(0, 240);
  if (clean.length < 4) return;
  user.memory.push(`${new Date().toISOString().slice(0, 10)}: ${clean}`);
  user.memory = user.memory.slice(-40);
}

async function tg(method, payload) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || method);
  return data.result;
}

async function send(chatId, textOrMessages) {
  const messages = Array.isArray(textOrMessages) ? textOrMessages : [textOrMessages];
  const prepared = messages.filter(Boolean).slice(0, MAX_MESSAGES_PER_REPLY);
  for (let index = 0; index < prepared.length; index += 1) {
    const text = prepared[index];
    await humanTypingDelay(chatId, text, index);
    await tg('sendMessage', { chat_id: chatId, text });
    await sleep(380);
  }
}

async function sendPhoto(chatId, photo, caption = '') {
  try {
    await showChatAction(chatId, 'upload_photo');
    await sleep(1200 + Math.floor(Math.random() * 900));
    await tg('sendPhoto', { chat_id: chatId, photo, caption });
    await sleep(380);
    return true;
  } catch (error) {
    console.error('Photo send failed:', error.message);
    return false;
  }
}

async function sendVideo(chatId, video, caption = '') {
  try {
    await showChatAction(chatId, 'upload_video');
    await sleep(1800 + Math.floor(Math.random() * 1400));
    await tg('sendVideo', { chat_id: chatId, video, caption, supports_streaming: true });
    await sleep(380);
    return true;
  } catch (error) {
    console.error('Video send failed:', error.message);
    return false;
  }
}

async function humanTypingDelay(chatId, text, messageIndex = 0) {
  const delay = calculateTypingDelay(text, messageIndex);
  const startedAt = Date.now();

  while (Date.now() - startedAt < delay) {
    await showChatAction(chatId, 'typing');
    await sleep(Math.min(4200, delay - (Date.now() - startedAt)));
  }
}

function calculateTypingDelay(text, messageIndex = 0) {
  const length = String(text).length;
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  const base = Number(env.TYPING_BASE_MS || 1800);
  const perChar = Number(env.TYPING_PER_CHAR_MS || 28);
  const perWord = Number(env.TYPING_PER_WORD_MS || 120);
  const jitter = Math.floor(Math.random() * 900);
  const raw = base + length * perChar + words * perWord + jitter + messageIndex * 900;

  const min = Number(env.TYPING_MIN_MS || 2000);
  const max = Number(env.TYPING_MAX_MS || 10000);

  if (length <= 18) return clamp(1400 + jitter, 1000, 2600);
  if (length <= 55) return clamp(raw, min, 5200);
  return clamp(raw, min, max);
}

async function showChatAction(chatId, action) {
  try {
    await tg('sendChatAction', { chat_id: chatId, action });
  } catch (error) {
    console.error('Chat action failed:', error.message);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function splitTelegram(text) {
  return String(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.length > 700 ? line.match(/.{1,700}/g) : [line])
    .slice(0, MAX_MESSAGES_PER_REPLY);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveUsers() {
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function loadEnv() {
  const result = { ...process.env };
  const envPath = new URL('../.env', import.meta.url);
  if (!existsSync(envPath)) return result;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    result[key] = value;
  }
  return result;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KcuniBot/1.0)',
      Accept: 'text/html,application/xhtml+xml,application/xml,text/plain,application/rss+xml;q=0.9,*/*;q=0.8'
    }
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/text|html|xml|json|rss/i.test(contentType)) throw new Error(`unsupported content type: ${contentType}`);
  return response.text();
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|header|footer|li|h1|h2|h3|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseRss(xml) {
  const blocks = [
    ...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)
  ].map((match) => match[1]);
  return blocks
    .map((block) => {
      const title = readXmlTag(block, 'title');
      const published = readXmlTag(block, 'pubDate') || readXmlTag(block, 'published') || readXmlTag(block, 'updated');
      const linkTag = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] || readXmlTag(block, 'link');
      const summary = readXmlTag(block, 'description') || readXmlTag(block, 'summary') || readXmlTag(block, 'content');
      const parsedDate = Date.parse(published);
      return {
        title: decodeXml(title),
        link: decodeXml(linkTag),
        summary: compactText(htmlToText(decodeXml(summary)), 1800),
        publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : ''
      };
    })
    .filter((item) => item.title && !/реклама|advert|sponsor/i.test(item.title));
}

function readXmlTag(block, tag) {
  const match = String(block).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return String(match?.[1] || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
