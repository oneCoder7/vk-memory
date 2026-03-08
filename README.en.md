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
| `vk-memory start` | Start local stack and run readiness/connectivity preflight (Mem0 LLM check included by default) |
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

## 5. Current Injection Policy (memory-only)

Current version injects `memory` only, not `timeline`:

1. Short-term continuity is maintained by OpenClaw native session context
2. Plugin injection focuses on stable long-term facts
3. `timeline` is used for post-round extraction windows and durable-memory generation

## 6. Round Lifecycle (When Pull/Store Happens)

### 6.1 Before a round (`before_agent_start`)

1. Build query from latest user text/prompt and compact metadata noise (`compactRecallQuery`)
2. Run L0 (`abstract`) semantic recall for `memory`
3. When candidates are ambiguous, run adaptive L1 (`overview`) rerank; L2 is not auto-injected
4. Dedup + dynamic topK trimming before final injection (relevance first)
5. Inject matched results as `prependContext`; no hits -> no injection

Example injection shape:

```text
<relevant-memories>
1. [preference] User prefers Vim
</relevant-memories>
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

Both `memory` and `timeline` use L0/L1/L2 (aligned with OpenViking semantics):

1. L0 (retrieval snapshot layer)
- `.<abstract>.md`

2. L1 (compressed overview layer)
- `.<overview>.md`

3. L2 (detail)
- `content.md` + `meta.json`
- Loaded lazily on demand (not eagerly every round)

Additionally:
- `index/catalog.json` and `timeline/index/catalog.json` are index metadata (retrieval entry), not separate L-layers.

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
- Defaults: `MEM0_LLM_TEMPERATURE=0.1`, `MEM0_LLM_MAX_TOKENS=300` (tunable via `vk-memory config --advanced`)

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

## 11. Performance Optimizations (Implemented)

The current version already includes the following optimizations (no extra config needed):

1. Query compaction

- Removes noisy metadata such as `Conversation info (untrusted metadata)` before retrieval.

1. Layered retrieval (L0 -> L1, L2 on demand)

- Vector retrieval indexes L0 `abstract` by default (lightweight and stable).
- L1 `overview` rerank only runs when candidates are ambiguous.
- L2 `content` is loaded only when manual `memory_recall` requests `includeDetails`.

1. Semantic recall cache (TTL 60s)

- Caches recall by `session + query + index revision`, reducing repeated retrieval latency on follow-up turns.

1. 10-round injection dedup

- Same URI will not be injected again within the latest 10 rounds in the same session.

1. Injection dedup

- Dedups memory injection lines by `sourceHash + abstract`.

1. Dynamic topK (relevance first)

- Under high confidence, memory injection is automatically shrunk to reduce prompt tokens.

## 12. FAQ

1. Why does it feel like everything is timeline?
- Timeline is written every round by design; durable memory is batch-distilled by extraction window.

2. Why inject memory only now?
- OpenClaw native session history already covers short-term continuity; plugin injection focuses on durable facts.

3. Can I filter by memory type?
- Yes. `memory_recall` supports `categories` (`preference/profile/fact/event/task`).
- The filter is applied at semantic retrieval stage before final ranking.

4. Why does `openclaw memory status` not match this plugin behavior?
- `openclaw memory` CLI reflects OpenClaw built-in memory indexing view, not necessarily your active memory-slot plugin data plane.
- Trust `plugins.slots.memory` + plugin logs for slot-level behavior.

5. Why did conversations become slower after enabling this plugin?
- Each round runs a recall path in `before_agent_start`; if the agent also calls `memory_recall`, that adds another recall pass.
- Current version already has query compaction, 60s recall cache, 10-round dedup, and relevance-first dynamic topK.
- If more speed is needed, tune: `semanticCandidateMultiplier` (recommend 2-3), `recallLimit`, `timelineRecallLimit`.

6. How to enable verbose logs?
- `vk-memory config --advanced`
- Set `debugLogs = y`
- Restart `openclaw gateway`
- Plugin logs are written to: `~/.viking-memory/logs/sessions/<session-id>/<YYYY-MM-DD>.log`
- Non-session logs are written to: `~/.viking-memory/logs/sessions/system/<YYYY-MM-DD>.log`
- Live tail example: `tail -f ~/.viking-memory/logs/sessions/default/$(date +%F).log`
- Performance markers (with `debugLogs` enabled):
  - `retrieve.memory.start/done`
  - `memory_recall.start/done`
  - `auto-recall.start/done`
  - `auto-recall.cache hit/store`
  - `auto-recall.topk`
  - `auto-recall.cross-dedup`
  - `summary.mem0.start/done` and `summary.mem0.http.start/done`
  - `retrieve.timeline.start/done` (only when `memory_recall` is called with timeline source)

## 13. Troubleshooting

1. `vk-memory: command not found`
- Add `~/.local/bin` to PATH and reopen terminal.

2. `vk-memory start` says `MEM0_LLM_API_KEY` is empty
- Run `vk-memory config` and set it.

3. Mem0 extraction not running
- `vk-memory status`
- `cd deploy/local-stack && docker compose logs -f mem0`
- If logs contain `url.not_found` or `/chat/completions`:
  - Your `MEM0_LLM_BASE_URL` / `MEM0_LLM_MODEL` combination is invalid for the provider.
  - Run `vk-memory config`, then run `vk-memory start` again (preflight will verify).

4. Semantic recall is empty
- Check qdrant/infinity containers
- If ports changed, verify `VIKING_MEMORY_*` env overrides
- If you see `embedding endpoint error` right after startup, the model is usually still warming; newer `vk-memory start` waits for warmup before returning.

## 14. Manual Fallback (No Wrapper)

```bash
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js setup
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js start
```
