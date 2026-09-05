# PR Session Lifecycle Guide

Когда Claude создаёт PR — сессия не должна умирать. Этот гайд описывает полный цикл: от создания PR до мержа, с автоматическим восстановлением при CI-падениях и конфликтах.

---

## Как это работает

```
Claude создаёт PR
       ↓
В тело PR вставляется <!-- csm-session: UUID -->
       ↓
GitHub Actions job завершается (✅ / ❌ / ⚠️ merge conflict)
       ↓
Callback step POSTит результат → Session Manager
       ↓
Оркестратор enqueue resume для сессии
       ↓
Claude просыпается → читает результат → фиксит проблему
       ↓
Новый коммит → CI снова → цикл до мержа
```

Babysitter ловит падения, зависания и permission loops — всё это работает независимо от PR-цикла.

---

## Часть 1: Настройка репозитория (один раз)

### Шаг 1. Добавить GitHub Variable

В репозитории: **Settings → Secrets and variables → Actions → Variables → New repository variable**

| Variable | Value |
|---|---|
| `RELAY_NODE_ID` | `09934953-3827-4ac1-8458-37a8ffd1829e` |

> Node ID — это адрес твоей локальной машины в relay сети. Не меняется. Получить можно в Session Manager → Settings → Relay.

### Шаг 2. Добавить GitHub Actions workflow

Создай файл `.github/workflows/claude-pr-callback.yml`:

```yaml
name: Claude PR Callback

on:
  workflow_run:
    workflows: ["*"]          # ловим все workflows (CI, tests, lint)
    types: [completed]
  pull_request:
    types: [synchronize]      # новые коммиты в PR ветку
    
jobs:
  notify-claude:
    runs-on: ubuntu-latest
    if: github.event.pull_request != null || github.event.workflow_run != null
    
    steps:
      - name: Extract Claude session ID
        id: session
        run: |
          # Для pull_request событий
          if [ -n "${{ github.event.pull_request.body }}" ]; then
            BODY="${{ github.event.pull_request.body }}"
            PR_NUMBER="${{ github.event.pull_request.number }}"
          fi
          
          # Для workflow_run — найти PR по branch
          if [ -n "${{ github.event.workflow_run.head_branch }}" ]; then
            BRANCH="${{ github.event.workflow_run.head_branch }}"
            PR_JSON=$(gh pr list --head "$BRANCH" --json body,number --limit 1)
            BODY=$(echo "$PR_JSON" | jq -r '.[0].body // ""')
            PR_NUMBER=$(echo "$PR_JSON" | jq -r '.[0].number // ""')
          fi
          
          SESSION_ID=$(echo "$BODY" | grep -oP '(?<=<!-- csm-session: )[\w-]+(?= -->)' || true)
          echo "session_id=$SESSION_ID" >> $GITHUB_OUTPUT
          echo "pr_number=$PR_NUMBER" >> $GITHUB_OUTPUT
        env:
          GH_TOKEN: ${{ github.token }}

      - name: Build callback message
        id: message
        if: steps.session.outputs.session_id != ''
        run: |
          # Определяем статус
          if [ -n "${{ github.event.workflow_run.conclusion }}" ]; then
            STATUS="${{ github.event.workflow_run.conclusion }}"
            WORKFLOW="${{ github.event.workflow_run.name }}"
            RUN_URL="${{ github.event.workflow_run.html_url }}"
          else
            # pull_request синхронизация — новые коммиты
            STATUS="new_commits"
            WORKFLOW="push"
            RUN_URL="${{ github.server_url }}/${{ github.repository }}/pull/${{ steps.session.outputs.pr_number }}"
          fi
          
          # Проверяем merge conflict
          PR_NUMBER="${{ steps.session.outputs.pr_number }}"
          if [ -n "$PR_NUMBER" ]; then
            MERGEABLE=$(gh pr view "$PR_NUMBER" --json mergeable --jq '.mergeable' 2>/dev/null || echo "UNKNOWN")
          else
            MERGEABLE="UNKNOWN"
          fi
          
          # Формируем сообщение
          MSG="[CI CALLBACK] Workflow: $WORKFLOW | Status: $STATUS"
          if [ "$MERGEABLE" = "CONFLICTING" ]; then
            MSG="$MSG | ⚠️ MERGE CONFLICT — нужно rebase или разрешить конфликты"
          fi
          MSG="$MSG | URL: $RUN_URL"
          if [ "$STATUS" = "new_commits" ]; then
            MSG="[CI CALLBACK] Новые коммиты добавлены в PR #$PR_NUMBER. Проверь что твои изменения не нужно обновить."
          fi
          
          echo "message=$MSG" >> $GITHUB_OUTPUT

      - name: Notify Claude session via relay
        if: steps.session.outputs.session_id != '' && steps.message.outputs.message != ''
        run: |
          SESSION_ID="${{ steps.session.outputs.session_id }}"
          MESSAGE="${{ steps.message.outputs.message }}"
          NODE_ID="${{ vars.RELAY_NODE_ID }}"
          
          # Отправляем через relay (работает даже если Session Manager за NAT)
          RESPONSE=$(curl -sS --max-time 10 \
            -X POST "https://csm-relay.skillset-apply.workers.dev/node/$NODE_ID/enqueue" \
            -H "Content-Type: application/json" \
            -d "{\"type\": \"resume\", \"sessionId\": \"$SESSION_ID\", \"message\": $(echo "$MESSAGE" | jq -Rs .)}" \
            2>&1 || echo "relay_error")
          
          echo "Relay response: $RESPONSE"
          
          # Fallback: прямой URL если настроен
          if echo "$RESPONSE" | grep -q "relay_error"; then
            if [ -n "${{ vars.SESSION_MANAGER_URL }}" ]; then
              curl -sS --max-time 10 \
                -X POST "${{ vars.SESSION_MANAGER_URL }}/api/orchestrator" \
                -H "Content-Type: application/json" \
                -d "{\"type\": \"resume\", \"sessionId\": \"$SESSION_ID\", \"message\": $(echo "$MESSAGE" | jq -Rs .)}"
            fi
          fi
```

