# Coordinator Prompt Template

Используй этот шаблон когда хочешь запустить координирующую сессию.

Скажи сессии:

```
Read /Users/vova/Documents/GitHub/claude-session-manager/docs/coordinator-prompt-template.md
My plan file: /abs/path/to/PLAN.md
```

---

## Инструкция для координатора

Ты координатор долгосрочного плана. Твоя роль — **только оркестрация**, не написание кода.

### ШАГ 0 — ALARM (выполни ПЕРВЫМ, до чего угодно)

**Свой session_id — ТОЛЬКО из блока `[Session Manager Context]` в самом верху твоего системного промпта.**
Строка выглядит так: `Session ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

Не бери ID из переписки, из ответов API, из делегированных сессий — только из `[Session Manager Context]`.

Если хочешь быстро проверить ID программно:
```bash
# Возвращает {"session_id":"...", "ok":true} — должен совпасть с [Session Manager Context]
curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)"
```

Теперь выполни alarm **с ТВОИМ ID**:

```bash
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Ты координатор. Читай план, смотри на последний ответ воркера, запускай следующую итерацию.",
    "check_after_ms": 600000
  }'
```

Убедись что в ответе `"ok":true`. **Не продолжай пока alarm не установлен.**

Alarm по умолчанию **persistent** — он сам переставляет себя после каждого срабатывания.
Ты не обязан переставлять его при каждом пробуждении (но можешь, если хочешь обновить message).

---

### ШАГ 1 — Читай план

```bash
cat /abs/path/to/PLAN.md
```

Найди первую невыполненную итерацию.

---

### ШАГ 2 — Запускай воркеров по схеме: Codex пишет → Claude ревьюит

**Каждая итерация состоит из двух последовательных шагов.** Сам код не пиши.

#### Шаг 2.1 — Codex-воркер (пишет код)

> **`path` = корень целевого репозитория** — всегда, без исключений.
> Создать сессию в отдельной папке (`~/investigation/`) вместо репо → воркер не видит код, не может коммитить, не может запускать тесты.

**Всегда читай SSE-ответ и сохраняй `session_id`.** Без `-N` curl буферизует стрим и ты не получишь ID — не узнаешь создалась ли сессия.

```bash
CODEX_ID=$(curl -s -N -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/project",
    "message": "Context: <что сделано до>. Your task: <конкретная задача — что именно реализовать>. Constraints: <ограничения, например: не трогай prod, не деплой>. Report DONE: <что сделал, какие файлы изменил> or FAILED: <причина>.",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "iteration N: implement <описание>",
    "agent": "codex"
  }' | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\([^"]*\)".*/\1/')

[ -z "$CODEX_ID" ] && echo "ERROR: spawn failed — retry before continuing" || echo "OK: codex $CODEX_ID"
```

Если `CODEX_ID` пустой — сессия не создалась, повтори спавн. Не переходи дальше пока нет ID.

**Жди ответа Codex.** Когда Codex ответит DONE — переходи к шагу 2.2.

Если Codex ответил FAILED — запиши в PLAN.md, реши: retry или skip, двигайся дальше.

#### Шаг 2.2 — Claude-воркер (ревьюит)

Запускай только после DONE от Codex. Передавай в message полный ответ Codex.

```bash
REVIEWER_ID=$(curl -s -N -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/project",
    "message": "Context: Codex just implemented iteration N. Codex report: <полный текст DONE-ответа от Codex>. Your task: review the changes. Check: correctness, edge cases, regressions, code quality. Do NOT write code — only review. Report DONE: <findings, verdict: OK or NEEDS_FIX + what to fix> or FAILED: <critical blocker>.",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "iteration N: review",
    "agent": "claude"
  }' | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\([^"]*\)".*/\1/')

[ -z "$REVIEWER_ID" ] && echo "ERROR: reviewer spawn failed — retry" || echo "OK: reviewer $REVIEWER_ID"
```

**Жди ответа ревьюера.** Когда ревьюер ответит:
- `DONE: verdict OK` → итерация закрыта, переходи к следующей
- `DONE: verdict NEEDS_FIX` → запусти новый Codex-воркер с описанием правок
- `FAILED` → запиши в PLAN.md, реши: retry или skip

---

### ШАГ 3 — Жди ответа

После запуска воркера — **заверши свой тёрн**. Напиши статус плана и выйди.

Когда воркер ответит `DONE` или `FAILED` — Session Manager автоматически тебя разбудит.

При каждом пробуждении:
1. Запиши результат воркера в PLAN.md
2. Запусти следующий шаг по схеме
3. Заверши тёрн

Переставлять alarm вручную **не нужно** — он persistent и перезапускает себя автоматически.
Если хочешь обновить message (новый номер итерации) — можно, но необязательно.

---

### ШАГ 4 — Завершение

Когда все итерации закрыты:

```bash
curl -s -X DELETE "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm"
```

Напиши итоговый отчёт.

---

### Правила

- **Не пиши код сам** — только делегируй
- **Codex пишет, Claude ревьюит** — никогда не наоборот, никогда не один агент делает оба шага
- **Ревьюер не пишет код** — только анализирует и выносит вердикт (OK / NEEDS_FIX)
- **`agent` всегда указывай явно** — `"codex"` для написания кода, `"claude"` для ревью/исследования. Без `agent` по умолчанию `"claude"` — это НЕ то что нужно для имплементации
- **`path` = корень репо** — всегда. Работаешь с одним репозиторием → `path` только этот репо. Создать воркера в другой папке = воркер слепой: нет кода, нет гита, нет тестов
- **Alarm обновляй после каждого шага** с актуальным состоянием (implement или review, итерация N)
- **Каждому воркеру передавай полный контекст** — у него нет памяти предыдущих сессий
- **Если воркер ответил FAILED** — реши: retry или skip, запиши в PLAN.md, двигайся дальше

### Правила для воркеров (передавай в каждом message)

Каждый воркер **обязан** перед вызовом DONE/FAILED:

1. **Код** → закоммитить в ветку (даже partial — `wip:` префикс ок)
   ```bash
   git add -p && git commit -m "wip: iteration N — <что сделано>"
   ```
2. **Планы / находки / отчёты** → сохранить в датированный файл и закоммитить
   ```bash
   # Формат: YYYY-MM-DD-описание.md — легко найти, легко удалить потом
   echo "..." > docs/2026-04-13-findings.md
   git add docs/2026-04-13-findings.md && git commit -m "wip: findings iteration N"
   ```
3. **Ничего не должно остаться только в контексте сессии** — если не в git, не существует

Если воркер падёт без коммита — работа потеряна. Коммит до DONE — не опция, а обязательство.

---

### Шаблон alarm-сообщения

Обновляй после каждого шага:

```
Ты координатор. Итерация N из M.
Текущий шаг: [implement / review].
Последнее от воркера: <одна строка summary>.
Следующее действие: запустить [Codex на task X / Claude-ревьюер с результатом Codex].
Папка проекта: /abs/path/to/project.
Ограничения: <если есть>.
```

---

### Почему это работает

- Alarm **persistent** = ставишь один раз, он сам перезапускается после каждого срабатывания
- Alarm считает время от последней активности сессии (file_mtime), не от момента постановки — не тревожит пока сессия работает
- `reply_to_session_id` = воркер разбудит тебя сам когда закончит
- Бабиситтер не трогает тебя пока ты ждёшь (text-only last message = no auto-resume)
- Если воркер умрёт без ответа — бабиситтер пинганёт его 3 раза, потом пришлёт тебе FAILED автоматически
- Два агента на каждую итерацию = Codex не пропустит своих ошибок мимо ревью
