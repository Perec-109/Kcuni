# Kcuni

Kcuni is a Telegram character bot with conversation styles, per-user memory,
media handling, news and proactive messages.

- [Project site](https://perec-109.github.io/Kcuni/)
- Bot source and local setup: [`botfather-bot/`](botfather-bot/)

## Deploy the Telegram bot on Render

The repository contains a `render.yaml` Blueprint for a free Render web
service. In production the bot uses a Telegram webhook; locally it falls back
to long polling.

1. Create the bot in [BotFather](https://t.me/BotFather) and copy its token.
2. In Render choose **New > Blueprint** and connect `Perec-109/Kcuni`.
3. Approve the Blueprint and set the required `BOT_TOKEN` secret.
4. To enable AI replies, also set `GEMINI_API_KEY` (optional).
5. Deploy. The service registers its Render URL as the Telegram webhook
   automatically and exposes `/healthz` for health checks.

Do not commit bot tokens or API keys to GitHub.

## Checks

```bash
cd botfather-bot
npm run check
npm test
```
