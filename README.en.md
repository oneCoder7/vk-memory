# OpenClaw Local Memory Plugin (Viking Local + Mem0)

[中文](./README.md) | [English](./README.en.md)


This plugin is designed to be simple to adopt:
- Take over OpenClaw `plugins.slots.memory`
- Capture every round incrementally into local timeline
- Distill durable long-term memory via Mem0 OSS
- Recall relevant memory before each round starts

All local data is stored under `~/.viking-memory`.

## 1. 3-Minute Quick Start

### 1.1 Prerequisites

1. Docker + Docker Compose v2
2. Node.js >= 22
3. OpenClaw CLI (`npm i -g openclaw`)
4. One OpenAI-compatible LLM API key (for Mem0 summarization only)

Notes:
- Default local stack is only 4 containers: `mem0` + `qdrant` + `infinity-embed` + `infinity-rerank`.
- Qdrant + Infinity are local containers, no extra embedding API key required.
- Any OpenAI-compatible provider is supported (OpenAI, OpenRouter, DeepSeek, SiliconFlow, Volcengine Ark, etc.).

### 1.2 Install and bind memory slot

macOS / Linux:

```bash
cd /path/to/memory-plugin
bash ./install.sh
```

Windows PowerShell:

```powershell
cd C:\path\to\memory-plugin
.\install.ps1
```

Install script will:
1. Copy plugin to `~/.openclaw/extensions/memory-viking-local`
2. Set `plugins.slots.memory=memory-viking-local`
3. Create global command `vk-memory`

### 1.3 First run

```bash
vk-memory setup
vk-memory start
openclaw gateway
```

Check slot ownership:

```bash
openclaw config get plugins.slots.memory
# expected: memory-viking-local
```

## 2. Global Commands

```bash
vk-memory help
```

| Command | Purpose |
|---|---|
| `vk-memory setup` | First-time init (plugin JSON + Docker stack `.env`) |
| `vk-memory config` | Update existing config (including `debugLogs`) |
| `vk-memory start` | Start local memory stack (`docker compose up -d`) |
| `vk-memory stop` | Stop local memory stack |
| `vk-memory status` | Show stack status |
| `vk-memory migrate` | Import existing OpenClaw local file memory |
| `vk-memory uninstall` | Remove memory-viking-local config, extension directory, and global `vk-memory` command (keep `~/.viking-memory`) |

## 3. Migrate Existing OpenClaw Memory (Local File Mode)

If you already have memory in local OpenClaw workspace files, migrate once:

```bash
vk-memory migrate
```

Default source:
- `~/.openclaw/workspace/MEMORY.md`
- `~/.openclaw/workspace/memory/*.md`

Important:
- Only local file memory is supported here.

Useful options:

```bash
vk-memory migrate --dry-run
vk-memory migrate --workspace=~/.openclaw/workspace --chunk-chars=1200
vk-memory migrate --root=~/.viking-memory
```

Constraint:
- `--root` must stay inside `~/.viking-memory` (plugin data boundary).

After migration:
1. Migrated records are written into `~/.viking-memory/memories/*` and `index/catalog.json`
2. When plugin starts, semantic backfill upserts these records into local Qdrant automatically

Uninstall plugin config + extension directory + global command (keep memory files):

```bash
vk-memory uninstall
```

## 4. Memory vs Timeline

This is the key model:

1. `timeline` = raw conversation event stream (high coverage, short/mid-term details)
- Captured on every `agent_end`
- Keeps recent details that may not be durable yet

2. `memory` = distilled durable facts (high value, low noise)
- Written after extraction window is reached
- Stores stable preferences, constraints, long-term decisions

In short:
- `timeline` prevents detail loss
- `memory` prevents noise overload

## 5. Why Recall Both

The plugin does not blindly inject both every time.
It searches both indexes and injects only matched results.

Why two channels:
1. `memory` only can miss fresh details not distilled yet.
2. `timeline` only can be noisy and weak on stable long-term facts.
3. Combined recall gives durable facts + recent context together.

