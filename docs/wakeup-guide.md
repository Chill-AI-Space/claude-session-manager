# Гайд: пробуждение сессий и перекрёстные сообщения

Как сессия будит **себя**, как будит **других**, и какие для этого есть
инструменты. Основа для оркестратора, который всех раскручивает (в т.ч.
OpenCode-оркестратора).

Все ссылки на исходники — по main:
https://github.com/Chill-AI-Space/claude-session-manager/blob/main/

---

## Пять инструментов

| Что нужно | API | Исходник |
|---|---|---|
| Узнать свой session_id | `GET /api/sessions/my-id?path=$(pwd)` | [src/app/api/sessions/my-id/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/my-id/route.ts) |
| Завести себе вечный будильник | `POST /api/sessions/{my_id}/alarm` | [src/app/api/sessions/[sessionId]/alarm/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/%5BsessionId%5D/alarm/route.ts) |
| Отправить сообщение другой сессии | `POST /api/sessions/{other_id}/reply` | [src/app/api/sessions/[sessionId]/reply/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/%5BsessionId%5D/reply/route.ts) |
| Запустить новую сессию | `POST /api/sessions/start` | [src/app/api/sessions/start/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/start/route.ts) |
| Кто ещё работает рядом | `GET /api/sessions/peers?path=…&exclude=…` | [src/app/api/sessions/peers/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/peers/route.ts) |

Плюс вспомогательное: `GET /api/sessions` (список с `is_active`/`agent_type`),
`POST /api/sessions/scan` (форс-перескан — заодно тик проверки будильников),
`POST /api/sessions/{id}/kill` (убить процессы), вебхук `on_complete_url`
при завершении стартованной сессии (`{session_id, event:"completed"}`).

---

## 1. Свой session_id

**Claude** получает свой id автоматически: в начало системного промпта
инжектится блок `[Session Manager Context]` (настройка `inject_session_context`)
с `Session ID:`, ссылками на `reply`/`alarm` и примером `start`.

**Codex** получает `[Delegation Contract]` в текст сообщения при спавне через
`reply_to_session_id` (в тексте — как спавнить детей и как отчитаться).

**OpenCode — ничего не получает автоматически.** Ни контекст-блока, ни
контракта. Поэтому оркестратору-опенкоду id узнаёт сам:

```bash
curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)"
# {"session_id":"ses_…","ok":true}
```

А при спавне детей id родителя стоит явно дописывать в `message` — сама
сессия о нём не узнает. Дети возвращают id в SSE-потоке (см. рецепт ниже).

---

## 2. Будильник (self-alarm): «буди меня, пока не доделаю»

```bash
curl -s -X POST "http://localhost:3000/api/sessions/$MY_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message":"Продолжай недоделанное: <конкретная цель>","check_after_ms":300000,"mode":"persistent"}'
```

Семантика:

- **`persistent`** (дефолт) — срабатывает каждый раз, когда сессия простояла
  без активности `check_after_ms`, и после срабатывания **перевзводится сам**.
  Поставил один раз — крутится вечно, пока не уберёшь. Ровно то, что нужно
  для «буди пока недоделает».
- **`once`** — одноразовый, после срабатывания удаляется.
- Оценивается прой по `MAX(file_mtime, set_at) + check_after_ms`, а не от
  момента установки: любая активность сессии сдвигает таймер (не привязан к
  wall-clock). Сервер добавляет джиттер (3–30 с, ~15%), чтобы будильники
  нескольких сессий не выстреливали синхронно.
- **Живую сессию будильник не убивает и не дублирует.** Срабатывание требует
  простоя `check_after_ms` (активность сбрасывает таймер), а доставка выбирается
  по состоянию процесса: процесс мёртв → resume заново; процесс жив, но молчит →
  сообщение **впечатывается в тот же терминал** (`alarm_fired_live` в логах),
  resume рядом с живым процессом не делается никогда (это вилка транскрипта).
  После любого срабатывания будильник перевзводится и продолжает следить.
