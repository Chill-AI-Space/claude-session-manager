# Multi-Executor Architecture

Session Manager как **control plane**, который маршрутизирует Claude Code сессии на несколько **executor'ов** — локальных и облачных.

---

## Проблема

Сейчас Session Manager = монолит: UI + оркестратор + Claude CLI — всё на одной машине. Если добавляешь облачную VM, она живёт отдельно, невидима, забывается. Два сервиса на одной тачке путаются. Нет единого окна для всей инфраструктуры.

## Ключевая идея

```
Session Manager = Control Plane (UI + роутинг)
                + N Executor'ов (места где реально крутится Claude Code)
```

**Control Plane** — один на юзера (ноутбук/десктоп). Показывает ВСЁ.
**Executor** — место где запускается Claude CLI. Их может быть 1, 2, 10.

---

## Core Concepts

### Executor

Вычислительный бэкенд где запускается Claude Code CLI.

```typescript
interface Executor {
  id: string;                    // "local" | "node-xxx-yyy"
  name: string;                  // "This Mac" | "claude-code-vm" | "heavy-gpu"
  type: "local" | "remote";
  address?: string;              // "http://34.30.50.239:3000" (remote only)

  // Capabilities
  maxConcurrent: number;         // сколько параллельных сессий
  projects: string[];            // какие проекты доступны (remote: git repos on VM)

  // Live state (обновляется polling'ом)
  status: "online" | "offline" | "degraded";
  activeSessions: number;
  queueDepth: number;
  lastSeen: number;              // timestamp
}
```

**Local executor** — всегда есть, zero config. Это текущая машина.
**Remote executor** — зарегистрированная VM с CSM в headless режиме.

### Сессия привязана к executor'у навсегда

Сессия запускается на конкретном executor'е и ЖИВЁТ там. Нельзя "переехать" на другой executor — Claude Code привязан к файловой системе, JSONL, контексту.

```
Session X → started on executor Y → all operations go to Y → forever
```

### Control Plane

Единственный Session Manager с UI. Знает все executor'ы, роутит операции, мержит данные.

---

## Data Flow

### New Session (user выбирает ГДЕ)

```
┌─────────────────────────────────────────────────┐
│                                                   │
│  "Fix the auth bug in login.ts"                  │
│                                                   │
│  [Project: ~/my-project ▾]                       │
│                                                   │
│  ┌──────────────┐                                │
│  │ 🖥 This Mac  ▾│         [Start Session →]     │
│  │ ☁ cloud-vm-1  │                               │
│  │ ☁ cloud-vm-2  │                               │
│  └──────────────┘                                │
└─────────────────────────────────────────────────┘
```

Flow:
1. User набирает сообщение, выбирает executor из dropdown
2. `POST /api/sessions/start?executor=cloud-vm-1`
3. Control plane → proxy к executor'у
4. Executor запускает Claude CLI, стримит SSE
5. SSE проходит через control plane → браузер
6. Первый event `session_id` → control plane сохраняет маппинг:
   `session_executor_map: { session_id → executor_id }`
7. Все будущие операции автоматически роутятся

### Reply (автоматический роутинг)

```
User отвечает в сессию X
  → Control plane ищет: session X → executor Y (из маппинга)
  → POST /api/sessions/X/reply?node=Y (подставляется автоматически)
  → Executor Y стримит SSE обратно
  → User не думает где это крутится
```

Для reply **не нужен** выбор executor'а. Сессия уже где-то живёт.

### Session List (unified view)

```
Control plane параллельно запрашивает:
  ├── Local DB (свои сессии)
  ├── GET cloud-vm-1/api/sessions
  └── GET cloud-vm-2/api/sessions

Мержит → сортирует по дате → рендерит с бейджами:

┌──────────────────────────────────────────────────────┐
│ 🖥  Fix auth bug              2m ago     ● active    │
│ ☁₁ Refactor database          5m ago     ● active    │
│ ☁₁ Full code review           1h ago                 │
│ 🖥  Add unit tests            3h ago                 │
│ ☁₂ ML pipeline setup          1d ago                 │
└──────────────────────────────────────────────────────┘

🖥 = local    ☁₁ = cloud-vm-1    ☁₂ = cloud-vm-2
```

---

## Persistent Mapping: session → executor

