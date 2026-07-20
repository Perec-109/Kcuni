# Kcuni

Kcuni is a Telegram character bot with conversation styles, per-user memory,
media handling, contextual news and proactive messages. In automatic mode it
chooses different local times each day and can connect a recent conversation
topic with a fresh article, a short summary and the full source link.
It also learns from direct response feedback and supports guaranteed one-off
timers such as `напиши мне через 15–20 минут` or
`напиши мне завтра в 21:30–21:35` in the user's timezone.

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
   automatically, replaces the Telegram website menu button with Kcuni's
   command list, and exposes `/healthz` for health checks.

The `Keep Kcuni awake` GitHub workflow pings that health endpoint every ten
minutes. This is needed for proactive messages on Render Free, whose web
services otherwise sleep after a period without inbound traffic.

Do not commit bot tokens or API keys to GitHub.

## Checks

```bash
cd botfather-bot
npm run check
npm test
```
