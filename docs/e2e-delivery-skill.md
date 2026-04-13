# E2E Delivery Skill

Claude как оркестратор: доводит задачу до прода, но код пишет Codex.

---

## Роли

| Агент | Роль |
|-------|------|
| **Claude** | Оркестратор, ревьюер, постановщик задач. Код не пишет (кроме исключений) |
| **Codex** | Исполнитель. Пишет код, коммитит, репортит DONE/FAILED |

---

## Когда Claude делегирует, а когда делает сам

**Делегирует Codex** — всё что связано с кодом: новые фичи, фиксы, рефакторинг, тесты, миграции.

**Делает сам** — только:
- Правка ≤ 5 строк и тривиально очевидная (быстрее сделать чем объяснить)
- Codex упал на одной задаче 2 раза подряд

Нет соблазна "быстро поправить самому" — это ломает цепочку ревью.

---

## Цикл на каждую задачу

```
Claude → [описать задачу] → Codex worker → DONE/FAILED
                                               │
                                    DONE → Claude review
                                               │
                                    OK → следующий шаг
                                    NEEDS_FIX → новый Codex worker с описанием правок
                                    FAILED (2×) → Claude делает сам
```

---

## Spawn Codex worker

Всегда читай SSE-ответ и захватывай `session_id` — иначе не узнаешь создалась ли сессия:

```bash
CHILD_ID=$(curl -s -N -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/REPO",
    "message": "Context: <что уже сделано, ветка>. Task: <конкретно что реализовать>. Constraints: <не деплоить, не трогать prod и тд>. Report DONE: <summary | committed: branch> or FAILED: <reason>.",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "implement: <описание>",
    "agent": "codex"
  }' | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\([^"]*\)".*/\1/')

if [ -z "$CHILD_ID" ]; then
  echo "ERROR: spawn failed — no session_id returned"
else
  echo "OK: spawned $CHILD_ID"
  # Verify it exists in DB
  curl -s "http://localhost:3000/api/sessions/$CHILD_ID" | grep -q '"session_id"' && echo "verified" || echo "WARN: session not in DB yet"
fi
```

**Обязательно:**
- `-N` (no-buffering) — без него curl буферизует SSE и ты не получишь session_id
- Проверяй что `CHILD_ID` не пустой перед тем как переходить дальше
- `agent: "codex"` — явно, всегда. Без него по умолчанию Claude, что неверно для кода
- `path` = корень репозитория. Не scratch-папка, не investigation — именно тот репо где живёт код

---

## Spawn Claude reviewer

После DONE от Codex (тот же паттерн с захватом session_id):

```bash
REVIEWER_ID=$(curl -s -N -X POST "http://localhost:3000/api/sessions/start" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/abs/path/to/REPO",
    "message": "Codex implemented: <task>. Codex report: <полный DONE-ответ>. Review the changes. Report DONE: verdict OK | committed: branch — or — DONE: verdict NEEDS_FIX: <what>. Do NOT write code — only review.",
    "reply_to_session_id": "YOUR_SESSION_ID",
    "delegation_task": "review: <описание>",
    "agent": "claude"
  }' | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/.*"session_id":"\([^"]*\)".*/\1/')

[ -z "$REVIEWER_ID" ] && echo "ERROR: reviewer spawn failed" || echo "OK: reviewer $REVIEWER_ID"
```

Ревьюер **не пишет код** — только анализирует и выносит вердикт.

---

## Определение "DONE"

Задача закрыта когда:
- [ ] Код написан и закоммичен в ветку
- [ ] Ревью: verdict OK
- [ ] PR создан, CI зелёный
- [ ] Задеплоено в прод (или на staging если прод требует ручного шага)
- [ ] Smoke test прошёл

Написать код ≠ сделать задачу. Задача сделана когда работает в проде.

---

## Самоконтроль — alarm

Перед каждой длинной операцией (spawn worker, ждать CI):

```bash
# Поставить alarm
curl -s -X POST "http://localhost:3000/api/sessions/YOUR_SESSION_ID/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Ты оркестратор. Задача: <что делаем>. Текущий шаг: <impl/review/ci>. Следующее: <что запустить>.", "check_after_ms": 600000}'
```

Alarm persistent — ставишь один раз, он переставляет себя автоматически.

---

## Ссылки

- **Делегирование (полный гайд):** [`docs/delegation-guide.md`](delegation-guide.md)
- **Координатор с планом и итерациями:** [`docs/coordinator-prompt-template.md`](coordinator-prompt-template.md)
