# OpenClaw 本地记忆插件（Viking Local + Mem0）

[中文](./README.md) | [English](./README.en.md)


这个插件的目标很直接：

- 让 OpenClaw 的 memory slot 由本插件接管
- 每轮对话结束都做全文落库（timeline）
- 再把可长期复用的信息提炼成 durable memory（memory）
- 对话开始前自动召回相关记忆注入上下文

所有本地数据都在 `~/.viking-memory`。

## 1. 3 分钟跑通（最短路径）

### 1.1 你只需要准备

1. Docker + Docker Compose v2
2. Node.js >= 22
3. OpenClaw CLI（`npm i -g openclaw`）
4. 一个 OpenAI-compatible 的 LLM Key（仅供 Mem0 提炼）

说明：

- 默认本地栈仅 4 个容器：`mem0` + `qdrant` + `infinity-embed` + `infinity-rerank`。
- Qdrant + Infinity（embedding/rerank）全部本地容器，不需要单独 API Key。
- 兼容 OpenAI / OpenRouter / DeepSeek / SiliconFlow / 火山 Ark 等 OpenAI-compatible 供应商。

### 1.2 安装并接管 memory slot

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

安装后会：

1. 复制插件到 `~/.openclaw/extensions/memory-viking-local`
2. 设置 `plugins.slots.memory=memory-viking-local`
3. 创建全局命令 `vk-memory`

### 1.3 首次初始化 + 启动

```bash
vk-memory setup
vk-memory start
openclaw gateway
```

检查是否接管成功：

```bash
openclaw config get plugins.slots.memory
# 期望: memory-viking-local
```

## 2. 全局命令（你只需要记住这 7 个）

```bash
vk-memory help
```


| 命令                  | 作用                                 |
| ------------------- | ---------------------------------- |
| `vk-memory setup`   | 首次初始化（插件配置 JSON + Docker 栈 `.env`） |
| `vk-memory config`  | 修改已有配置（包括 `debugLogs`）             |
| `vk-memory start`   | 启动本地记忆栈并自动做就绪/连通性预检（默认包含 Mem0 LLM 预检） |
| `vk-memory stop`    | 停止本地记忆栈                            |
| `vk-memory status`  | 查看容器状态                             |
| `vk-memory migrate` | 迁移已有 OpenClaw 本地文件记忆               |
| `vk-memory uninstall` | 从 OpenClaw 移除 memory-viking-local 配置、扩展目录和全局 `vk-memory` 命令（保留 `~/.viking-memory`） |


## 3. 旧记忆迁移（仅本地文件模式）

如果你已经在 OpenClaw 本地工作区里有历史记忆，执行一次迁移即可：

```bash
vk-memory migrate
```

默认迁移来源：

- `~/.openclaw/workspace/MEMORY.md`
- `~/.openclaw/workspace/memory/*.md`

重要说明：

- 这里只支持本地文件记忆迁移。

常用参数：

```bash
vk-memory migrate --dry-run
vk-memory migrate --workspace=~/.openclaw/workspace --chunk-chars=1200
vk-memory migrate --root=~/.viking-memory
```

约束：

- `--root` 必须位于 `~/.viking-memory` 内（插件数据边界）。

迁移后会发生什么：

1. 数据写入 `~/.viking-memory/memories/*` 和 `index/catalog.json`
2. 插件启动时会自动做语义回填，把迁移数据写入本地 Qdrant

卸载插件配置 + 扩展目录 + 全局命令（不删记忆文件）：

```bash
vk-memory uninstall
```

## 4. memory 和 timeline 到底有什么区别

这是最重要的概念：

1. `timeline` = 每轮原始对话事件流（高覆盖、细粒度、短中期）

- 每轮 `agent_end` 都会写入
- 适合保留“刚发生”的上下文细节

1. `memory` = 从 timeline 中提炼出的长期事实（高价值、低噪声）

- 不是每轮都写入，而是达到提炼窗口后写入
- 适合保留稳定偏好、长期约束、持续决策

一句话：

- `timeline` 负责“别丢细节”
- `memory` 负责“别被噪声淹没”

## 5. 为什么要同时召回 memory + timeline

不是“每次都强行塞两份”，而是“两个索引都查，命中谁就注入谁”：

1. 只用 `memory`：会丢掉刚发生、还没提炼的细节
2. 只用 `timeline`：长期稳定事实不够干净，噪声偏多
3. 双路召回：长期事实 + 近期细节可以同时成立

另外，timeline 召回默认会排除当前 session，避免把本轮内容原样回灌。

## 6. 每轮会话的触发时机（你最关心的“什么时候拉/存”）

### 6.1 对话开始前（`before_agent_start`）

1. 读取当前 query
2. 语义检索 `memory` 和 `timeline`
3. 命中结果才注入 `prependContext`
4. 无命中就不注入

注入形态示例：