- Пока будильник активен, штатный babysitter (crash/stall) этой сессии молчит
  — будильник и есть её обработчик.
- Проверка будильников идёт на тиках сканера: при событиях Claude-скана
  (открытие UI, старт/стоп сессий, `POST /api/sessions/scan`) и каждые 30 с
  фоновыми сканерами Codex/OpenCode
  ([src/lib/codex-background-scanner.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/lib/codex-background-scanner.ts),
  [src/lib/opencode-background-scanner.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/lib/opencode-background-scanner.ts)).
  То есть без открытого UI будильник всё равно сработает, максимум с
  опозданием на ~30 с.
- Диспетчер будильника — agent-aware
  (`resumeSessionBackground` в
  [src/lib/orchestrator.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/lib/orchestrator.ts)):
  Claude → headless `claude --resume`, Codex → `codex resume` в терминале,
  OpenCode → `opencode --session … --prompt` в терминале, Forge → headless.
  Для Codex/OpenCode сначала пробуется **то же окно**, в котором сессия жила
  (запомненный TTY, см. [src/lib/session-tty.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/lib/session-tty.ts));
  если окно закрыто/занято или агент не стартовал — команда набирается уже в
  новом окне (ретрай с фоллбэком).
- Повторные срабатывания дедуплицируются очередью (`resume:<id>`), параллельные
  тики сканера не создают второй процесс.

**Остановить:**

```bash
curl -s -X DELETE "http://localhost:3000/api/sessions/$MY_ID/alarm"          # полностью отключить babysitter этой сессии
curl -s -X DELETE "http://localhost:3000/api/sessions/$MY_ID/alarm?clear=true" # снять будильник, babysitter снова включён
curl -s "http://localhost:3000/api/sessions/$MY_ID/alarm"                     # текущее состояние
```

**Самообслуживание после пробуждения.** Каждое сообщение будильника
заканчивается подсказкой `[Alarm] You were woken by your own self-alarm…`,
поэтому разбуженная сессия сама решает, что делать дальше:

```bash
# отложить следующее пробуждение (текст и режим будильника сохраняются)
curl -s -X POST "http://localhost:3000/api/sessions/$MY_ID/alarm" \
  -H "Content-Type: application/json" -d '{"snooze_ms":1800000}'   # +30 минут от сейчас

# отменить совсем — задача выполнена или больше не актуальна
curl -s -X DELETE "http://localhost:3000/api/sessions/$MY_ID/alarm?clear=true"
```

`snooze_ms` сдвигает `set_at` на «сейчас» и задаёт новый интервал, так что
тиканье пойдёт от момента snooze. Для `once`-будильника snooze просто
отодвигает единственный выстрел (потребляется он по-прежнему при
срабатывании).

---

## 3. Разбудить/написать другой сессии (reply)

```bash
curl -s -X POST "http://localhost:3000/api/sessions/$OTHER_ID/reply" \
  -H "Content-Type: application/json" \
  -d '{"message":"Следующий шаг: …"}'
```

