# Claude Code Session Manager — GCE VM Setup Guide

Гайд по установке Session Manager на GCE VM для управления Claude Code сессиями через HTTP API.

## Зачем

Session Manager включает **Session Orchestrator** — слой, который:
- Запускает Claude Code CLI как subprocess, стримит вывод по SSE
- Автоматически ретраит краши (до 3 раз)
- Детектит зависания и посылает `continue`
- Управляет очередью задач с приоритетами и concurrency-лимитом
- Эскалирует permission loops

Ваш агент просто делает HTTP-запросы и читает SSE-стрим. Все edge cases — проблема оркестратора.

```
your-agent (Express/WS)
    │
    │  POST http://localhost:3000/api/sessions/start
    │  POST http://localhost:3000/api/sessions/{id}/reply
    │  POST http://localhost:3000/api/sessions/{id}/kill
    ▼
Session Manager (Next.js, port 3000)
    │
    │  spawn("claude", ["--resume", id, "-p", msg, ...])
    ▼
Claude Code CLI → reads/writes code, git, APIs
```

---

## 1. Установка

```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Session Manager
cd /opt
git clone <repo-url> claude-session-manager
cd claude-session-manager
npm install
npm run build
```

## 2. API Key

```bash
# Из GCP Secret Manager
export ANTHROPIC_API_KEY=$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY)

# Проверка — Claude CLI работает
claude --version
echo "say hi" | claude -p --output-format stream-json
```

## 3. Настройки

```bash
mkdir -p ~/.config/claude-session-manager

cat > ~/.config/claude-session-manager/settings.json << 'EOF'
{
  "dangerously_skip_permissions": "true",
  "effort_level": "high",
  "max_turns": "80",
  "orchestrator_max_concurrent": "3",
  "orchestrator_crash_retry_delay_ms": "30000",
  "orchestrator_max_retries": "3",
  "babysitter_enabled": "true",
  "scan_interval_seconds": "30"
}
EOF
```

> `dangerously_skip_permissions: true` — **обязательно** на headless VM, иначе Claude зависнет на интерактивном одобрении tool calls.

## 4. Systemd сервис

```bash
sudo tee /etc/systemd/system/claude-session-manager.service << 'EOF'
[Unit]
Description=Claude Session Manager
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/opt/claude-session-manager
ExecStart=/usr/bin/node node_modules/.bin/next start -p 3000
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=ANTHROPIC_API_KEY=your-key-here

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable claude-session-manager
sudo systemctl start claude-session-manager
```

## 5. Проверка

```bash
# Сервер
curl http://localhost:3000/api/health | python3 -m json.tool

# Оркестратор (пустая очередь)
curl http://localhost:3000/api/orchestrator | python3 -m json.tool
```

## 6. Безопасность

Порт 3000 **не открывать** наружу. Агент на той же VM ходит по `localhost`.

Для удалённого просмотра UI:
```bash
# SSH tunnel с вашего ноутбука
ssh -L 3000:localhost:3000 user@vm-ip
# Затем открыть http://localhost:3000/claude-sessions в браузере
```

---

## API Reference

### Запустить сессию

```
POST /api/sessions/start
Content-Type: application/json

{
  "path": "/path/to/project",
  "message": "Добавь валидацию email в src/validators.ts",
  "verbose": true
}
```

**Response:** SSE stream (`text/event-stream`)

```
data: {"type":"session_id","session_id":"abc-123-def"}

data: {"type":"text","text":"Я посмотрю файл validators.ts..."}

data: {"type":"status","text":"Using tool: Read"}

data: {"type":"text","text":"Добавил валидацию email."}

data: {"type":"done","result":"success","is_error":false,"cost":0.042}
```

Типы SSE-событий:

| type | Описание | Поля |
|------|----------|------|
| `session_id` | ID созданной сессии (приходит первым) | `session_id` |
| `text` | Текст от Claude (стримится кусками) | `text` |
| `status` | Статус действия | `text` (напр. `"Using tool: Edit"`) |
| `error` | Ошибка | `text` |
| `done` | Сессия завершена | `result`, `is_error`, `cost` |

**`verbose: true`** — дополнительно шлёт события с `type: "debug"`:

| subtype | Описание | Поля |
|---------|----------|------|
| `tool_input` | Вход инструмента (файл, команда, etc.) | `tool`, `input` |
| `usage` | Токены за это сообщение | `usage: {input_tokens, output_tokens, cache_read_input_tokens}`, `model` |
| `thinking` | Мысли Claude (extended thinking) | `text` |
| `system` | Системные события (compaction, etc.) | `event` (полный объект) |