```text
<relevant-memories>
1. [preference] 用户偏好 Vim
   overview: Category: preference ...
</relevant-memories>

<relevant-timeline>
1. [user] 昨天把发布窗口改到周三
   session: default
   overview: Session: default Role: user ...
</relevant-timeline>
```

### 6.2 对话结束后（`agent_end`）

1. 先把本轮增量消息写到 timeline（必做）
2. 判断是否达到提炼窗口（轮数/字符/turn cap）
3. 达到则调用 Mem0 提炼
4. 提炼结果写入 memory

默认提炼窗口：

- `pendingRounds >= 2 && pendingChars >= 200`
- 或 `pendingTurns >= 12` 强制触发

## 7. L0 / L1 / L2 在本项目里是什么

`memory` 和 `timeline` 都是三层：

1. L0（索引层）

- memory: `~/.viking-memory/index/catalog.json`
- timeline: `~/.viking-memory/timeline/index/catalog.json`

1. L1（摘要层）

- `.<abstract>.md` + `.<overview>.md`

1. L2（详情层）

- `content.md` + `meta.json`
- 默认按需懒加载，不会每次都读全量正文

## 8. 存储结构一览

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

## 9. 配置文件（只看两个）

1. 插件配置：`~/.viking-memory/plugin.env.json`

- 由 `vk-memory setup/config` 写入
- 常用：`debugLogs`（默认 `false`）

1. Docker 栈配置：`deploy/local-stack/.env`

- 模板：`[deploy/local-stack/.env.example](./deploy/local-stack/.env.example)`
- 必填：`MEM0_LLM_API_KEY`
- 默认：`MEM0_LLM_TEMPERATURE=0.1`、`MEM0_LLM_MAX_TOKENS=300`（可在 `vk-memory config --advanced` 调整）

## 10. 默认端口

- Mem0: `18888`
- Qdrant: `16333`
- Infinity Embed: `17997`
- Infinity Rerank: `17998`

如改端口，可能还需设置：

- `VIKING_MEMORY_MEM0_URL`
- `VIKING_MEMORY_QDRANT_URL`
- `VIKING_MEMORY_EMBEDDING_URL`
- `VIKING_MEMORY_RERANK_URL`

## 11. 常见问题（高频）

1. 为什么我感觉“都是 timeline”？

- 因为 timeline 每轮必写；memory 是窗口触发提炼，不是每轮都有。

1. 为什么要两路召回？

- timeline 保近期细节，memory 保长期事实，只用一条路都会丢信息。

1. `openclaw memory status` 为什么和这个插件表现不一致？

- `openclaw memory` CLI 是 OpenClaw 内置 memory 管理视图，不等同于你当前 memory slot 插件的数据面。
- 以 `plugins.slots.memory` 和插件日志为准。

1. 接入后为什么对话变慢？

- 每轮 `before_agent_start` 都会做一次混合召回（embedding + qdrant + rerank，memory/timeline 两路）。
- 如果 Agent 再主动调用 `memory_recall`，会多一轮召回（新版本已做并行与 rerank 候选上限优化）。
- 可优先调小：`semanticCandidateMultiplier`（建议 2~3）、`recallLimit`、`timelineRecallLimit`。

1. 如何开详细日志排查？

- `vk-memory config --advanced`
- 设置 `debugLogs = y`
- 重启 `openclaw gateway`
- 插件日志文件位于：`~/.viking-memory/logs/sessions/<session-id>/<YYYY-MM-DD>.log`
- 会话无关日志会写到：`~/.viking-memory/logs/sessions/system/<YYYY-MM-DD>.log`
- 实时查看示例：`tail -f ~/.viking-memory/logs/sessions/default/$(date +%F).log`
- 关键性能日志（开启 `debugLogs` 后）：
  - `retrieve.memory.start/done`
  - `retrieve.timeline.start/done`
  - `memory_recall.start/done`
  - `auto-recall.start/done`
  - `summary.mem0.start/done` 与 `summary.mem0.http.start/done`

## 12. 故障排查

1. `vk-memory: command not found`

- 把 `~/.local/bin` 加到 PATH，再开新终端。

1. `vk-memory start` 报 `MEM0_LLM_API_KEY` 为空

- 运行 `vk-memory config` 补齐。

1. Mem0 提炼没生效

- `vk-memory status`
- `cd deploy/local-stack && docker compose logs -f mem0`
- 若日志含 `url.not_found` 或 `/chat/completions`：
  - 说明当前 `MEM0_LLM_BASE_URL` / `MEM0_LLM_MODEL` 对不上
  - 先执行 `vk-memory config` 修正，再执行 `vk-memory start`（会自动预检）

1. 语义召回为空

- 确认 qdrant / infinity 容器都在运行
- 若改端口，确认 `VIKING_MEMORY_*` 同步
- 冷启动阶段若看到 `embedding endpoint error`，通常是模型正在加载；新版 `vk-memory start` 会先等待预热完成再返回

## 13. 无全局命令时兜底

```bash
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js setup
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js start
```