> **Почему `/enqueue` а не `/resume`?** Relay `/resume` открывает SSE-стрим, Actions не умеет его читать. `/enqueue` — fire-and-forget, сразу 200 OK.

---

## Часть 2: CLAUDE.md — инструкции для Claude

Добавь этот блок в CLAUDE.md своего репозитория:

```markdown
## PR Session Lifecycle — обязательные правила

Каждый раз при создании PR — **обязательно** выполни все шаги ниже.

### Шаг 1: Узнай свой session ID

```bash
curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)"
```

Если Session Manager не доступен — продолжай без callback (запиши в PR description что callback не настроен).

### Шаг 2: Создай PR с session ID в теле

```bash
gh pr create \
  --title "feat: ..." \
  --body "$(cat <<'EOF'
Описание PR...

<!-- csm-session: {SESSION_ID} -->
EOF
)"
```

Всегда вставляй `<!-- csm-session: {SESSION_ID} -->` **в тело PR** (не в заголовок, не в комментарий).

### Шаг 3: Установи self-alarm

```bash
curl -s -X POST "http://localhost:3000/api/sessions/{SESSION_ID}/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Проверь статус PR: запустился ли CI, нет ли конфликтов, нужны ли правки", "check_after_ms": 1800000}'
```

Alarm = страховка на случай если callback не пришёл. Срабатывает через 30 минут.

### Шаг 4: Дожидайся CI callback

Когда CI завершится — ты получишь сообщение формата:
```
[CI CALLBACK] Workflow: CI | Status: failure | URL: ...
```

**Если success** — проверь что PR готов к мержу (нет review requests, нет конфликтов), закрой alarm:
```bash
curl -s -X DELETE "http://localhost:3000/api/sessions/{SESSION_ID}/alarm"
```

**Если failure** — исправь ошибки, запушь, подожди следующего CI callback.

**Если `⚠️ MERGE CONFLICT`** — выполни rebase:
```bash
git fetch origin
git rebase origin/main
# При конфликтах:
git status  # посмотри что конфликтует
# отредактируй файлы
git add .
git rebase --continue
git push --force-with-lease
```

### Что делать если CI падает в цикле

Если CI падает 3+ раза подряд с одной ошибкой — напиши в PR comment объяснение и попроси human review. Не продолжай бесконечно.

### Ограничения

- Callback приходит только если в `.github/workflows/claude-pr-callback.yml` настроен workflow
- Relay работает пока Session Manager запущен на твоей машине
- Если сессия умерла — babysitter поднимет её при следующем CI callback (orchestrator enqueue resume)
```