Критически важно: при перезагрузке control plane должен помнить какая сессия на каком executor'е.

```sql
-- Новая таблица в локальной БД
CREATE TABLE session_executor_map (
  session_id TEXT PRIMARY KEY,
  executor_id TEXT NOT NULL,
  executor_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Когда заполняется:**
- При `start` — из SSE event `session_id`
- При `fetchRemoteSessions` — для всех remote сессий в списке
- Кэширует: если executor offline, всё равно знаем что сессия remote

**Когда используется:**
- При `reply` — auto-lookup executor'а (UI не передаёт `?node=`)
- При `GET session detail` — auto-proxy
- При `kill` — auto-proxy
- Offline: показываем cached metadata даже если VM недоступна

---

## Executor Health & Monitoring

Control plane пингует каждый executor каждые 30 секунд:

```
GET /api/orchestrator → queue, active sessions
GET /api/status       → uptime, disk, memory (новый endpoint)
```

### Header Status Bar (всегда видно)

```
┌──────────────────────────────────────────────────────────┐
│ Session Manager    🖥 Local: 2 active  │ ☁ cloud-vm: 1  │
│                                        │ ☁ gpu-vm: offline│
└──────────────────────────────────────────────────────────┘
```

Или компактнее — иконки в углу:
```
🖥2 ☁1 ⚠1
```
Hover → tooltip с деталями. Click → executor dashboard.

### Executor Dashboard (в Settings или отдельная страница)

```
┌─────────────────────────────────────────────┐
│ claude-code-vm         ● Online             │
│ 34.30.50.239:3000      Last seen: just now  │
│                                             │
│ Sessions: 1 active, 23 total                │
│ Queue: 0 pending, 3 max concurrent          │
│ Disk: 12GB free / 19GB                      │
│ RAM: 1.3GB free / 2GB                       │
│ Claude CLI: v2.1.79                         │
│                                             │
│ [Ping] [View Sessions] [Open Web UI]        │
└─────────────────────────────────────────────┘
```

---

## New User Onboarding

### Сценарий 1: Первый запуск (99% юзеров)

```
Welcome to Session Manager!

Claude Code sessions will run on this machine by default.

