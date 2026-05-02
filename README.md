# Elromco Analytics Bot

Заходит в Elromco → делает скриншот reports → Claude анализирует → отправляет в Telegram.

## Деплой на Railway

### 1. Переменные окружения (Railway → Variables)

```
ELROMCO_LOGIN=your_bot_email
ELROMCO_PASS=your_bot_password
ELROMCO_COMPID=153
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=7xxx...
TELEGRAM_CHAT_ID=your_chat_id
```

### 2. Запуск вручную

Открой в браузере:
- `https://your-app.railway.app/run/week`     — отчёт за 7 дней
- `https://your-app.railway.app/run/month`    — отчёт за текущий месяц
- `https://your-app.railway.app/run/lastweek` — отчёт за прошлую неделю

### 3. Автоматический запуск

Бот сам запускается:
- **Каждый понедельник в 8:00 AM PT** — недельный отчёт
- **1-го числа каждого месяца в 8:00 AM PT** — месячный отчёт

### 4. Debug скриншоты

Если что-то не работает, смотри что видит бот:
- `https://your-app.railway.app/screenshot/report-01-loaded`
- `https://your-app.railway.app/screenshot/report-02-dated`
- `https://your-app.railway.app/screenshot/report-03-full`
- `https://your-app.railway.app/screenshot/report-error`

## Как получить TELEGRAM_CHAT_ID

1. Открой своего бота в Telegram
2. Напиши ему любое сообщение
3. Открой в браузере: `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Найди `"chat":{"id":XXXXXXXX}` — это твой chat_id