Timeline recall excludes current session by default to reduce echo.

## 6. Round Lifecycle (When Pull/Store Happens)

### 6.1 Before a round (`before_agent_start`)

1. Build query from latest user text/prompt
2. Search `memory` + `timeline`
3. Inject only hits as `prependContext`
4. No hits -> no injection

Example injection shape:

```text
<relevant-memories>
1. [preference] User prefers Vim
   overview: Category: preference ...
</relevant-memories>

<relevant-timeline>
1. [user] We moved release window to Wednesday yesterday
   session: default
   overview: Session: default Role: user ...
</relevant-timeline>
```

### 6.2 After a round (`agent_end`)

1. Write incremental messages into timeline (always)
2. Check extraction window
3. If reached, call Mem0 extraction
4. Store extracted items into durable memory

Default extraction window:
- `pendingRounds >= 2 && pendingChars >= 200`
- or forced when `pendingTurns >= 12`

## 7. What L0/L1/L2 Means Here

Both `memory` and `timeline` use L0/L1/L2:

1. L0 (index)
- memory: `~/.viking-memory/index/catalog.json`
- timeline: `~/.viking-memory/timeline/index/catalog.json`

2. L1 (summary)
- `.abstract.md` + `.overview.md`

3. L2 (detail)
- `content.md` + `meta.json`
- Loaded lazily on demand (not eagerly every round)

## 8. Storage Layout

```text
~/.viking-memory/
├── index/
│   └── catalog.json
├── memories/
│   └── <memory-id>/
│       ├── .abstract.md
│       ├── .overview.md
│       ├── content.md
│       └── meta.json
└── timeline/
    ├── index/
    │   └── catalog.json
    ├── chunks/
    │   └── <chunk-id>/
    │       ├── .abstract.md
    │       ├── .overview.md
    │       ├── content.md
    │       └── meta.json
    └── sessions/
        └── <session-id>/
            └── state.json
```

## 9. Config Files

1. Plugin config: `~/.viking-memory/plugin.env.json`
- Managed by `vk-memory setup/config`
- Useful toggle: `debugLogs` (default `false`)

2. Stack env: `deploy/local-stack/.env`
- Template: [`deploy/local-stack/.env.example`](./deploy/local-stack/.env.example)
- Required: `MEM0_LLM_API_KEY`

## 10. Default Ports

- Mem0: `18888`
- Qdrant: `16333`
- Infinity Embed: `17997`
- Infinity Rerank: `17998`

If ports are changed, you may also need:
- `VIKING_MEMORY_MEM0_URL`
- `VIKING_MEMORY_QDRANT_URL`
- `VIKING_MEMORY_EMBEDDING_URL`
- `VIKING_MEMORY_RERANK_URL`

## 11. FAQ

1. Why does it feel like everything is timeline?
- Timeline is written every round by design; durable memory is batch-distilled by extraction window.

2. Why recall both memory and timeline?
- Timeline preserves fresh details; memory preserves stable facts. One channel alone loses signal.

3. Why does `openclaw memory status` not match this plugin behavior?
- `openclaw memory` CLI reflects OpenClaw built-in memory indexing view, not necessarily your active memory-slot plugin data plane.
- Trust `plugins.slots.memory` + plugin logs for slot-level behavior.

4. How to enable verbose logs?
- `vk-memory config --advanced`
- Set `debugLogs = y`
- Restart `openclaw gateway`

## 12. Troubleshooting

1. `vk-memory: command not found`
- Add `~/.local/bin` to PATH and reopen terminal.

2. `vk-memory start` says `MEM0_LLM_API_KEY` is empty
- Run `vk-memory config` and set it.

3. Mem0 extraction not running
- `vk-memory status`
- `cd deploy/local-stack && docker compose logs -f mem0`

4. Semantic recall is empty
- Check qdrant/infinity containers
- If ports changed, verify `VIKING_MEMORY_*` env overrides

## 13. Manual Fallback (No Wrapper)

```bash
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js setup
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js start
```
