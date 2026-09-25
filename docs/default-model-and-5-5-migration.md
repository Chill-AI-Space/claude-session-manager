# Default model и переход на Claude 5.5

Как устроена модель по умолчанию в веб-интерфейсе и что настраивать, чтобы переключить Claude Code на другую модель (например Opus 5.5).

## Как выбирается модель

При запуске сессии из веба (`claude -p ...`) модель берётся из настройки `claude_model`:

1. Явно переданный `model` в запросе (обычно из выпадашки в UI) — приоритет №1
2. Сохранённая настройка `claude_model` в `~/.config/claude-session-manager/settings.json`
3. Код-дефолт `SETTING_DEFAULTS.claude_model` (`src/lib/db.ts`)
4. Финальный fallback в `buildCliArgs` (`src/lib/orchestrator.ts`)

Сейчас дефолт — **`claude-opus-5-5`** (Opus 5.5).

## Что настраивать

### 1. Модель для новых/веб-сессий (главное)

**UI:** Settings → AI Model → "Model for new sessions" (`claude_model`)

**Вручную:**
```bash
# ~/.config/claude-session-manager/settings.json
{ "claude_model": "claude-opus-5-5" }
```

### 2. Дефолт в коде (для новых установок)

Если настройка не сохранена в settings.json — используется код-дефолт. Меняется в двух местах:

| Файл | Строка | Что |
|------|--------|-----|
| `src/lib/db.ts` | `SETTING_DEFAULTS.claude_model` | дефолт для всего |
| `src/lib/orchestrator.ts` | fallback в `buildCliArgs` | страховка, если настройка пуста |

Плюс UI-пресеты в `src/components/settings/ModelSelector.tsx`:
- `MODEL_PRESETS` — список моделей в выпадашке (добавить `claude-opus-5-5` и т.п.)
- `getDefaultModelForAgent()` — дефолт для агента `claude`

### 3. Terminal-сессии

`buildStartShellCommand` / `buildResumeShellCommand` в `src/lib/session-terminal.ts` тоже читают `claude_model` — отдельная настройка не нужна, работает то же значение.

## Доступные модели

Проверить, какие модели реально поддерживает установленный CLI:

```bash
claude --model "claude-opus-5-5" -p "ok" --max-turns 1
```

- `claude-opus-5-5` — Opus 5.5 (дефолт, самый мощный)
- `claude-sonnet-5` — Sonnet 5 (баланс цена/скорость)
- `claude-opus-5` — Opus 5
- `claude-sonnet-4-6` / `claude-opus-4-6` — предыдущие
- `claude-haiku-4-5-20251001` — быстрый

Неизвестная модель даёт `[claude-code:unrecognized_model]` — CLI упадёт с ошибкой, сессия не стартует.

## Аналитика/стоимость

Стоимость в аналитике считается по `MODEL_PRICES` в `src/app/api/analytics/route.ts` и `src/app/claude-sessions/analytics/page.tsx`. Если модели нет в мапе — берётся `DEFAULT_PRICE`. Для точных цифр по Opus 5.5 можно добавить запись, но не обязательно.

## Применение изменений

Код-дефолты применяются на следующем рестарте сервера:

```bash
npm run deploy:live        # snapshot сессий → build → restart → resume
```

Настройка в settings.json через UI применяется сразу (без рестарта).