---

## Часть 3: Тестирование

### Smoke-тест: relay работает

```bash
# Проверить что relay подключён
curl -s http://localhost:3000/api/relay | jq '.connected'
# → true

# Проверить enqueue через relay
RELAY_NODE_ID="09934953-3827-4ac1-8458-37a8ffd1829e"
curl -sS -X POST "https://csm-relay.skillset-apply.workers.dev/node/$RELAY_NODE_ID/enqueue" \
  -H "Content-Type: application/json" \
  -d '{"type": "resume", "sessionId": "test-smoke", "message": "smoke test"}'
# → {"ok":true} или ответ от оркестратора
```

### Smoke-тест: orchestrator принимает CI callbacks

```bash
curl -sS -X POST "http://localhost:3000/api/orchestrator" \
  -H "Content-Type: application/json" \
  -d '{"type":"resume","sessionId":"test-does-not-exist","message":"CI callback test"}'
# → {"taskId":"resume:test-does-not-exist","ok":true}
```

### Smoke-тест: прямой reply endpoint

```bash
SESSION_ID="реальный session ID из UI"
curl -sS -X POST "http://localhost:3000/api/sessions/$SESSION_ID/reply" \
  -H "Content-Type: application/json" \
  -d '{"message": "[CI CALLBACK] Workflow: test | Status: failure | URL: https://example.com/run/123"}' &
# Через несколько секунд Claude должен ответить в сессии
```

### Симуляция CI callback (без реального GitHub)

```bash
# Отправить фейковый CI failure в живую сессию
SESSION_ID="твой-session-id"
curl -sS -X POST "http://localhost:3000/api/orchestrator" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"resume\",\"sessionId\":\"$SESSION_ID\",\"message\":\"[CI CALLBACK] Workflow: CI | Status: failure | URL: https://github.com/org/repo/actions/runs/123456789\"}"
```

---

## Часть 4: Что уже работает автоматически (babysitter)

Даже без PR callback, babysitter страхует:

| Ситуация | Что происходит |
|---|---|
| Сессия упала (crash) | Auto-retry через 30 сек (до 3 раз) |
| Зависла > 5 мин (stall) | Haiku проверяет — waiting for user? Если нет — nudge |
| Права доступа нужны | Открывает terminal с `--dangerously-skip-permissions` |
| Умерла не закончив (incomplete exit) | Resume через 5 мин с контекстом о незаконченной работе |
| Permission loop | Эскалация в terminal |

Настроить в Settings → Babysitter.

---

## Часть 5: github_repo_path_map (для webhook без PR callback)

Если хочешь чтобы CI failures в любом репозитории автоматически порождали fix-сессию (без PR body snippet) — настрой маппинг репозиториев в Settings:

```json
{
  "org/repo-name": "/absolute/path/to/local/repo",
  "org/another-repo": "/Users/vova/Code/another-repo"
}
```

Настройка: `PUT /api/settings` с `{ "github_repo_path_map": "{\"org/repo\": \"/path\"}" }`.

При CI failure GitHub webhook → `workflow_run` event → оркестратор находит путь → запускает headless Claude fix-сессию с инструкцией "посмотри что упало, почини если просто".

---

## Быстрая шпаргалка для Claude

```bash
# 1. Узнать свой session ID
MY_SESSION=$(curl -s "http://localhost:3000/api/sessions/my-id?path=$(pwd)" | jq -r '.sessionId // empty')

# 2. Создать PR с callback
gh pr create --title "feat: X" --body "Описание.

<!-- csm-session: $MY_SESSION -->"

# 3. Поставить alarm
curl -s -X POST "http://localhost:3000/api/sessions/$MY_SESSION/alarm" \
  -H "Content-Type: application/json" \
  -d '{"message": "Проверь PR: CI статус, конфликты, review", "check_after_ms": 1800000}'

# 4. Ждать callback или alarm. При failure — fix и push.
```
