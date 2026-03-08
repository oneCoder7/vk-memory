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

## 5. 当前注入策略（仅 memory）

当前版本只注入 `memory`（长期记忆），不注入 `timeline`：

1. 短期连续性由 OpenClaw 原生 session 上下文维护
2. 插件只补充长期稳定事实，避免重复注入短期信息
3. `timeline` 只用于对话结束后的提炼窗口与长期记忆生成

## 6. 每轮会话的触发时机（你最关心的“什么时候拉/存”）

### 6.1 对话开始前（`before_agent_start`）

1. 读取当前 query，并做 metadata 压缩（`compactRecallQuery`）
2. 做 L0（`abstract`）语义检索召回 `memory`
3. 命中结果存在歧义时，再用 L1（`overview`）做自适应 rerank；L2 不参与自动注入
4. 注入前做去重与动态裁剪（相关性优先）
5. 命中结果注入 `prependContext`，无命中则不注入

注入形态示例：

```text
<relevant-memories>
1. [preference] 用户偏好 Vim
</relevant-memories>
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

`memory` 和 `timeline` 都是三层（对齐 OpenViking 语义）：

1. L0（检索快照层）

- `.<abstract>.md`

1. L1（压缩概览层）

- `.<overview>.md`

1. L2（详情层）

- `content.md` + `meta.json`
- 默认按需懒加载，不会每次都读全量正文

另外：

- `index/catalog.json` 和 `timeline/index/catalog.json` 是索引元数据（检索入口），不单独定义为 L 层。

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
- 必填：`MEM0_LLM_BASE_URL`、`MEM0_LLM_MODEL`（可通过 `vk-memory config` 交互配置）

## 10. 默认端口

- Mem0: `18888`
- Qdrant: `16333`
- Infinity Embed: `17997`
- Infinity Rerank: `17998`

一般不需要额外环境变量。只有你手动改了端口/地址时，才需要设置：

- `VIKING_MEMORY_MEM0_URL`（插件访问 Mem0）
- `VIKING_MEMORY_QDRANT_URL`（插件访问 Qdrant）
- `VIKING_MEMORY_EMBEDDING_URL`（插件访问 Infinity Embed）
- `VIKING_MEMORY_RERANK_URL`（插件访问 Infinity Rerank）

## 11. 性能优化（已实现）

当前版本已经内置以下优化（无需额外配置）：

1. Query 压缩

- 自动去掉 `Conversation info (untrusted metadata)` 等噪音字段，减少无效检索与误召回。

1. 分层检索（L0 -> L1，L2 按需）

- 向量检索默认仅使用 L0 `abstract`（轻量、稳定）。
- 仅在候选歧义时触发 L1 `overview` rerank。
- L2 `content` 只在手动 recall 明确要求 `includeDetails` 时读取。

1. 语义召回结果缓存（TTL 60s）

- 以 `session + query + index revision` 为键缓存 recall 结果，连续追问显著减少重复检索耗时。

1. 10 轮注入去重

- 同一 URI 在同一 session 最近 10 轮内不会重复注入。

1. 注入去重

- 对 memory 注入块按 `sourceHash + abstract` 去重，避免重复事实多次注入。

1. 动态 TopK（相关性优先）

- 高置信命中时自动收缩注入条数，降低注入 token。

## 12. 常见问题（高频）

1. 为什么我感觉“都是 timeline”？

- 因为 timeline 每轮必写；memory 是窗口触发提炼，不是每轮都有。

1. 为什么现在只注入 memory？

- 短期上下文由 OpenClaw 原生会话历史维护；插件注入只负责补长期事实，降低重复注入成本。

1. 可以按记忆类型过滤吗？

- 可以。`memory_recall` 支持 `categories`（`preference/profile/fact/event/task`）。
- 这会在语义检索阶段先过滤，再做后续排序。

1. `openclaw memory status` 为什么和这个插件表现不一致？

- `openclaw memory` CLI 是 OpenClaw 内置 memory 管理视图，不等同于你当前 memory slot 插件的数据面。
- 以 `plugins.slots.memory` 和插件日志为准。

1. 接入后为什么对话变慢？

- 每轮 `before_agent_start` 都会做一次召回流程；如果 Agent 再主动调用 `memory_recall`，会额外增加一次召回。
- 当前版本已内置：query 压缩、60s recall 缓存、10 轮去重、跨块去重、短期优先动态 TopK。
- 仍需进一步提速时，可调小：`semanticCandidateMultiplier`（建议 2~3）、`recallLimit`。

1. 如何开详细日志排查？

- `vk-memory config --advanced`
- 设置 `debugLogs = y`
- 重启 `openclaw gateway`
- 插件日志文件位于：`~/.viking-memory/logs/sessions/<session-id>/<YYYY-MM-DD>.log`
- 会话无关日志会写到：`~/.viking-memory/logs/sessions/system/<YYYY-MM-DD>.log`
- 实时查看示例：`tail -f ~/.viking-memory/logs/sessions/default/$(date +%F).log`
- 关键性能日志（开启 `debugLogs` 后）：
  - `retrieve.memory.start/done`
  - `memory_recall.start/done`
  - `auto-recall.start/done`
  - `auto-recall.cache hit/store`
  - `auto-recall.topk`
  - `auto-recall.cross-dedup`
  - `summary.mem0.start/done` 与 `summary.mem0.http.start/done`
  - `retrieve.timeline.start/done`（仅当你手动调用 `memory_recall` 且包含 timeline 源时）

## 13. 故障排查

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

## 14. 无全局命令时兜底

```bash
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js setup
node ~/.openclaw/extensions/memory-viking-local/cli/vk-memory.js start
```
