import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const telegramPort = 18991;
const appPort = 18992;
const token = 'smoke-test-token';
const calls = [];

const telegram = createServer(async (request, response) => {
  const body = await readBody(request);
  const method = new URL(request.url, 'http://localhost').pathname.split('/').at(-1);
  calls.push({ method, body });

  const result = method === 'getMe'
    ? { id: 1, is_bot: true, first_name: 'Kcuni', username: 'kcuni_smoke_bot' }
    : true;
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ok: true, result }));
});

await listen(telegram, telegramPort);

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    BOT_TOKEN: token,
    WEBHOOK_URL: `http://127.0.0.1:${appPort}`,
    TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`,
    PORT: String(appPort),
    PROACTIVE_MINUTES: '9999',
    TYPING_MIN_MS: '0',
    TYPING_MAX_MS: '0',
    TYPING_BASE_MS: '0',
    TYPING_PER_CHAR_MS: '0',
    TYPING_PER_WORD_MS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await waitFor(() => output.includes('Webhook enabled'), 5000);

  const health = await fetch(`http://127.0.0.1:${appPort}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'kcuni-bot' });

  const unauthorized = await fetch(`http://127.0.0.1:${appPort}/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(unauthorized.status, 401);

  const secret = createHash('sha256').update(token).digest('hex');
  const webhook = await fetch(`http://127.0.0.1:${appPort}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret
    },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: 'private' },
        from: { id: 123, is_bot: false, first_name: 'Test' },
        text: '/start'
      }
    })
  });
  assert.equal(webhook.status, 200);
  await waitFor(() => calls.some((call) => call.method === 'sendMessage'), 5000);

  assert.ok(calls.some((call) => call.method === 'setWebhook'));
  console.log('Kcuni webhook smoke test passed.');
} finally {
  child.kill();
  await close(telegram);
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
  throw new Error(`Timed out. Child output:\n${output}`);
}
