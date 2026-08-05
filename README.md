# Nexo MVP backend — простой первый этап

Это временный backend для первого онлайн-теста: аккаунты, контакты, сообщения, SSE и signaling звонков.

⚠️ На этом этапе сообщения не E2EE. Не используй его для настоящих секретных переписок. После проверки связи заменим его на secure backend с Olm/Megolm.

## Запуск локально

```powershell
node server.js
```

## Переменные для публикации

```text
PORT=8080
WEB_ORIGIN=https://твой-сайт.netlify.app
```

## API

- `GET /api/health`
- регистрация и вход;
- `/api/contacts`;
- `/api/events`;
- `/api/chats/.../messages`;
- `/api/calls/signal`.

## Railway/Render

1. Загрузить эту папку в GitHub.
2. Создать Web Service из репозитория.
3. Start command: `node server.js`.
4. Добавить `WEB_ORIGIN` с адресом Netlify.
5. Скопировать публичную ссылку API.
6. В frontend перед inline-скриптами добавить:

```html
<script>
  window.NEXO_API_BASE = 'https://адрес-твоего-backend/api';
</script>
```
