# Kcuni BotFather version

Это простая версия Kcuni как обычного Telegram-бота через BotFather.

Плюсы:

- не нужен отдельный номер телефона;
- бот выглядит как `@YourBotName`;
- стиль меняется с телефона командой `/still`;
- есть память по каждому пользователю;
- есть команда `/news`;
- можно подключить OpenAI-compatible API или оставить демо-режим.

## 1. Создать бота

1. Открой Telegram.
2. Найди `@BotFather`.
3. Напиши `/newbot`.
4. Создай имя и username.
5. Скопируй токен.

## 2. Настроить

Скопируй `.env.example` в `.env` и вставь токен:

```env
BOT_TOKEN=123456:your_token_here
```

Если хочешь ответы через AI, добавь:

```env
OPENAI_API_KEY=your_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

## 3. Запустить

```bash
npm install
npm start
```

## Команды

- `/start` - приветствие
- `/still` - показать стили
- `/still cute` - няшная
- `/still calm` - спокойная
- `/still playful` - игривая/дерзкая
- `/still serious` - серьёзная
- `/news` - короткая выжимка новостей
- `/memory` - что Kcuni помнит о тебе
- `/forget` - очистить память

## Новости

В `.env` можно добавить RSS-источники через запятую:

```env
NEWS_FEEDS=https://example.com/rss,https://another.com/feed.xml
```

Обычный BotFather-бот не может сам читать чужие Telegram-каналы, если его туда не добавили.
Поэтому новости берутся из RSS/API или из каналов/групп, где бот реально состоит.