Поведение зависит от `agent_type` получателя (ветка по коду из
[reply/route.ts](https://github.com/Chill-AI-Space/claude-session-manager/blob/main/src/app/api/sessions/%5BsessionId%5D/reply/route.ts)):

| Агент | Что делает reply |
|---|---|
| **claude** | Живой процесс → печатает текст прямо в его терминал (TTY). Занят → кладёт в очередь, доставит после хода. Мёртв → headless `claude --resume`. |
| **codex** | Живой процесс → верифицированная вставка в его TTY. Иначе → `codex resume <id> "сообщение"` в новом терминале. |
| **opencode** | Всегда открывает терминал `opencode --session <id> --prompt "…"` (своего TTY-детектора пока нет). |
| **forge** | Headless-резюм через оркестратор. |

Важно: **будить живую сессию — только `reply`**. Будильник живую сессию по
определению не тронет (см. §2), а для «живой, но забытой в терминале» TUI
`reply` — единственный способ достучаться.

---

## 4. Спавн и отчётность

```bash
curl -s -N -X POST http://localhost:3000/api/sessions/start \
  -H "Content-Type: application/json" \
  -d '{
    "path": "'"$(git rev-parse --show-toplevel)"'",
    "message": "Сделай X. Отчитайся: POST /api/sessions/'"$MY_ID"'/reply {\"message\":\"DONE: …\"}",
    "agent": "opencode",
    "reply_to_session_id": "MY_SESSION_ID",
    "delegation_task": "X",
    "on_complete_url": "http://localhost:3000/api/sessions/MY_SESSION_ID/reply"
  }'
CHILD_ID=$(… | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\([^"]*\)".*/\1/')
```

- **`-N` обязателен** — без него SSE-поток буферизируется и id не виден;
- `reply_to_session_id` + `delegation_task` — родитель получает контракт
  отчётности (Codex — в тексте сообщения);
- `on_complete_url` — вебхук при завершении;
- `agent`: `claude | codex | forge | opencode` (дефолт — `default_agent`).

Подробности: [docs/delegation-guide.md](delegation-guide.md),
[docs/spawn-guide.md](spawn-guide.md).

---

## 5. Схема опенкодового оркестратора

1. `GET /api/sessions/my-id?path=$(pwd)` — узнать свой id.
2. `POST /api/sessions/{my_id}/alarm` `mode:"persistent"` — перевестись на
   самобудильник **первым делом** (если упадёшь/заснёшь — проснёшься с своим
   сообщением).
3. Цикл:
   - `GET /api/sessions/peers?path=…&exclude=$MY_ID` — кто рядом;
   - мёртвым/проспавшим — `reply` (если у них был alarm — они и сами проснутся)
     либо заново `start`;
   - живым занятым — `reply` с очередным шагом;
   - новым задачам — `start` с `reply_to_session_id`.
4. Прогресс — в файл репозитория (docs/YYYY-MM-DD-*.md), не только в контексте.
5. Завершение — `reply` родителю/себе с `DONE:`; при необходимости
   `DELETE /alarm?clear=true`, чтобы штатный babysitter снова работал.

Готовый шаблон координатора (для Claude):
[docs/coordinator-prompt-template.md](coordinator-prompt-template.md) —
та же механика, только id там берётся из `[Session Manager Context]`.

---

## Подводные камни

- **Будильник ≠ будильник для живых.** Не поставит план «буди каждые 5 минут»
  на работающий процесс — он сработает только после его смерти/простоя.
  Периодические пинги работающих — через `reply`.
- **`check_after_ms < 1000` отклоняется** (400), дефолт 180000.
- **`DELETE /alarm` — это не «снять таймер», а полный отказ от babysitter**
  (crash/stall тоже перестают обрабатываться). Вернуть — `?clear=true`.
- **Codex/OpenCode resume открывает терминал** — видимое окно TUI, а не
  незаметный фоновый процесс. Для опенкода `reply` всегда открывает новый
  терминал даже если сессия уже открыта — следи, чтобы не плодить
  дубликаты TUI.
- Самопитание от дурацких петель: babysitter-стопор
  (`detectBabysitterLoop`) прерывает серию неэффективных возобновлений
  (~4 резюма) — не закладывайся на бесконечные автопинги без прогресса.
- Остановить чужую насильно: `POST /api/sessions/{id}/kill`.

---

## Связанное

- [docs/delegation-guide.md](delegation-guide.md) — спавн воркеров, отчётность, persistence-правила.
- [docs/spawn-guide.md](spawn-guide.md) — куда реально попадает `path`, worktree.
- [docs/coordinator-prompt-template.md](coordinator-prompt-template.md) — промпт координатора.
- [docs/multi-executor-architecture.md](multi-executor-architecture.md) — картина целиком.