[Get Started →]
```

Local executor — zero config. Работает сразу.

### Сценарий 2: Добавить облачный executor

Settings → Remote Nodes → Add Executor:

```
┌─────────────────────────────────────────────┐
│ Add Cloud Executor                          │
│                                             │
│ ○ I have a VM with CSM installed            │
│   → Enter address, test connection          │
│                                             │
│ ○ I want to create a new VM (coming soon)   │
│   → One-click GCP/AWS deploy                │
│                                             │
│ Name: [my-cloud-vm            ]             │
│ Address: [http://1.2.3.4:3000  ]            │
│                                             │
│ [Test Connection]  [Add Executor]           │
└─────────────────────────────────────────────┘
```

После добавления → executor появляется в dropdown при New Session.

### Сценарий 3: Cloud-first (продвинутый)

User ставит CSM на ноутбук только как UI. Весь compute на VM.

Settings → Default Executor → cloud-vm.

Все новые сессии автоматически идут в облако. Dropdown предзаполнен.

---

## Умный роутинг (future)

Вместо ручного выбора — автоматический:

| Правило | Executor |
|---------|----------|
| Проект `~/work/heavy-repo` | cloud-vm (большой репо, нужен мощный диск) |
| Проект `~/personal/*` | local (приватный код) |
| Все остальные | default (настройка) |
| Queue на cloud-vm полная | fallback на local |

```typescript
interface RoutingRule {
  pattern: string;        // glob для project path
  executor: string;       // executor id
  fallback?: string;      // куда если primary offline/busy
}
```

Настраивается в Settings. Но это future — сначала ручной выбор.

---

## Безопасность

### Текущие проблемы

1. **Нет auth на API** — кто угодно может дёрнуть `/api/sessions/start` на VM
2. **Порт открыт в интернет** — firewall rule на 3000 без IP ограничения
3. **Нет шифрования** — HTTP, не HTTPS

### Рекомендованная схема

```
Уровень 1 (минимум): Bearer token
  - Executor при старте генерирует токен
  - Control plane шлёт: Authorization: Bearer <token>
  - Всё через HTTP но с auth

Уровень 2 (рекомендация): Tailscale
  - Оба конца в Tailscale mesh
  - Порт 3000 закрыт в firewall
  - Доступ только через Tailscale IP (100.x.x.x)
  - Шифрование из коробки, zero-config auth

Уровень 3 (enterprise): mTLS
  - Клиентские сертификаты
  - Для случаев когда Tailscale не вариант
```

Для MVP: **Bearer token** + **IP whitelist** в GCP firewall.

---

## Архитектура компонентов

```
┌─ Control Plane (Local Mac) ───────────────────────────────────┐
│                                                                │
│  Next.js UI (:3000)                                           │
│  ├── Session List (merged from all executors)                  │
│  ├── Session Detail (auto-proxy to right executor)             │
│  ├── New Session (executor dropdown)                           │
│  ├── Executor Dashboard (health, stats)                        │
│  └── Settings (executor registry, routing rules)               │
│                                                                │
│  API Layer                                                     │
│  ├── /api/sessions/* → ExecutorRouter → local | proxy(remote)  │
│  ├── /api/executors → registry CRUD + health                   │
│  └── /api/remote-compute → status endpoint                     │
│                                                                │
│  ExecutorRouter (src/lib/remote-compute.ts)                    │
│  ├── resolveExecutor(sessionId) → looks up mapping             │
│  ├── proxySSE(executor, path, body) → stream pipe              │
│  ├── proxyJSON(executor, path) → REST proxy                    │
│  └── healthCheck() → poll all executors                        │
│                                                                │
│  Local DB                                                      │
│  ├── sessions (local sessions)                                 │
│  ├── session_executor_map (session → executor mapping)         │
│  ├── remote_session_cache (cached metadata from remotes)       │
│  └── settings                                                  │
│                                                                │
│  Local Orchestrator (for local sessions only)                  │
│  └── start/resume/stop/crash-retry/stall-continue              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
        │                              │
        │ Direct HTTP                  │ Direct HTTP
        ▼                              ▼
┌─ Executor 1 (cloud-vm) ────┐ ┌─ Executor 2 (gpu-vm) ────────┐
│                              │ │                               │
│  CSM Headless (:3000)        │ │  CSM Headless (:3000)         │
│  ├── Orchestrator            │ │  ├── Orchestrator             │
│  ├── Claude CLI              │ │  ├── Claude CLI               │
│  ├── Session DB              │ │  ├── Session DB               │
│  └── Babysitter (auto-mgmt) │ │  └── Babysitter               │
│                              │ │                               │
│  Git repos (projects)        │ │  Git repos + GPU tools        │
│  CLAUDE.md, MCP servers      │ │  CLAUDE.md, MCP servers       │
│                              │ │                               │
└──────────────────────────────┘ └───────────────────────────────┘
```

---

## Терминология (переименование)

Текущее "Remote Nodes" → **Executors**. Более точное и понятное имя.

| Было | Стало |
|------|-------|
| Remote Node | Executor |
| Default Compute Node | Default Executor |
| remote_nodes (setting) | executors (setting) |
| RemoteNodesSettings | ExecutorSettings |
| `?node=` | `?executor=` |

---

## Phases

### Phase 1 ✅ Proxy Layer (done)
- `remote-compute.ts` — SSE + JSON proxy
- API routes с `?node=` параметром
- `default_compute_node` setting

### Phase 2: UI Visibility (next)
- Executor badge в session list (🖥/☁)
- Executor selector в New Session compose area
- Header status indicator
- Auto-routing для reply/kill (lookup session→executor mapping)

### Phase 3: Persistent Mapping
- `session_executor_map` таблица
- Auto-save при start
- Auto-lookup при reply/kill/view
- Cached remote session metadata для offline

### Phase 4: Executor Dashboard
- Health polling (30s interval)
- Status page с метриками
- Alerts при offline

### Phase 5: Security
- Bearer token auth между control plane и executors
- IP whitelist в firewall
- HTTPS (Caddy reverse proxy на executor)

### Phase 6: Smart Routing
- Per-project executor rules
- Auto-fallback при offline/busy
- Queue-aware routing

### Phase 7: One-Click Deploy
- `scripts/deploy-executor.sh` — создаёт VM, ставит CSM, настраивает
- GCP + AWS support
- Terraform/Pulumi template
