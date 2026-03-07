import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { memoryLocalVikingConfigSchema } from "./config.js";
import {
  EXTRACTOR_FORCE_PENDING_TURNS,
  EXTRACTOR_MIN_PENDING_CHARS,
  EXTRACTOR_MIN_PENDING_ROUNDS,
  PLUGIN_DESCRIPTION,
  PLUGIN_ID,
  PLUGIN_NAME,
} from "./core/constants.js";
import {
  extractLatestUserText,
  formatMemoryLines,
  formatTimelineLines,
  pathExists,
  resolveSessionIdFromEvent,
  sanitizeTextForMemory,
  truncate,
} from "./core/utils.js";
import type { MemoryIndexEntry, MemoryMatch, RecallOptions, TimelineMatch, TimelineRecallOptions } from "./core/types.js";
import { Mem0ExtractorClient } from "./services/mem0-extractor-client.js";
import { SemanticVectorBridge, applyRerankBlend, applySemanticScores } from "./services/semantic-vector-bridge.js";
import { VikingLocalMemoryStore } from "./stores/memory-store.js";
import { VikingLocalTimelineStore } from "./stores/timeline-store.js";

const memoryPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  kind: "memory" as const,
  configSchema: memoryLocalVikingConfigSchema,

  register(api: OpenClawPluginApi): void {
    const cfg = memoryLocalVikingConfigSchema.parse(api.pluginConfig);
    const logInfo = (message: string): void => {
      api.logger.info?.(`memory-viking-local: ${message}`);
    };
    const logDebug = (message: string): void => {
      if (!cfg.debugLogs) {
        return;
      }
      api.logger.info?.(`memory-viking-local[debug]: ${message}`);
    };

    const store = new VikingLocalMemoryStore(cfg);
    const timelineStore = new VikingLocalTimelineStore(cfg);
    const mem0 = new Mem0ExtractorClient(cfg, api.logger);
    const semantic = new SemanticVectorBridge(cfg, api.logger);

    const recallMemory = async (query: string, options: RecallOptions): Promise<MemoryMatch[]> => {
      const candidateLimit = Math.max(options.limit, options.limit * cfg.semanticCandidateMultiplier);
      const semanticHits = await semantic.search(query, {
        source: "memory",
        limit: candidateLimit,
      });
      if (semanticHits.length === 0) {
        return [];
      }

      let candidates = await store.getByUris(
        semanticHits.map((item) => item.uri),
        {
          includeDetails: options.includeDetails,
          detailChars: options.detailChars,
        },
      );
      if (candidates.length === 0) {
        return [];
      }
      candidates = applySemanticScores(candidates, semanticHits);

      if (candidates.length > 1) {
        const rerankDocs = candidates
          .slice(0, candidateLimit)
          .map((item) => ({ id: item.uri, text: `${item.abstract}\n${item.overview}` }));
        const rerankScores = await semantic.rerank(query, rerankDocs);
        candidates = applyRerankBlend(candidates, rerankScores, cfg.semanticBlendWeight);
      }

      return candidates
        .filter((item) => item.score >= options.scoreThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit);
    };

    const recallTimeline = async (query: string, options: TimelineRecallOptions): Promise<TimelineMatch[]> => {
      const candidateLimit = Math.max(options.limit, options.limit * cfg.semanticCandidateMultiplier);
      const semanticHits = await semantic.search(query, {
        source: "timeline",
        limit: candidateLimit,
        excludeSessionId: options.excludeSessionId,
      });
      if (semanticHits.length === 0) {
        return [];
      }

      let candidates = await timelineStore.getByUris(
        semanticHits.map((item) => item.uri),
        {
          includeDetails: options.includeDetails,
          detailChars: options.detailChars,
          excludeSessionId: options.excludeSessionId,
        },
      );
      if (candidates.length === 0) {
        return [];
      }
      candidates = applySemanticScores(candidates, semanticHits);

      if (candidates.length > 1) {
        const rerankDocs = candidates
          .slice(0, candidateLimit)
          .map((item) => ({ id: item.uri, text: `${item.abstract}\n${item.overview}` }));
        const rerankScores = await semantic.rerank(query, rerankDocs);
        candidates = applyRerankBlend(candidates, rerankScores, cfg.semanticBlendWeight);
      }

      return candidates
        .filter((item) => item.score >= options.scoreThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit);
    };

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall (Viking Local)",
        description:
          "Recall extracted memories and/or full timeline chunks from ~/.viking-memory using lazy L0/L1/L2 loading.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results" })),
          scoreThreshold: Type.Optional(Type.Number({ description: "Score threshold (0-1)" })),
          includeDetails: Type.Optional(Type.Boolean({ description: "Load L2 content snippets" })),
          detailChars: Type.Optional(Type.Number({ description: "Max chars for L2 snippets" })),
          source: Type.Optional(
            Type.Union([Type.Literal("hybrid"), Type.Literal("memory"), Type.Literal("timeline")]),
          ),
          timelineLimit: Type.Optional(Type.Number({ description: "Timeline results limit" })),
          timelineScoreThreshold: Type.Optional(Type.Number({ description: "Timeline score threshold (0-1)" })),
        }),
        async execute(_toolCallId, params) {
          const query = String((params as { query: string }).query ?? "").trim();
          if (!query) {
            return {
              content: [{ type: "text", text: "Query cannot be empty." }],
              details: { count: 0 },
            };
          }

          const limit =
            typeof (params as { limit?: number }).limit === "number"
              ? Math.max(1, Math.min(20, Math.floor((params as { limit: number }).limit)))
              : cfg.recallLimit;
          const scoreThreshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : cfg.recallScoreThreshold;
          const timelineLimit =
            typeof (params as { timelineLimit?: number }).timelineLimit === "number"
              ? Math.max(1, Math.min(20, Math.floor((params as { timelineLimit: number }).timelineLimit)))
              : cfg.timelineRecallLimit;
          const timelineScoreThreshold =
            typeof (params as { timelineScoreThreshold?: number }).timelineScoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { timelineScoreThreshold: number }).timelineScoreThreshold))
              : cfg.timelineScoreThreshold;
          const includeDetails =
            typeof (params as { includeDetails?: boolean }).includeDetails === "boolean"
              ? Boolean((params as { includeDetails: boolean }).includeDetails)
              : cfg.detailOnRecallTool;
          const detailChars =
            typeof (params as { detailChars?: number }).detailChars === "number"
              ? Math.max(120, Math.min(20_000, Math.floor((params as { detailChars: number }).detailChars)))
              : cfg.detailChars;
          const sourceRaw =
            typeof (params as { source?: string }).source === "string" ? (params as { source: string }).source : "hybrid";
          const source = sourceRaw === "memory" || sourceRaw === "timeline" ? sourceRaw : "hybrid";

          const memoryMatches =
            source === "timeline"
              ? []
              : await recallMemory(query, {
                  limit,
                  scoreThreshold,
                  includeDetails,
                  detailChars,
                });

          const timelineMatches =
            source === "memory"
              ? []
              : await recallTimeline(query, {
                  limit: timelineLimit,
                  scoreThreshold: timelineScoreThreshold,
                  includeDetails,
                  detailChars,
                });

          if (memoryMatches.length === 0 && timelineMatches.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant local memory/timeline context found." }],
              details: { count: 0, query, source },
            };
          }

          const memoryDetailBlock = includeDetails
            ? memoryMatches
                .filter((item) => item.detail)
                .map((item, idx) => `${idx + 1}. ${item.uri}\n${item.detail}`)
                .join("\n\n")
            : "";
          const timelineDetailBlock = includeDetails
            ? timelineMatches
                .filter((item) => item.detail)
                .map((item, idx) => `${idx + 1}. ${item.uri}\n${item.detail}`)
                .join("\n\n")
            : "";

          const sections: string[] = [];
          if (memoryMatches.length > 0) {
            sections.push(`Extracted Memories (${memoryMatches.length}):\n${formatMemoryLines(memoryMatches)}`);
            if (includeDetails && memoryDetailBlock) {
              sections.push(`Memory L2 snippets:\n${memoryDetailBlock}`);
            }
          }
          if (timelineMatches.length > 0) {
            sections.push(`Timeline Context (${timelineMatches.length}):\n${formatTimelineLines(timelineMatches)}`);
            if (includeDetails && timelineDetailBlock) {
              sections.push(`Timeline L2 snippets:\n${timelineDetailBlock}`);
            }
          }

          return {
            content: [{ type: "text", text: sections.join("\n\n") }],
            details: {
              count: memoryMatches.length + timelineMatches.length,
              query,
              source,
              includeDetails,
              memories: memoryMatches,
              timeline: timelineMatches,
            },
          };
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store (Viking Local)",
        description: "Store text into ~/.viking-memory and generate L0/L1/L2 files.",
        parameters: Type.Object({
          text: Type.String({ description: "Text to store" }),
          role: Type.Optional(Type.String({ description: "Source role, default user" })),
          category: Type.Optional(
            Type.Union([
              Type.Literal("preference"),
              Type.Literal("profile"),
              Type.Literal("fact"),
              Type.Literal("event"),
              Type.Literal("task"),
            ]),
          ),
        }),
        async execute(_toolCallId, params) {
          const text = String((params as { text: string }).text ?? "");
          const role =
            typeof (params as { role?: string }).role === "string" ? (params as { role: string }).role : "user";
          const category =
            typeof (params as { category?: MemoryIndexEntry["category"] }).category === "string"
              ? ((params as { category: MemoryIndexEntry["category"] }).category as MemoryIndexEntry["category"])
              : undefined;

          const stored = await store.store(text, {
            sourceRole: role,
            category,
          });
          if (!stored.duplicate) {
            await semantic
              .upsertMemoryRows([{ entry: stored.entry, content: stored.content }])
              .catch((err) => api.logger.warn(`memory-viking-local: semantic upsert(memory_store) failed: ${String(err)}`));
          }

          const action = stored.duplicate ? "duplicate" : "stored";
          const msg = stored.duplicate
            ? `Duplicate memory detected, reused existing record: ${stored.entry.uri}`
            : `Stored memory at ${stored.entry.uri}`;

          return {
            content: [{ type: "text", text: msg }],
            details: {
              action,
              memory: stored.entry,
            },
          };
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget (Viking Local)",
        description: "Delete local memories by id/uri, or query then delete the best strong match.",
        parameters: Type.Object({
          id: Type.Optional(Type.String({ description: "Memory id" })),
          uri: Type.Optional(Type.String({ description: "Memory uri" })),
          query: Type.Optional(Type.String({ description: "Search query" })),
          scoreThreshold: Type.Optional(Type.Number({ description: "Query delete threshold (0-1)" })),
        }),
        async execute(_toolCallId, params) {
          const id = typeof (params as { id?: string }).id === "string" ? (params as { id: string }).id.trim() : "";
          const uri = typeof (params as { uri?: string }).uri === "string" ? (params as { uri: string }).uri.trim() : "";

          if (id) {
            const ok = await store.forgetById(id);
            if (ok) {
              const deletedUri = `${cfg.targetUri.replace(/\/+$/, "")}/${id}`;
              await semantic
                .deleteUris([deletedUri])
                .catch((err) => api.logger.warn(`memory-viking-local: semantic delete(id) failed: ${String(err)}`));
            }
            return {
              content: [{ type: "text", text: ok ? `Forgotten id: ${id}` : `Memory id not found: ${id}` }],
              details: { action: ok ? "deleted" : "not_found", id },
            };
          }

          if (uri) {
            const ok = await store.forgetByUri(uri);
            if (ok) {
              await semantic
                .deleteUris([uri])
                .catch((err) => api.logger.warn(`memory-viking-local: semantic delete(uri) failed: ${String(err)}`));
            }
            return {
              content: [{ type: "text", text: ok ? `Forgotten uri: ${uri}` : `Memory uri not found: ${uri}` }],
              details: { action: ok ? "deleted" : "not_found", uri },
            };
          }

          const query = typeof (params as { query?: string }).query === "string" ? (params as { query: string }).query.trim() : "";
          if (!query) {
            return {
              content: [{ type: "text", text: "Provide id, uri, or query." }],
              details: { error: "missing_param" },
            };
          }

          const threshold =
            typeof (params as { scoreThreshold?: number }).scoreThreshold === "number"
              ? Math.max(0, Math.min(1, (params as { scoreThreshold: number }).scoreThreshold))
              : 0.85;

          const candidates = await recallMemory(query, {
            limit: 5,
            scoreThreshold: Math.max(0.01, cfg.recallScoreThreshold * 0.6),
            includeDetails: false,
            detailChars: cfg.detailChars,
          });

          if (candidates.length === 0) {
            return {
              content: [{ type: "text", text: "No matching memory candidates found." }],
              details: { action: "none", query },
            };
          }

          const top = candidates[0]!;
          if (top.score >= threshold && candidates.length === 1) {
            const ok = await store.forgetById(top.id);
            if (ok) {
              await semantic
                .deleteUris([top.uri])
                .catch((err) => api.logger.warn(`memory-viking-local: semantic delete(query) failed: ${String(err)}`));
            }
            return {
              content: [
                {
                  type: "text",
                  text: ok ? `Forgotten: ${top.uri} (${Math.round(top.score * 100)}%)` : `Failed to delete: ${top.uri}`,
                },
              ],
              details: { action: ok ? "deleted" : "failed", query, top },
            };
          }

          const list = candidates.map((item) => `- ${item.uri} (${Math.round(item.score * 100)}%)`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: `Found ${candidates.length} candidates. Provide exact id or uri to delete:\n${list}`,
              },
            ],
            details: { action: "candidates", query, candidates },
          };
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_stats",
        label: "Memory Stats (Viking Local)",
        description: "Show local extracted-memory and timeline statistics.",
        parameters: Type.Object({}),
        async execute() {
          const memoryStats = await store.stats();
          const timelineStats = await timelineStore.stats();
          const stats = {
            memory: memoryStats,
            timeline: timelineStats,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
            details: stats,
          };
        },
      },
      { name: "memory_stats" },
    );

    api.on("before_agent_start", async (event) => {
      const query = extractLatestUserText(event.messages) || sanitizeTextForMemory(event.prompt ?? "");
      if (!query || query.length < 3) {
        return;
      }

      const sessionId = resolveSessionIdFromEvent(event);
      try {
        const memories = await recallMemory(query, {
          limit: cfg.recallLimit,
          scoreThreshold: cfg.recallScoreThreshold,
          includeDetails: false,
          detailChars: cfg.detailChars,
        });

        const timeline = await recallTimeline(query, {
          limit: cfg.timelineRecallLimit,
          scoreThreshold: cfg.timelineScoreThreshold,
          includeDetails: false,
          detailChars: cfg.detailChars,
          excludeSessionId: sessionId,
        });

        if (memories.length === 0 && timeline.length === 0) {
          return;
        }

        const parts: string[] = [];

        if (memories.length > 0) {
          const lines = memories.map((item, idx) => {
            const base = `${idx + 1}. [${item.category}] ${item.abstract}`;
            if (!cfg.includeOverviewInInject) {
              return base;
            }
            const overview = truncate(item.overview.replace(/\s+/g, " "), 220);
            return `${base}\n   overview: ${overview}`;
          });
          parts.push(
            "<relevant-memories>\n" +
              "The following extracted memories from ~/.viking-memory may be relevant:\n" +
              `${lines.join("\n")}\n` +
              "</relevant-memories>",
          );
        }

        if (timeline.length > 0) {
          const lines = timeline.map((item, idx) => {
            const base = `${idx + 1}. [${item.role}] ${item.abstract}`;
            if (!cfg.includeTimelineOverviewInInject) {
              return base;
            }
            const overview = truncate(item.overview.replace(/\s+/g, " "), 220);
            return `${base}\n   session: ${item.sessionId}\n   overview: ${overview}`;
          });
          parts.push(
            "<relevant-timeline>\n" +
              "The following historical conversation chunks may be relevant:\n" +
              `${lines.join("\n")}\n` +
              "</relevant-timeline>",
          );
        }

        logDebug(
          `auto-recall injected memory=${memories.length}, timeline=${timeline.length}, query="${truncate(query, 120)}"`,
        );

        return {
          prependContext: parts.join("\n\n"),
        };
      } catch (err) {
        api.logger.warn(`memory-viking-local: auto-recall failed: ${String(err)}`);
        return;
      }
    });

    api.on("agent_end", async (event) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      const sessionId = resolveSessionIdFromEvent(event);

      let captureStats;
      try {
        captureStats = await timelineStore.captureEvent(sessionId, event.messages);
        logDebug(
          `timeline-capture session=${captureStats.sessionId} observed=${captureStats.observed} ingested=${captureStats.ingested} duplicates=${captureStats.duplicates}`,
        );
      } catch (err) {
        api.logger.warn(`memory-viking-local: timeline-capture failed: ${String(err)}`);
        return;
      }

      if (captureStats.ingested <= 0) {
        return;
      }

      if (captureStats.newChunks.length > 0) {
        await semantic
          .upsertTimelineRows(captureStats.newChunks)
          .catch((err) => api.logger.warn(`memory-viking-local: semantic upsert(timeline) failed: ${String(err)}`));
      }

      let batchDecision;
      try {
        batchDecision = await timelineStore.prepareExtractorBatch(sessionId, captureStats.newTurns);
      } catch (err) {
        api.logger.warn(`memory-viking-local: mem0-batch failed: ${String(err)}`);
        return;
      }

      if (!batchDecision.shouldExtract) {
        logDebug(
          `mem0 extraction deferred reason=${batchDecision.reason} pendingTurns=${batchDecision.pendingTurns} pendingChars=${batchDecision.pendingChars} pendingRounds=${batchDecision.pendingRounds}`,
        );
        return;
      }

      try {
        const extracted = await mem0.extract(batchDecision.batch, sessionId);
        if (extracted.length === 0) {
          logDebug(
            `mem0 produced 0 memories (session=${sessionId}, reason=${batchDecision.reason}, batchTurns=${batchDecision.batch.length}, pendingChars=${batchDecision.pendingChars})`,
          );
          return;
        }

        let storedCount = 0;
        let duplicateCount = 0;
        const newlyStoredRows: Array<{ entry: MemoryIndexEntry; content: string }> = [];
        for (const item of extracted) {
          const result = await store.store(item.content, {
            sourceRole: "mem0",
            category: item.category,
            abstract: item.abstract,
            overview: item.overview,
            importance: item.importance,
            metadata: {
              source: "mem0",
              sessionId,
            },
          });
          if (result.duplicate) {
            duplicateCount += 1;
          } else {
            storedCount += 1;
            newlyStoredRows.push({ entry: result.entry, content: result.content });
          }
        }

        if (newlyStoredRows.length > 0) {
          await semantic
            .upsertMemoryRows(newlyStoredRows)
            .catch((err) => api.logger.warn(`memory-viking-local: semantic upsert(mem0) failed: ${String(err)}`));
        }

        logInfo(
          `mem0 stored=${storedCount}, duplicate=${duplicateCount}, candidates=${extracted.length}, reason=${batchDecision.reason}, batchTurns=${batchDecision.batch.length}`,
        );
      } catch (err) {
        await timelineStore
          .requeueExtractorBatch(sessionId, batchDecision.batch)
          .catch((queueErr) => api.logger.warn(`memory-viking-local: mem0 batch requeue failed: ${String(queueErr)}`));
        api.logger.warn(`memory-viking-local: mem0-store failed: ${String(err)}`);
      }
    });

    api.registerService({
      id: PLUGIN_ID,
      start: async () => {
        await Promise.all([store.init(), timelineStore.init()]);
        void semantic.startBackfill(store, timelineStore);
        if (!(await pathExists(cfg.envConfigPath))) {
          api.logger.warn(
            `memory-viking-local: first-run env config not found at ${cfg.envConfigPath}. ` +
              "Run interactive setup once: vk-memory setup",
          );
        }
        logInfo(
          `initialized at ${cfg.rootDir} (roundCapture=always, recall=always, mem0=${cfg.mem0BaseUrl}, extractionWindow=chars>=${EXTRACTOR_MIN_PENDING_CHARS}/rounds>=${EXTRACTOR_MIN_PENDING_ROUNDS}|forceTurns>=${EXTRACTOR_FORCE_PENDING_TURNS}, debugLogs=${cfg.debugLogs ? "on" : "off"})`,
        );
      },
      stop: async () => {
        logInfo("stopped");
      },
    });
  },
};

export default memoryPlugin;
