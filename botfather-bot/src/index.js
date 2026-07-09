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

const styles = {
  cute: {
    title: 'няшная',
    prompt: 'Пиши по-русски коротко, тепло, мило, немного игриво. Не будь официальной. Иногда можно мягко флиртовать, но без перебора.',
    sample: 'мгм, я тут. рассказывай, что у тебя там)'
  },
  calm: {
    title: 'спокойная с лёгким флиртом',
    prompt: 'Пиши по-русски спокойно, тепло и по-человечески. Можно лёгкий естественный флирт, но без кринжа, сюсюканья и пошлости. Не будь официальной. Отвечай коротко, мягко, будто тебе правда интересно.',
    sample: 'я рядом. рассказывай спокойно, я тебя слушаю)'
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

while (true) {
  try {
    const updates = await tg('getUpdates', {
      offset,
      timeout: 25,
      allowed_updates: ['message']
    });

    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message?.text) {
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
  const text = message.text.trim();
  const user = getUser(chatId, message.from);

  if (text === '/start') {
    await send(chatId, [
      'привет, я Kcuni)',
      'можешь просто писать мне, а стиль менять командой /still',
      'например: /still cute'
    ]);
    return;
  }

  if (text === '/still') {
    await send(chatId, [
      'стили:',
      '/still cute - няшная',
      '/still calm - спокойная',
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
    await send(chatId, `стиль поменяла на ${styles[style].title})\n${styles[style].sample}`);
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

  if (text === '/news') {
    await handleNews(chatId, user);
    return;
  }

  if (text === '/web') {
    await send(chatId, [
      'напиши так: /web что найти',
      'или /url https://site.com чтобы я прочитала страницу'
    ]);
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
  await saveUsers();

  const reply = await generateReply(user, text);
  await send(chatId, splitTelegram(reply));
}

async function handleNews(chatId, user) {
  const feeds = (env.NEWS_FEEDS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!feeds.length) {
    await send(chatId, 'новостные источники не настроены. добавь NEWS_FEEDS в .env');
    return;
  }

  const items = [];
  for (const feed of feeds.slice(0, 4)) {
    try {
      const xml = await fetchText(feed);
      items.push(...parseRss(xml).slice(0, 4));
    } catch (error) {
      console.error('News feed failed:', feed, error.message);
    }
  }

  if (!items.length) {
    await send(chatId, 'я не смогла сейчас достать новости');
    return;
  }

  const digest = items.slice(0, 5).map((item, index) => `${index + 1}. ${item.title}`).join('\n');
  const prompt = `Сделай очень короткую дружелюбную выжимку новостей для владельца. Стиль: ${styles[user.style].prompt}\n\n${digest}`;
  const ai = await callAi(user, prompt);
  await send(chatId, splitTelegram(ai || `коротко по новостям:\n${digest}`));
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
    results.push({
      title: data.Heading || query,
      text: data.AbstractText,
      url: data.AbstractURL || ''
    });
  }

  for (const topic of flattenDuckTopics(data.RelatedTopics || [])) {
    if (topic.Text) {
      results.push({
        title: topic.Text.split(' - ')[0] || query,
        text: topic.Text,
        url: topic.FirstURL || ''
      });
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

async function generateReply(user, text) {
  const style = styles[user.style] || styles.cute;
  const memory = user.memory.slice(-10).join('\n');
  const prompt = [
    'Ты Kcuni, AI-девушка в Telegram.',
    style.prompt,
    'Отвечай 1-3 короткими сообщениями. Не звучать как официальный помощник.',
    'Если не знаешь факт, не выдумывай.',
    '',
    `Память о пользователе:\n${memory || 'пока мало данных'}`,
    '',
    `Сообщение пользователя: ${text}`
  ].join('\n');

  const ai = await callAi(user, prompt);
  if (ai) return ai;

  const fallback = {
    cute: 'мгм, я поняла) расскажи чуть подробнее',
    calm: 'поняла. можешь чуть подробнее объяснить?',
    playful: 'хм, звучит интересно. продолжай)',
    serious: 'поняла. уточни детали, пожалуйста.'
  };
  return fallback[user.style] || fallback.cute;
}

async function callAi(user, prompt) {
  if (!env.OPENAI_API_KEY) return '';

  try {
    const response = await fetch(`${env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: user.style === 'serious' ? 0.4 : 0.8,
        messages: [
          { role: 'system', content: 'You are Kcuni. Follow the user style and answer in Russian by default.' },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  } catch (error) {
    console.error('AI error:', error.message);
    return '';
  }
}

function getUser(chatId, from) {
  const key = String(chatId);
  users[key] ||= {
    id: chatId,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || 'user',
    style: 'cute',
    memory: []
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
  for (const text of messages.filter(Boolean).slice(0, 5)) {
    await tg('sendMessage', { chat_id: chatId, text });
    await sleep(350);
  }
}

function splitTelegram(text) {
  return String(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.length > 700 ? line.match(/.{1,700}/g) : [line])
    .slice(0, 5);
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
      'User-Agent': 'Mozilla/5.0 (compatible; KcuniBot/1.0; +https://github.com/Perec-109/Kcuni)',
      'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,application/rss+xml;q=0.9,*/*;q=0.8'
    }
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!/text|html|xml|json|rss/i.test(contentType)) {
    throw new Error(`unsupported content type: ${contentType}`);
  }
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
