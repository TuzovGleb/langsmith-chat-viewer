# LangSmith Chat Viewer (GitHub Pages)

Просмотрщик чатов из LangSmith — статический сайт под паролем, хостится на GitHub Pages.

## Как это работает

- Сайт — чистая статика (HTML/CSS/JS), сервера нет.
- LangSmith-ключ хранится в **GitHub Secrets** и в репозиторий не попадает.
- При деплое GitHub Action шифрует ключ паролем сайта (PBKDF2 600k итераций → AES-256-GCM)
  и кладёт на сайт только шифроблоб `config.enc.json`.
- Браузер: вводишь пароль → WebCrypto расшифровывает ключ в памяти → запросы идут
  напрямую в LangSmith API (CORS разрешён). Неверный пароль = расшифровка невозможна.

## Настройка (один раз)

1. В репозитории: **Settings → Secrets and variables → Actions → New repository secret**:
   - `LANGSMITH_API_KEY` — ключ LangSmith (`lsv2_pt_...`)
   - `SITE_PASSWORD` — пароль, который будет спрашивать сайт
   - `LANGSMITH_API_URL` — опционально, для EU: `https://eu.api.smith.langchain.com`

   Или через CLI:
   ```
   gh secret set LANGSMITH_API_KEY
   gh secret set SITE_PASSWORD
   ```

2. **Settings → Pages → Source: GitHub Actions** (если не включилось автоматически).

3. Запустить деплой: **Actions → Deploy to GitHub Pages → Run workflow**
   (или просто запушить в `main`).

## Смена пароля / ключа

Обновить секрет → перезапустить workflow. Старый шифроблоб перестанет работать.

## Локальная проверка вёрстки

Открыть `site/index.html#demo` через любой статический сервер — демо-чат без API.
