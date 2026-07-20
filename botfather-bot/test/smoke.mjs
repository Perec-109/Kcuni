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
    const isVideo = url.pathname.endsWith('.mp4');
    response.writeHead(200, { 'Content-Type': isVideo ? 'video/mp4' : 'image/webp' });
    response.end(Buffer.from(isVideo ? 'fake-mp4-video' : 'fake-webp-image'));
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
      : prompt.includes('Посмотри доступное видео целиком')
        ? 'в видео обсуждают нейросети и показывают эксперимент с ними'
      : prompt.includes('Внимательно рассмотри изображение')
        ? 'на картинке красный цветок крупным планом'
      : prompt.includes('Это только превью большого Telegram-видео')
        ? 'виден человек в очках перед доской'
      : prompt.includes('Период: последние 7 дней')
        ? 'вот тебе короткая сводка новостей за неделю'
        : prompt.includes('проверка тавтологии')
          ? 'Я поняла тон, буду дерзче, но без тупой пошлости ради пошлости.'
          : prompt.includes('проверка повтора')
            ? 'это одна и та же повторяющаяся реплика'
        : 'помню наш разговор и продолжаю без приветствия';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    return;
  }

  const method = url.pathname.split('/').at(-1);
  calls.push({ method, body });
  let result = true;
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'Kcuni', username: 'kcuni_smoke_bot' };
  if (method === 'getFile') {
    result = String(body.file_id).startsWith('video-')
      ? { file_path: 'videos/test.mp4', file_size: 1024 }
      : { file_path: 'stickers/test.webp', file_size: 512 };
  }
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
    REMINDER_MINUTE_MS: '500',
    REMINDER_CHECK_MS: '25',
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
    ['style', 'timezone', 'location', 'schedule', 'proactive', 'headline', 'news_week', 'memory', 'stickers', 'feedback', 'reminders', 'status', 'help']
  );
  assert.ok(calls.some((call) => call.method === 'setChatMenuButton' && call.body.menu_button?.type === 'commands'));

  const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'kcuni-bot', version: '2026-07-21-video-understanding-1' });

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

  await postUpdate({ text: '/Headline@kcuni_smoke_bot' });
  await waitForMessageContaining('https://example.com/ai', 15000);

  await postUpdate({ text: '/HELP@kcuni_smoke_bot' });
  await waitForMessageContaining('команды Kcuni', 5000);

  await postUpdate({ text: '/status@kcuni_smoke_bot' });
  await waitForMessageContaining('Kcuni 2026-07-21-video-understanding-1', 5000);

  await postUpdate({ text: '/unknown_command@kcuni_smoke_bot' });
  await waitForMessageContaining('не знаю такую команду', 5000);

  await postUpdate({ text: 'я живу в Минске и люблю космос' });
  await waitForMessageContaining('продолжаю без приветствия', 5000);

  await postUpdate({ text: 'не отвечай так' });
  await waitForMessageContaining('эту формулировку', 5000);

  await postUpdate({ text: '/feedback' });
  await waitForMessageContaining('не использовать: 1', 5000);

  await postUpdate({ text: 'напиши мне через 1 минуту' });
  await waitForMessageContaining('поставила таймер', 5000);
  const reminderMessageCount = sentMessages().length;
  await waitFor(() => sentMessages().slice(reminderMessageCount).some((message) => /ты просил|обещала|таймер сработал/.test(message)), 5000);

  await postUpdate({ text: 'напиши мне завтра в 21:30-21:35' });
  await waitForMessageContaining('21:30–21:35', 5000);

  await postUpdate({ text: 'напиши мне в 0.50' });
  await waitForMessageContaining('в 00:50', 5000);

  await postUpdate({ text: '/reminders' });
  await waitForMessageContaining('активные напоминания', 5000);

  await postUpdate({ text: '/reminders clear' });
  await waitForMessageContaining('все таймеры', 5000);

  await postUpdate({ text: '/proactive now' });
  await waitForMessageContaining('https://example.com/science', 15000);

  await postUpdate({ text: 'ты дура' });
  await waitForMessageContaining('иди нахуй', 5000);

  const roleplayMessageCount = sentMessages().length;
  await postUpdate({ text: 'ты окровавленные ножницы, сука, ты яндере' });
  await waitFor(() => sentMessages().slice(roleplayMessageCount).some((message) => /ножниц|яндер/.test(message)), 5000);
  assert.ok(sentMessages().slice(roleplayMessageCount).every((message) => !/я поняла тон|без тупой пошлости/.test(message)));

  await postUpdate({ text: 'на колени, на колени быстро' });
  await waitForMessageContaining('успокаиваемся', 5000);

  const tautologyMessageCount = sentMessages().length;
  await postUpdate({ text: 'проверка тавтологии в ответе' });
  await waitFor(() => sentMessages().length > tautologyMessageCount, 5000);
  assert.ok(sentMessages().slice(tautologyMessageCount).every((message) => !/я поняла тон|буду дерзче|пошлости ради пошлости/i.test(message)));

  const firstRepeatCount = sentMessages().length;
  await postUpdate({ text: 'проверка повтора один' });
  await waitFor(() => sentMessages().length > firstRepeatCount, 5000);
  const firstRepeatReply = sentMessages().at(-1);
  const secondRepeatCount = sentMessages().length;
  await postUpdate({ text: 'проверка повтора два' });
  await waitFor(() => sentMessages().length > secondRepeatCount, 5000);
  assert.notEqual(sentMessages().at(-1), firstRepeatReply);

  await postUpdate({ sticker: { file_id: 'sticker-1', file_unique_id: 'unique-1', emoji: '🤮', width: 512, height: 512 } });
  await waitForMessageContaining('не присылай мне такое', 5000);

  await postUpdate({
    video: { file_id: 'video-1', file_unique_id: 'video-unique-1', file_size: 1024, mime_type: 'video/mp4', duration: 12 },
    caption: 'что тут происходит?'
  });
  await waitForMessageContaining('обсуждают нейросети', 5000);

  await postUpdate({
    text: 'про что в видео говорят?',
    reply_to_message: {
      message_id: 777,
      video: { file_id: 'video-2', file_unique_id: 'video-unique-2', file_size: 2048, mime_type: 'video/mp4', duration: 45 }
    }
  });
  await waitForMessageContaining('показывают эксперимент', 5000);

  await postUpdate({
    text: 'что это за картинка?',
    reply_to_message: {
      message_id: 778,
      photo: [{ file_id: 'photo-1', file_unique_id: 'photo-unique-1', file_size: 512, width: 800, height: 600 }]
    }
  });
  await waitForMessageContaining('красный цветок', 5000);

  await postUpdate({
    text: 'перескажи это видео',
    reply_to_message: {
      message_id: 779,
      video: {
        file_id: 'large-video', file_unique_id: 'large-video-unique',
        file_size: 21 * 1024 * 1024, mime_type: 'video/mp4', duration: 3600,
        thumbnail: { file_id: 'preview-1', file_unique_id: 'preview-unique', width: 320, height: 180 }
      }
    }
  });
  await waitForMessageContaining('больше 20 МБ', 5000);
  await waitForMessageContaining('человек в очках', 5000);

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