Пример verbose-вывода:
```
data: {"type":"session_id","session_id":"abc-123"}

data: {"type":"status","text":"Using tool: Read"}

data: {"type":"debug","subtype":"tool_input","tool":"Read","input":{"file_path":"/opt/project/src/validators.ts"}}

data: {"type":"text","text":"Я вижу файл validators.ts..."}

data: {"type":"debug","subtype":"usage","usage":{"input_tokens":1200,"output_tokens":350},"model":"claude-opus-4-6"}

data: {"type":"done","result":"success","is_error":false,"cost":0.042}
```

Keepalive-пинги (каждые 15с, игнорировать):
```
: keepalive
```

---

### Продолжить сессию (reply)

```
POST /api/sessions/{sessionId}/reply
Content-Type: application/json

{
  "message": "Теперь добавь тесты",
  "verbose": true
}
```

**Response:** тот же SSE формат. Оркестратор сам добавляет `--resume {sessionId} --max-turns 80`.

---

### Остановить сессию

```
POST /api/sessions/{sessionId}/kill
```

**Response:**
```json
{
  "killed": 1,
  "pids": [12345]
}
```

---

### Статус оркестратора

```
GET /api/orchestrator
```

**Response:**
```json
{
  "queue": {
    "pending": 0,
    "running": 1,
    "maxConcurrent": 3,
    "tasks": [
      {
        "id": "start:abc-123",
        "type": "start",
        "priority": "normal",
        "sessionId": "abc-123",
        "state": "running"
      }
    ]
  },
  "sessions": [
    {
      "sessionId": "abc-123",
      "phase": "running",
      "projectPath": "/opt/my-project",
      "pid": 12345,
      "retryCount": 0,
      "lastActivity": 1711000000000,
      "startedAt": 1711000000000
    }
  ]
}
```

Фазы сессии: `idle` → `running` → `completed` | `crashed` → `retrying` → `running` | `stalled` → `continuing` → `running` | `failed`

---

### Список сессий

```
GET /api/sessions?limit=20&sort=modified
```

**Response:**
```json
{
  "sessions": [
    {
      "session_id": "abc-123",
      "project_path": "/opt/my-project",
      "first_prompt": "Добавь валидацию...",
      "generated_title": "Email validation",
      "is_active": true,
      "message_count": 12,
      "total_input_tokens": 15000,
      "total_output_tokens": 3200,
      "created_at": "2026-03-20T10:00:00Z",
      "modified_at": "2026-03-20T10:05:00Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

### Детали сессии (с сообщениями)

```
GET /api/sessions/{sessionId}
```

**Response:**
```json
{
  "session_id": "abc-123",
  "messages": [
    { "type": "user", "content": "Добавь валидацию...", "timestamp": "..." },
    { "type": "assistant", "content": [{"type": "text", "text": "..."}], "timestamp": "..." }
  ],
  "messages_total": 12,
  "is_active": false,
  "has_result": true
}
```

---

### Настройки (чтение / запись)

```bash
# Читать
GET /api/settings

# Записать
PUT /api/settings
Content-Type: application/json

{"orchestrator_max_concurrent": "5"}
```

---

## Node.js клиент (пример для агента)

```typescript
const SM = 'http://localhost:3000';

interface SSEEvent {
  type: 'session_id' | 'text' | 'status' | 'done' | 'error' | 'debug';
  [key: string]: unknown;
}

interface SSECallbacks {
  onText?: (text: string) => void;
  onDebug?: (event: SSEEvent) => void;
}

/** Универсальный SSE-парсер */
async function parseSSE(
  res: Response,
  callbacks: SSECallbacks
): Promise<{ sessionId: string; fullText: string; cost: number; totalTokens: number }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  let sessionId = '';
  let fullText = '';
  let cost = 0;
  let totalTokens = 0;
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      if (part.startsWith(': ')) continue; // keepalive
      if (!part.startsWith('data: ')) continue;

      const data: SSEEvent = JSON.parse(part.slice(6));

      switch (data.type) {
        case 'session_id':
          sessionId = data.session_id as string;
          break;
        case 'text':
          fullText += data.text;
          callbacks.onText?.(data.text as string);
          break;
        case 'done':
          cost = (data.cost as number) || 0;
          break;
        case 'error':
          throw new Error(`Claude error: ${data.text}`);
        case 'debug':
          if (data.subtype === 'usage') {
            const u = data.usage as { input_tokens?: number; output_tokens?: number };
            totalTokens += (u.input_tokens || 0) + (u.output_tokens || 0);
          }
          callbacks.onDebug?.(data);
          break;
      }
    }
  }

  return { sessionId, fullText, cost, totalTokens };
}

