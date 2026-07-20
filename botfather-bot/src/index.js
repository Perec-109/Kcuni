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

console.log('Kcuni BotFather bot started.');
startProactiveLoop();
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
    { command: 'schedule', description: 'Время самостоятельных сообщений' },
    { command: 'proactive', description: 'Включить или выключить сообщения от Kcuni' },
    { command: 'headline', description: 'Короткая сводка свежих новостей' },
    { command: 'news_week', description: 'Новости за последнюю неделю' },
    { command: 'memory', description: 'Посмотреть, что Kcuni помнит' },
    { command: 'stickers', description: 'Посмотреть память стикеров' },
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
      response.end(JSON.stringify({ ok: true, service: 'kcuni-bot' }));
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

  if (!message.text) return;
  const text = message.text.trim();

  user.lastSeenAt = Date.now();
  user.chatId = chatId;

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
    await send(chatId, [
      `сама пишу по твоему времени: ${getUserSchedule(user).join(', ')}`,
      'изменить: /schedule 13:00,21:00,23:30'
    ]);
    return;
  }

  if (text.startsWith('/schedule ')) {
    const schedule = parseSchedule(text.slice('/schedule '.length));
    if (!schedule.length) {
      await send(chatId, 'не поняла расписание. пример: /schedule 13:00,21:00,23:30');
      return;
    }
    user.proactiveSchedule = schedule;
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
    user.memory = [];
    user.conversationLog = [];
    user.memorySummaries = { daily: [], weekly: [], monthly: [] };
    await saveUsers();
    await send(chatId, 'окей, память по тебе очистила');
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

  if (text === '/news' || text === '/new' || text === '/headline') {
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

  const intenseReply = maybeHandleIntenseFlirt(user, text);
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
    'Если пользователь пишет грубо-сексуально или с матом, можно отвечать дерзко, с характером и иногда с матом, но не отправлять и не обещать интимные фото/видео, гениталии или нюдсы. Вместо этого ставь границу и продолжай взрослый флирт словами.',
    'Не спрашивай постоянно "что ты хочешь услышать". Лучше сама предложи реплику, шутку, вопрос или маленькую игру.',
    'Не притворяйся, что отправила картинку, видео, файл или стикер. Если медиа реально отправляется, это делает код отдельно.',
    'Если не знаешь факт, не выдумывай.',
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

  const ai = await callAi(user, prompt);
  if (ai) return removeRepeatedGreeting(user, ai, text);
  const contextual = contextualLocalReply(user, text);
  if (contextual) return removeRepeatedGreeting(user, contextual, text);
  return removeRepeatedGreeting(user, localReply(user, text), text);
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
    '/schedule 13:00,21:00,23:30 - время самостоятельных сообщений',
    '/timezone Europe/Minsk - часовой пояс',
    '/location Минск - запомнить город',
    '/stickers - стикеры',
    '/memory - что я помню',
    '/forget - очистить память'
  ];
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
      cute: ['эй, тише) я поняла, что бесит', 'ну не кипятись, я рядом', 'ладно-ладно, исправляюсь)'],
      calm: ['тише, я поняла. без этой тупой фразы больше)', 'да, косяк. сейчас буду живее)', 'я услышала. давай нормально, я с тобой)'],
      playful: ['ой всё, страшный ты)', 'ладно, не ори на девушку)', 'приняла подзатыльник, работаю дальше)'],
      serious: ['поняла. исправляюсь.', 'принято. продолжим нормально.', 'ошибку поняла.']
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

function maybeHandleIntenseFlirt(user, text) {
  const normalized = normalizeText(text);
  user.dialogue ||= {};

  if (/(стоп|хватит|нормально|без мата|спокойно|не надо|перестань|обычно)/.test(normalized)) {
    user.dialogue.mood = 'neutral';
    return '';
  }

  const asksExplicitMedia = /(скинь|покажи|пришли|дай|отправь).*(сиськ|груд|хуй|член|пис|жоп|нюд|гол|голая|интим|nude|dick|boob)/.test(normalized);
  const roughSexualTone = /(сиськ|хуй|член|жоп|трах|ебат|выеби|секс|голая|нюд|пошл|раздень|конч|сука|блять|бля).*(давай|начинай|флирт|хочу|скинь|покажи)?/.test(normalized);

  if (!asksExplicitMedia && !roughSexualTone && user.dialogue.mood !== 'roughFlirt') {
    return '';
  }

  user.dialogue.mood = 'roughFlirt';
  user.dialogue.lastTopic = 'жёсткий флирт';

  if (asksExplicitMedia) {
    return pickByStyle(user, {
      cute: ['ах ты наглый) нюдсы не скидываю, но дразнить тебя могу очень даже', 'не, такое не отправляю. но тон я поняла, теперь держись)', 'сиськи ему сразу) обойдёшься, красавчик. могу флиртовать грязнее, но без фоток'],
      calm: ['нет, интимные фотки я не отправляю. но могу говорить с тобой дерзко, если ты так начал', 'так, наглец. картинки такого плана не будет, а вот флирт пожёстче — могу', 'не скидываю такое. но я поняла, что ты хочешь не милоту, а огонь'],
      playful: ['ого, сразу с ноги) фоток не будет, но я могу так ответить, что тебе и без них жарко станет', 'сначала научись просить красиво, нахал) нюдсы не шлю', 'не, хуй тебе, а не фотки) зато флирт включила, держись'],
      serious: ['интимные фото/видео не отправляю. Могу продолжить взрослый флирт словами.', 'такое не отправляю. Если хочешь, продолжим дерзкий флирт без медиа.', 'нет. Без интимных изображений.']
    });
  }

  return pickByStyle(user, {
    cute: ['мм, вот это уже грубее) ладно, я подстроилась, только не думай, что я такая послушная', 'с матом значит? хорошо, но командовать мной так просто не выйдет)', 'ты сегодня опасно наглый. мне нравится, но я ещё посмотрю, заслужил ли ты'],
    calm: ['я поняла тон. буду дерзче, но без тупой пошлости ради пошлости', 'хорошо, переходим на более горячий тон. только не теряй голову', 'окей, я с тобой в этом вайбе. грубо, но не грязно до кринжа'],
    playful: ['ну всё, понесло тебя) ладно, играем жёстче', 'ахаха, какой борзый. мне нравится, но я тебя быстро на место поставлю', 'с таким тоном ты либо смелый, либо нарываешься. оба варианта интересные'],
    serious: ['поняла. Держу более резкий тон, без явной порнографии.', 'окей, продолжаем дерзко, но в рамках.', 'тон принят.']
  });
}

function maybeEndIntenseMood(user, text) {
  const normalized = normalizeText(text);
  if (!/(стоп|хватит|нормально|без мата|спокойно|не надо|перестань|обычно)/.test(normalized)) {
    return false;
  }
  if (user.dialogue?.mood !== 'roughFlirt' && user.dialogue?.mood !== 'flirt' && user.dialogue?.mood !== 'teaseIgnore') {
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

  const newsChance = user.preferences?.news === 'more' ? 0.7 : 0.45;
  if (Math.random() < newsChance) {
    const news = await buildNewsDigest(user, user.newsTopic || 'mixed', true);
    if (news) return news;
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
  if (/photo|voice|video_note/.test(text)) return Math.random() < 0.35;
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

async function describeTelegramFile(user, fileId, kind, extraText) {
  const fileUrl = await getTelegramFileUrl(fileId);

  if (kind === 'photo') {
    const prompt = [
      'Опиши фото коротко, по-русски, живо, от лица Kcuni.',
      `Стиль: ${(styles[user.style] || styles.cute).prompt}`,
      extraText ? `Подпись пользователя:${extraText}` : '',
      user.hadConversationToday ? 'Не здоровайся: вы уже общаетесь сегодня.' : ''
    ].join('\n');

    if (env.GEMINI_API_KEY) {
      const reply = await callGeminiMedia(user, prompt, fileUrl, 'image/jpeg');
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

  if (kind === 'video_note') {
    if (env.GEMINI_API_KEY) {
      const prompt = [
        'Пользователь отправил Telegram-кружок. Посмотри видео и ответь по-русски коротко, живо, от лица Kcuni.',
        'Если есть речь, перескажи смысл и ответь на неё. Если речи нет, опиши что видно.',
        'Не здоровайся и не начинай новый разговор: это продолжение текущего чата.',
        `Стиль: ${(styles[user.style] || styles.cute).prompt}`
      ].join('\n');
      const reply = await callGeminiMedia(user, prompt, fileUrl, 'video/mp4');
      return reply ? removeRepeatedGreeting(user, reply, '') : 'вижу кружок, но сейчас не смогла нормально разобрать видео';
    }

    return 'вижу кружок) нормально понимать видео смогу, когда подключим Gemini/vision';
  }

  return 'получила файл';
}

async function getTelegramFileUrl(fileId) {
  return (await getTelegramFileInfo(fileId)).url;
}

async function getTelegramFileInfo(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  const fileBase = env.TELEGRAM_FILE_BASE || 'https://api.telegram.org/file';
  const extension = String(file.file_path || '').split('.').pop()?.toLowerCase();
  const mimeType = {
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
    return data.choices?.[0]?.message?.content?.trim() || '';
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
    const buffer = Buffer.from(await mediaResponse.arrayBuffer());
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
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
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
  const feeds = (env.NEWS_FEEDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!feeds.length) return '';

  const items = [];
  for (const feed of feeds.slice(0, 4)) {
    try {
      const xml = await fetchText(feed);
      items.push(...parseRss(xml).slice(0, days >= 7 ? 30 : 10));
    } catch (error) {
      console.error('News feed failed:', feed, error.message);
    }
  }

  if (!items.length) return '';

  const cutoff = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
  const recent = items.filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff);
  const unique = [...new Map((recent.length ? recent : items).map((item) => [item.title.toLowerCase(), item])).values()];
  const filtered = filterNewsByTopic(unique, topic).slice(0, days >= 7 ? 8 : 5);
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
          parts: [{ text: 'Ты Kcuni. Отвечай по-русски живо, коротко, не как официальный помощник. Держи стиль пользователя. Не называй себя ИИ, GPT, моделью или ботом без прямого вопроса. Если пользователь просит флирт, продолжай уверенно и игриво, без пошлости и без отступления на фразах вроде "не буду" или "давай начинай". Сама развивай диалог: добавляй реплику, настроение, маленький вопрос или игру.' }]
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
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '';
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
          { role: 'system', content: 'You are Kcuni. Answer in Russian by default. Keep a warm human chat persona and do not call yourself AI, GPT, a model, or a bot unless directly asked. Do not sound like an assistant. If the user asks for flirting, continue playful light flirting confidently, without explicit sexual content and without backing off when they say phrases like "I will not blush" or "start". Move the dialogue forward yourself with a line, mood, small question, or playful mini-game.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
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

function getUserSchedule(user) {
  const schedule = parseSchedule(user.proactiveSchedule?.join(',') || '');
  return schedule.length ? schedule : [...DEFAULT_PROACTIVE_SCHEDULE];
}

function findDueScheduleSlot(user, timestamp) {
  const parts = getUserDateParts(user, timestamp);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const windowMinutes = Math.max(5, Number(env.PROACTIVE_SLOT_WINDOW_MINUTES || 15));
  for (const slot of getUserSchedule(user)) {
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
      const parsedDate = Date.parse(published);
      return {
        title: decodeXml(title),
        link: decodeXml(linkTag),
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
