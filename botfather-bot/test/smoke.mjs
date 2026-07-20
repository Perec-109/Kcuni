import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const mockPort = 18991;
const appPort = 18992;
const token = 'smoke-test-token';
const chatId = Date.now();
const calls = [];

const mockServer = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (url.pathname.includes('/file/')) {
    response.writeHead(200, { 'Content-Type': 'image/webp' });
    response.end(Buffer.from('fake-webp-image'));
    return;
  }

  if (url.pathname === '/rss') {
    response.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    response.end(`<?xml version="1.0"?><rss><channel>
      <item><title>Новая модель искусственного интеллекта вышла сегодня</title><description>Разработчики представили новую модель искусственного интеллекта. В статье описаны её возможности, ограничения и примеры использования в рабочих задачах.</description><link>https://example.com/ai</link><pubDate>${new Date().toUTCString()}</pubDate></item>
      <item><title>Учёные сделали необычное открытие</title><description>Учёные опубликовали результаты нового исследования. Авторы объясняют, как открытие было сделано, какие данные они проверили и почему это может быть важно для науки.</description><link>https://example.com/science</link><pubDate>${new Date(Date.now() - 2 * 86400000).toUTCString()}</pubDate></item>
    </channel></rss>`);
    return;
  }

  const body = await readBody(request);

  if (url.pathname.startsWith('/gemini/')) {
    const prompt = JSON.stringify(body);
    const text = prompt.includes('Telegram-стикер')
      ? 'фу, не присылай мне такое 😑'
      : prompt.includes('Период: последние 7 дней')
        ? 'вот тебе короткая сводка новостей за неделю'
        : 'помню наш разговор и продолжаю без приветствия';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    return;
  }

  const method = url.pathname.split('/').at(-1);
  calls.push({ method, body });
  let result = true;
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'Kcuni', username: 'kcuni_smoke_bot' };
  if (method === 'getFile') result = { file_path: 'stickers/test.webp' };
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ok: true, result }));
});

await listen(mockServer, mockPort);

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    BOT_TOKEN: token,
    WEBHOOK_URL: `http://127.0.0.1:${appPort}`,
    TELEGRAM_API_BASE: `http://127.0.0.1:${mockPort}`,
    TELEGRAM_FILE_BASE: `http://127.0.0.1:${mockPort}/file`,
    GEMINI_API_KEY: 'smoke-gemini-key',
    GEMINI_API_BASE: `http://127.0.0.1:${mockPort}/gemini`,
    NEWS_FEEDS: `http://127.0.0.1:${mockPort}/rss`,
    PORT: String(appPort),
    PROACTIVE_CHECK_MINUTES: '9999',
    TYPING_MIN_MS: '0', TYPING_MAX_MS: '0', TYPING_BASE_MS: '0',
    TYPING_PER_CHAR_MS: '0', TYPING_PER_WORD_MS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
let updateId = 0;
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await waitFor(() => output.includes('Webhook enabled'), 5000);

  const commandMenu = calls.find((call) => call.method === 'setMyCommands');
  assert.ok(commandMenu);
  assert.deepEqual(
    commandMenu.body.commands.map(({ command }) => command),
    ['style', 'timezone', 'location', 'schedule', 'proactive', 'headline', 'news_week', 'memory', 'stickers', 'help']
  );
  assert.ok(calls.some((call) => call.method === 'setChatMenuButton' && call.body.menu_button?.type === 'commands'));

  const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'kcuni-bot' });

  const unauthorized = await fetch(`http://127.0.0.1:${appPort}/telegram/webhook`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);

  await postUpdate({ text: '/start' });
  await waitForMessageContaining('привет, я Kcuni', 5000);

  await postUpdate({ text: '/timezone Europe/Minsk' });
  await waitForMessageContaining('Europe/Minsk', 5000);

  await postUpdate({ text: '/schedule 13:00,21:00,23:30' });
  await waitForMessageContaining('13:00, 21:00, 23:30', 5000);

  await postUpdate({ text: '/schedule auto' });
  await waitForMessageContaining('буду сама выбирать момент', 5000);

  await postUpdate({ text: 'я живу в Минске и люблю космос' });
  await waitForMessageContaining('продолжаю без приветствия', 5000);

  await postUpdate({ text: '/proactive now' });
  await waitForMessageContaining('https://example.com/science', 5000);

  await postUpdate({ sticker: { file_id: 'sticker-1', file_unique_id: 'unique-1', emoji: '🤮', width: 512, height: 512 } });
  await waitForMessageContaining('не присылай мне такое', 5000);

  await postUpdate({ text: '/news week' });
  await waitForMessageContaining('сводка новостей за неделю', 5000);

  await postUpdate({ text: '/style' });
  await waitForMessageContaining('/style cute', 5000);

  await postUpdate({ text: '/news_week' });
  await waitForMessageContaining('сводка новостей за неделю', 5000);

  await postUpdate({ text: '/memory' });
  await waitForMessageContaining('Минск', 5000);

  await postUpdate({ text: 'поздоровайся со мной' });
  await waitForMessageContaining('зачем ещё раз здороваться', 5000);
  const greetingMessageCount = sentMessages().length;
  await postUpdate({ text: 'поздоровайся со мной' });
  await waitFor(() => sentMessages().slice(greetingMessageCount).some((text) => /привет|здорово/.test(text)), 5000);

  assert.ok(calls.some((call) => call.method === 'setWebhook'));
  console.log('Kcuni webhook, memory, sticker and schedule smoke tests passed.');
} finally {
  child.kill();
  await close(mockServer);
}

async function postUpdate(message) {
  updateId += 1;
  const secret = createHash('sha256').update(token).digest('hex');
  const response = await fetch(`http://127.0.0.1:${appPort}/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: chatId, is_bot: false, first_name: 'Test' },
        ...message
      }
    })
  });
  assert.equal(response.status, 200);
}

function sentMessages() {
  return calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body.text));
}

async function waitForMessageContaining(fragment, timeoutMs) {
  await waitFor(() => sentMessages().some((text) => text.includes(fragment)), timeoutMs);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out. Child output:\n${output}\nMessages:\n${sentMessages().join('\n')}`);
}