/** Запустить Claude Code сессию */
async function runClaude(
  projectPath: string,
  prompt: string,
  callbacks: SSECallbacks = {},
  verbose = false
) {
  const res = await fetch(`${SM}/api/sessions/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath, message: prompt, verbose }),
  });
  if (!res.ok) throw new Error(`Start failed: ${res.status}`);
  return parseSSE(res, callbacks);
}

/** Продолжить существующую сессию */
async function replyClaude(
  sessionId: string,
  message: string,
  callbacks: SSECallbacks = {},
  verbose = false
) {
  const res = await fetch(`${SM}/api/sessions/${sessionId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, verbose }),
  });
  if (!res.ok) throw new Error(`Reply failed: ${res.status}`);
  return parseSSE(res, callbacks);
}

/** Убить сессию */
async function killClaude(sessionId: string): Promise<void> {
  await fetch(`${SM}/api/sessions/${sessionId}/kill`, { method: 'POST' });
}
```

### Пример использования

```typescript
// Без verbose — только текст
const { sessionId, fullText, cost } = await runClaude(
  '/opt/recruiting-agent',
  'Прочитай src/scoring.ts и объясни как работает скоринг',
  { onText: (chunk) => process.stdout.write(chunk) }
);
console.log(`\nSession: ${sessionId}, cost: $${cost}`);

// С verbose — видим токены, tool inputs, thinking
const result = await runClaude(
  '/opt/recruiting-agent',
  'Добавь валидацию email',
  {
    onText: (chunk) => process.stdout.write(chunk),
    onDebug: (evt) => {
      if (evt.subtype === 'tool_input') {
        console.log(`\n  [tool] ${evt.tool}:`, JSON.stringify(evt.input).slice(0, 200));
      } else if (evt.subtype === 'usage') {
        const u = evt.usage as { input_tokens: number; output_tokens: number };
        console.log(`\n  [tokens] in=${u.input_tokens} out=${u.output_tokens}`);
      }
    }
  },
  true // verbose
);
console.log(`\nTotal tokens: ${result.totalTokens}, cost: $${result.cost}`);

// Продолжить ту же сессию
const reply = await replyClaude(
  sessionId,
  'Теперь добавь логирование в функцию calculateScore',
  (chunk) => process.stdout.write(chunk)
);
```

---

## Что оркестратор делает автоматически

| Ситуация | Что происходит | Ваш агент делает |
|----------|---------------|-----------------|
| Claude упал (crash) | Авто-retry через 30с, до 3 раз | Ничего — `done` придёт после retry |
| Claude завис (>5 мин тишины) | Детектит, спрашивает Haiku "ждёт ли ввода?", шлёт `continue` | Ничего |
| Permission loop | Убивает, перезапускает с `--dangerously-skip-permissions` | Ничего |
| Процесс умер на полуслове | Детектит incomplete exit, resume | Ничего |
| 4+ одновременных запроса при лимите 3 | Ставит в очередь, выполняет по приоритету | Просто шлёт запросы |

---

## Мониторинг

```bash
# Логи
journalctl -u claude-session-manager -f

# Health check (CLI, directories, settings)
curl localhost:3000/api/health

# Диагностика активных сессий
curl localhost:3000/api/diagnostics

# Web UI — через SSH tunnel
ssh -L 3000:localhost:3000 user@vm-ip
# Открыть http://localhost:3000/claude-sessions
```

---

## Настройки оркестратора

Меняются через API без рестарта:

```bash
curl -X PUT http://localhost:3000/api/settings \
  -H "Content-Type: application/json" \
  -d '{"orchestrator_max_concurrent": "5"}'
```

| Ключ | Default | Описание |
|------|---------|----------|
| `orchestrator_max_concurrent` | `3` | Макс. одновременных Claude процессов |
| `orchestrator_crash_retry_delay_ms` | `30000` | Задержка перед retry после краша |
| `orchestrator_stall_continue_delay_ms` | `10000` | Задержка перед auto-continue при stall |
| `orchestrator_max_retries` | `3` | Макс. retries перед статусом `failed` |
| `dangerously_skip_permissions` | `true` | Пропускать интерактивные подтверждения |
| `max_turns` | `80` | Макс. tool-use циклов за один reply |
| `effort_level` | `high` | Уровень усилий Claude (`low`/`medium`/`high`) |
