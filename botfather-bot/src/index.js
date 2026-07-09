import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

const env = loadEnv();
const BOT_TOKEN = env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing. Copy .env.example to .env and paste BotFather token.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DATA_DIR = new URL('../data/', import.meta.url);
const USERS_FILE = new URL('../data/users.json', import.meta.url);
const MAX_MESSAGES_PER_REPLY = Number(env.MAX_MESSAGES_PER_REPLY || 2);

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

while (true) {
  try {
    const updates = await tg('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message']
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message) {
        await handleMessage(update.message);
      }
    }
  } catch (error) {
    console.error('Polling error:', error.message);
    await sleep(2500);
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const user = getUser(chatId, message.from);

  if (message.sticker?.file_id) {
    user.stickers ||= [];
    if (!user.stickers.includes(message.sticker.file_id)) {
      user.stickers.push(message.sticker.file_id);
      user.stickers = user.stickers.slice(-30);
      await saveUsers();
    }
    await maybeSendSticker(chatId, user, 0.65, 'стикер');
    await send(chatId, localReply(user, 'стикер'));
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
    await send(chatId, splitTelegram(reply));
    await maybeSendSticker(chatId, user, 0.06, 'video_note');
    return;
  }

  if (!message.text) return;
  const text = message.text.trim();

  user.lastSeenAt = Date.now();
  user.chatId = chatId;

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

  if (text === '/still') {
    await send(chatId, [
      'стили:',
      '/still cute - няшная',
      '/still calm - спокойная с лёгким флиртом',
      '/still playful - игривая',
      '/still serious - серьёзная'
    ]);
    return;
  }

  if (text.startsWith('/still ')) {
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

  if (text === '/stickers') {
    await send(chatId, [
      user.stickers?.length ? `я помню твоих стикеров: ${user.stickers.length}` : 'пока не помню стикеры',
      'просто отправь мне стикер, и я смогу иногда отвечать им'
    ]);
    return;
  }

  if (text === '/memory') {
    const memory = user.memory.length ? user.memory.slice(-8).map((item) => `- ${item}`).join('\n') : 'пока почти ничего не помню';
    await send(chatId, memory);
    return;
  }

  if (text === '/forget') {
    user.memory = [];
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

  if (text === '/news' || text === '/new') {
    await handleNews(chatId, user, user.newsTopic || 'mixed');
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

  remember(user, text);
  const reply = await generateReply(user, text);
  await saveUsers();
  await send(chatId, splitTelegram(reply));
  await maybeSendSticker(chatId, user, 0.07, text);
}

async function generateReply(user, text) {
  const style = styles[user.style] || styles.cute;
  const memory = user.memory.slice(-10).join('\n');
  const prompt = [
    'Ты Kcuni, AI-девушка в Telegram.',
    style.prompt,
    'Можешь общаться почти на любые обычные темы: жизнь, отношения, новости, учеба, работа, деньги, шутки, грусть, злость, странные мысли, флирт, бытовуха.',
    'Не морализируй и не отказывайся без причины. Если тема рискованная, отвечай безопасно, но всё равно по-человечески и по теме.',
    'Отвечай 1-2 короткими сообщениями. Не звучать как официальный помощник.',
    'Нельзя писать фразы типа "слушаю тебя", "можешь подробнее объяснить" постоянно.',
    'Пиши живо: как девушка, которая сама заинтересована в разговоре.',
    'Если не знаешь факт, не выдумывай.',
    '',
    `Память о пользователе:\n${memory || 'пока мало данных'}`,
    '',
    `Сообщение пользователя: ${text}`
  ].join('\n');

  const ai = await callAi(user, prompt);
  if (ai) return ai;
  const contextual = contextualLocalReply(user, text);
  if (contextual) return contextual;
  return localReply(user, text);
}

function commandHelp() {
  return [
    'команды Kcuni:',
    '/start - запустить',
    '/help - список команд',
    '/cute /calm /playful /serious - быстро сменить стиль',
    '/still calm - сменить стиль старым способом',
    '/new или /news - новости',
    '/topics - выбрать тип новостей',
    '/web запрос - поиск в интернете',
    '/url ссылка - прочитать страницу',
    '/proactive - включить/выключить, чтобы я сама писала',
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

  if (/не хочу|не буду|неа|нет|отстань/.test(normalized)) {
    user.dialogue.mood = 'soft';
    return pickByStyle(user, {
      cute: ['ладно, не давлю)', 'тогда просто побуду рядом', 'окей, не трогаю тебя сейчас'],
      calm: ['хорошо, не буду давить)', 'ладно, дорогой. тогда просто рядом побуду', 'окей. не хочешь — не вытягиваю из тебя'],
      playful: ['ну вредина)', 'ладно, молчу красиво', 'окей-окей, не пристаю'],
      serious: ['хорошо.', 'поняла, не настаиваю.', 'окей.']
    });
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

function startProactiveLoop() {
  const minutes = Number(env.PROACTIVE_MINUTES || 25);
  const intervalMs = Math.max(5, minutes) * 60 * 1000;

  setInterval(async () => {
    for (const user of Object.values(users)) {
      if (!user.chatId || user.proactive === false) continue;
      const last = user.lastProactiveAt || 0;
      const lastSeen = user.lastSeenAt || 0;
      const quietEnough = Date.now() - Math.max(last, lastSeen) > intervalMs;
      if (!quietEnough) continue;

      try {
        user.lastProactiveAt = Date.now();
        const message = await proactiveMessage(user);
        await saveUsers();
        await send(user.chatId, splitTelegram(message));
        await maybeSendSticker(user.chatId, user, 0.04, message);
      } catch (error) {
        console.error('Proactive message failed:', error.message);
      }
    }
  }, Math.min(intervalMs, 10 * 60 * 1000));
}

async function proactiveMessage(user) {
  const style = styles[user.style] || styles.cute;
  if (Math.random() < 0.55) {
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

async function describeTelegramFile(user, fileId, kind, extraText) {
  const fileUrl = await getTelegramFileUrl(fileId);

  if (kind === 'photo') {
    if (!env.OPENAI_API_KEY) {
      return extraText
        ? `вижу фотку.${extraText} но нормально рассмотреть смогу, когда подключишь AI-ключ с vision`
        : 'вижу фотку) нормально описывать картинки смогу, когда подключишь AI-ключ с vision';
    }
    const prompt = [
      'Опиши фото коротко, по-русски, живо, от лица Kcuni.',
      `Стиль: ${(styles[user.style] || styles.cute).prompt}`,
      extraText ? `Подпись пользователя:${extraText}` : ''
    ].join('\n');
    return await callVision(user, prompt, fileUrl) || 'вижу фотку, но сейчас не смогла нормально разобрать';
  }

  if (kind === 'voice') {
    if (!env.OPENAI_API_KEY) return 'я получила голосовое, но расшифровку надо подключить через AI-ключ';
    return await transcribeTelegramAudio(user, fileUrl) || 'я получила голосовое, но не смогла его разобрать';
  }

  if (kind === 'video_note') {
    return 'вижу кружок) пока могу только заметить его, а нормально понимать видео надо подключать через vision/распознавание';
  }

  return 'получила файл';
}

async function getTelegramFileUrl(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
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

async function handleNews(chatId, user, topic = 'mixed') {
  const digest = await buildNewsDigest(user, topic, false);
  if (!digest) {
    await send(chatId, 'я сейчас не смогла нормально достать новости');
    return;
  }
  await send(chatId, splitTelegram(digest));
}

async function buildNewsDigest(user, topic = 'mixed', proactive = false) {
  const feeds = (env.NEWS_FEEDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!feeds.length) return '';

  const items = [];
  for (const feed of feeds.slice(0, 4)) {
    try {
      const xml = await fetchText(feed);
      items.push(...parseRss(xml).slice(0, 6));
    } catch (error) {
      console.error('News feed failed:', feed, error.message);
    }
  }

  if (!items.length) return '';

  const filtered = filterNewsByTopic(items, topic).slice(0, 5);
  if (!filtered.length) return '';

  const digest = filtered.map((item, index) => `${index + 1}. ${item.title}`).join('\n');
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
    `Стиль: ${(styles[user.style] || styles.calm).prompt}`,
    'Если тема тяжёлая, говори мягко, без жести ради жести.',
    digest
  ].join('\n\n');

  const ai = await callAi(user, prompt);
  return ai || `я тут прочитала ${topicLabel} новости:\n${digest}`;
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
    const model = env.GEMINI_MODEL || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Ты Kcuni. Отвечай по-русски живо, коротко, не как официальный помощник. Держи стиль пользователя. Не морализируй без причины.' }]
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
          { role: 'system', content: 'You are Kcuni. Follow the user style and answer in Russian by default. You can talk about almost any normal topic. Do not sound like an assistant. Do not moralize. If a topic is risky, keep it safe but still answer naturally.' },
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
    lastSeenAt: Date.now()
  };
  return users[key];
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
  for (const text of messages.filter(Boolean).slice(0, MAX_MESSAGES_PER_REPLY)) {
    await tg('sendMessage', { chat_id: chatId, text });
    await sleep(380);
  }
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
  return [...xml.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>[\s\S]*?<\/item>|<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/g)]
    .map((match) => ({ title: decodeXml(match[1] || match[2] || '') }))
    .filter((item) => item.title && !/реклама|advert|sponsor/i.test(item.title));
}

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
