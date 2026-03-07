import { createHash } from "node:crypto";
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
  RERANK_AMBIGUITY_MARGIN,
  RERANK_BREAKER_COOLDOWN_MS,
  RERANK_BREAKER_FAIL_THRESHOLD,
  RERANK_MAX_DOCS,
  RERANK_MEMORY_MIN_TOTAL,
  RERANK_NEAR_TOP_COUNT,
  RERANK_NEAR_TOP_MARGIN,
  RERANK_SLOW_MS,
  RERANK_TIMEOUT_MS,
} from "./core/constants.js";
import {
  compactRecallQuery,
  extractLatestUserText,
  formatMemoryLines,
  formatTimelineLines,
  pathExists,
  resolveSessionIdFromEvent,
  sanitizeTextForMemory,
  truncate,
} from "./core/utils.js";
import type {
  MemoryCategory,
  MemoryIndexEntry,
  MemoryMatch,
  RecallOptions,
  TimelineMatch,
  TimelineRecallOptions,
} from "./core/types.js";
import { Mem0ExtractorClient } from "./services/mem0-extractor-client.js";
import { SemanticVectorBridge, applyRerankBlend, applySemanticScores } from "./services/semantic-vector-bridge.js";
import { VikingLocalMemoryStore } from "./stores/memory-store.js";
import { VikingLocalTimelineStore } from "./stores/timeline-store.js";
import { VikingSessionFileLogger } from "./core/session-file-logger.js";

const memoryPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  kind: "memory" as const,
  configSchema: memoryLocalVikingConfigSchema,

  register(api: OpenClawPluginApi): void {
    const cfg = memoryLocalVikingConfigSchema.parse(api.pluginConfig);
    const sessionFileLogger = new VikingSessionFileLogger(cfg.rootDir);

    const emitRaw = (level: "info" | "warn" | "error" | "debug", message: string, sessionId = "system"): void => {
      if (level === "warn" || level === "error") {
        api.logger.warn?.(message);
      } else {
        api.logger.info?.(message);
      }
      sessionFileLogger.log(level, message, sessionId);
    };

    const logInfo = (message: string, sessionId = "system"): void => {
      emitRaw("info", `memory-viking-local: ${message}`, sessionId);
    };
    const logWarn = (message: string, sessionId = "system"): void => {
      emitRaw("warn", `memory-viking-local: ${message}`, sessionId);
    };
    const logDebug = (message: string, sessionId = "system"): void => {
      if (!cfg.debugLogs) {
        return;
      }
      emitRaw("debug", `memory-viking-local[debug]: ${message}`, sessionId);
    };

    const serviceLogger = {
      info: (message: string): void => emitRaw("info", message, "system"),
      warn: (message: string): void => emitRaw("warn", message, "system"),
      error: (message: string): void => emitRaw("error", message, "system"),
    } as OpenClawPluginApi["logger"];

    const store = new VikingLocalMemoryStore(cfg);
    const timelineStore = new VikingLocalTimelineStore(cfg);
    const mem0 = new Mem0ExtractorClient(cfg, serviceLogger);
    const semantic = new SemanticVectorBridge(cfg, serviceLogger);
    type RerankMode = "never" | "adaptive" | "always";
    const normalizeRerankMode = (raw: unknown): RerankMode => {
      if (raw === "never" || raw === "always") {
        return raw;
      }
      return "adaptive";
    };
    const computeAdaptiveRerankLimit = (limit: number, candidateCount: number): number =>
      Math.max(2, Math.min(RERANK_MAX_DOCS, candidateCount, Math.max(2, limit)));
    const INJECTION_DEDUP_WINDOW_ROUNDS = 10;
    const AUTO_RECALL_CACHE_TTL_MS = 60_000;
    const AUTO_RECALL_MEMORY_ENOUGH = Math.max(1, Math.ceil(cfg.recallLimit * 0.75));
    const AUTO_RECALL_TIMELINE_FLOOR = Math.max(1, Math.min(cfg.timelineRecallLimit, 2));
    const AUTO_RECALL_RECENT_ROUNDS = 2;
    const AUTO_RECALL_RECENT_TURNS = AUTO_RECALL_RECENT_ROUNDS * 2;
    type AutoRecallCacheEntry = {
      expiresAt: number;
      createdAt: number;
      memories: MemoryMatch[];
      timeline: TimelineMatch[];
    };
    type SessionInjectionDedupState = {
      round: number;
      lastInjectedRoundByUri: Map<string, number>;
    };
    const injectionDedupBySession = new Map<string, SessionInjectionDedupState>();
    const autoRecallCache = new Map<string, AutoRecallCacheEntry>();
    const stableHash = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);
    const buildAutoRecallCacheKey = (params: {
      sessionId: string;
      query: string;
      memoryRevision: string;
      timelineRevision: string;
      memoryLimit: number;
      timelineLimit: number;
      recallThreshold: number;
      timelineThreshold: number;
    }): string =>
      [
        params.sessionId,
        stableHash(params.query),
        params.memoryRevision,
        params.timelineRevision,
        params.memoryLimit,
        params.timelineLimit,
        params.recallThreshold.toFixed(4),
        params.timelineThreshold.toFixed(4),
      ].join("|");
    const pruneAutoRecallCache = (): void => {
      const now = Date.now();
      for (const [key, entry] of autoRecallCache.entries()) {
        if (entry.expiresAt <= now) {
          autoRecallCache.delete(key);
        }
      }
    };
    const nextInjectionDedupState = (sessionId: string): SessionInjectionDedupState => {
      const state = injectionDedupBySession.get(sessionId) ?? {
        round: 0,
        lastInjectedRoundByUri: new Map<string, number>(),
      };
      state.round += 1;
      for (const [uri, lastRound] of state.lastInjectedRoundByUri.entries()) {
        if (state.round - lastRound > INJECTION_DEDUP_WINDOW_ROUNDS) {
          state.lastInjectedRoundByUri.delete(uri);
        }
      }
      injectionDedupBySession.set(sessionId, state);
      return state;
    };
    const filterRecentlyInjected = <T extends { uri: string }>(
      items: T[],
      state: SessionInjectionDedupState,
    ): { fresh: T[]; skipped: number } => {
      const fresh: T[] = [];
      let skipped = 0;
      for (const item of items) {
        const uri = String(item.uri ?? "");
        if (!uri) {
          continue;
        }
        const lastRound = state.lastInjectedRoundByUri.get(uri);
        if (typeof lastRound === "number" && state.round - lastRound <= INJECTION_DEDUP_WINDOW_ROUNDS) {
          skipped += 1;
          continue;
        }
        fresh.push(item);
      }
      return { fresh, skipped };
    };
    const markInjectedUris = (state: SessionInjectionDedupState, uris: string[]): void => {
      for (const uri of new Set(uris.map((item) => String(item ?? "").trim()).filter(Boolean))) {
        state.lastInjectedRoundByUri.set(uri, state.round);
      }
    };
    const classifyConfidence = <T extends { score: number }>(items: T[]): "high" | "medium" | "low" => {
      if (items.length === 0) {
        return "low";
      }
      const top1 = items[0]?.score ?? 0;
      const top2 = items[1]?.score ?? 0;
      const gap = items.length > 1 ? top1 - top2 : top1;
      if (top1 >= 0.72 && gap >= 0.12) {
        return "high";
      }
      if (top1 >= 0.58 && gap >= 0.06) {
        return "medium";
      }
      return "low";
    };
    const computeDynamicInjectCaps = (
      memoryMatches: MemoryMatch[],
      timelineMatches: TimelineMatch[],
      memoryLimit: number,
      timelineLimit: number,
    ): {
      memoryCap: number;
      timelineCap: number;
      memoryConfidence: "high" | "medium" | "low";
      timelineConfidence: "high" | "medium" | "low";
    } => {
      const memoryConfidence = classifyConfidence(memoryMatches);
      const timelineConfidence = classifyConfidence(timelineMatches);
      let memoryCap = Math.max(0, memoryLimit);
      let timelineCap = Math.max(0, timelineLimit);
      if (memoryConfidence === "high") {
        memoryCap = Math.min(memoryCap, 1);
      } else if (memoryConfidence === "medium") {
        memoryCap = Math.min(memoryCap, 2);
      } else {
        memoryCap = Math.min(memoryCap, 3);
      }
      if (timelineConfidence === "high") {
        timelineCap = Math.min(timelineCap, 2);
      } else if (timelineConfidence === "medium") {
        timelineCap = Math.min(timelineCap, 2);
      } else {
        timelineCap = Math.min(timelineCap, Math.max(2, timelineLimit));
      }
      if (timelineMatches.length > 0) {
        timelineCap = Math.max(1, Math.min(timelineCap, timelineMatches.length));
      }
      if (memoryMatches.length > 0) {
        memoryCap = Math.max(1, Math.min(memoryCap, memoryMatches.length));
      }
      return {
        memoryCap,
        timelineCap,
        memoryConfidence,
        timelineConfidence,
      };
    };
    const normalizeInjectAbstract = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
    const dedupCrossBlocks = <T extends { sourceHash: string; abstract: string }>(
      items: T[],
      seen: Set<string>,
    ): { kept: T[]; skipped: number } => {
      const kept: T[] = [];
      let skipped = 0;
      for (const item of items) {
        const key = `${item.sourceHash || "nohash"}|${normalizeInjectAbstract(item.abstract)}`;
        if (seen.has(key)) {
          skipped += 1;
          continue;
        }
        seen.add(key);
        kept.push(item);
      }
      return { kept, skipped };
    };
    const parseCategoryFilters = (raw: unknown): MemoryCategory[] | undefined => {
      if (typeof raw === "string" && raw.trim()) {
        const normalized = raw.trim().toLowerCase();
        if (
          normalized === "preference" ||
          normalized === "profile" ||
          normalized === "fact" ||
          normalized === "event" ||
          normalized === "task"
        ) {
          return [normalized];
        }
      }
      if (!Array.isArray(raw)) {
        return undefined;
      }
      const categories = [...new Set(raw.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean))]
        .filter(
          (item): item is MemoryCategory =>
            item === "preference" || item === "profile" || item === "fact" || item === "event" || item === "task",
        )
        .slice(0, 5);
      return categories.length > 0 ? categories : undefined;
    };

    const rerankBreaker = {
      failures: 0,
      openUntil: 0,
    };
    const getRerankBreakerState = (): { open: boolean; remainingMs: number } => {
      const now = Date.now();
      if (rerankBreaker.openUntil <= now) {
        rerankBreaker.openUntil = 0;
        return { open: false, remainingMs: 0 };
      }
      return { open: true, remainingMs: rerankBreaker.openUntil - now };
    };
    const recordRerankSuccess = (): void => {
      rerankBreaker.failures = 0;
      if (rerankBreaker.openUntil <= Date.now()) {
        rerankBreaker.openUntil = 0;
      }
    };
    const recordRerankFailure = (sessionId: string, scene: string, reason: string, elapsedMs: number): void => {
      rerankBreaker.failures += 1;
      if (rerankBreaker.failures < RERANK_BREAKER_FAIL_THRESHOLD) {
        return;
      }
      rerankBreaker.failures = 0;
      rerankBreaker.openUntil = Date.now() + RERANK_BREAKER_COOLDOWN_MS;
      logWarn(
        `rerank.breaker.open scene=${scene} reason=${reason} elapsedMs=${elapsedMs} cooldownMs=${RERANK_BREAKER_COOLDOWN_MS}`,
        sessionId,
      );
    };

    const recallMemory = async (
      query: string,
      options: RecallOptions,
      context?: {
        sessionId?: string;
        scene?: string;
        rerankMode?: RerankMode;
        memoryCategories?: MemoryCategory[];
      },
    ): Promise<MemoryMatch[]> => {
      const sessionId = context?.sessionId ?? "system";
      const scene = context?.scene ?? "unknown";
      const rerankMode = normalizeRerankMode(context?.rerankMode);
      const memoryCategories = context?.memoryCategories;
      const startedAt = Date.now();
      try {
        const memoryTotal = await store.totalCount();
        const rawCandidateLimit = Math.max(options.limit, options.limit * cfg.semanticCandidateMultiplier);
        const candidateLimit =
          memoryTotal > 0 ? Math.max(options.limit, Math.min(rawCandidateLimit, memoryTotal)) : rawCandidateLimit;
        const semanticQuery = truncate(query, 800);
        logDebug(
          `retrieve.memory.start scene=${scene} limit=${options.limit} threshold=${options.scoreThreshold} candidateLimit=${candidateLimit} memoryTotal=${memoryTotal} rerankMode=${rerankMode} categories=${memoryCategories?.join("|") ?? ""} queryChars=${semanticQuery.length}`,
          sessionId,
        );

        const semanticStartedAt = Date.now();
        const semanticHits = await semantic.search(semanticQuery, {
          source: "memory",
          limit: candidateLimit,
          memoryCategories,
        });
        const semanticMs = Date.now() - semanticStartedAt;
        if (semanticHits.length === 0) {
          logDebug(
            `retrieve.memory.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=0 rerankMs=0 semanticHits=0 loaded=0 eligible=0 rerankDocs=0 rerankDecision=skip rerankReason=no_semantic_hits result=0`,
            sessionId,
          );
          return [];
        }

        const loadStartedAt = Date.now();
        let candidates = await store.getByUris(
          semanticHits.map((item) => item.uri),
          {
            includeDetails: options.includeDetails,
            detailChars: options.detailChars,
          },
        );
        const loadMs = Date.now() - loadStartedAt;
        if (candidates.length === 0) {
          logDebug(
            `retrieve.memory.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=${loadMs} rerankMs=0 semanticHits=${semanticHits.length} loaded=0 eligible=0 rerankDocs=0 rerankDecision=skip rerankReason=no_loaded_candidates result=0`,
            sessionId,
          );
          return [];
        }
        candidates = applySemanticScores(candidates, semanticHits);

        const semanticSorted = [...candidates].sort((a, b) => b.score - a.score);
        const eligibleCount = semanticSorted.filter((item) => item.score >= options.scoreThreshold).length;
        const top1 = semanticSorted[0]?.score ?? 0;
        const top2 = semanticSorted[1]?.score ?? 0;
        const topGap = top1 - top2;
        const nearTopCount = semanticSorted.filter((item) => top1 - item.score <= RERANK_NEAR_TOP_MARGIN).length;
        const breakerBefore = getRerankBreakerState();

        let rerankMs = 0;
        let rerankDocs = 0;
        let rerankDecision = "skip";
        let rerankReason = "not_needed";
        if (rerankMode === "never") {
          rerankReason = "disabled_by_mode";
        } else if (semanticSorted.length <= 1) {
          rerankReason = "insufficient_candidates";
        } else if (breakerBefore.open) {
          rerankReason = `breaker_open_${Math.ceil(breakerBefore.remainingMs / 1000)}s`;
        } else if (rerankMode !== "always" && memoryTotal < RERANK_MEMORY_MIN_TOTAL) {
          rerankReason = "corpus_below_min";
        } else if (rerankMode !== "always" && eligibleCount <= options.limit) {
          rerankReason = "threshold_already_sufficient";
        } else if (
          rerankMode !== "always" &&
          topGap >= RERANK_AMBIGUITY_MARGIN &&
          nearTopCount < RERANK_NEAR_TOP_COUNT
        ) {
          rerankReason = "not_ambiguous";
        } else {
          rerankDecision = "run";
          const rerankLimit = computeAdaptiveRerankLimit(options.limit, semanticSorted.length);
          rerankDocs = Math.min(semanticSorted.length, rerankLimit);
          const rerankInput = semanticSorted
            .slice(0, rerankLimit)
            .map((item) => ({ id: item.uri, text: `${item.abstract}\n${item.overview}` }));
          const rerankStartedAt = Date.now();
          const rerankScores = await semantic.rerank(semanticQuery, rerankInput, RERANK_TIMEOUT_MS);
          rerankMs = Date.now() - rerankStartedAt;
          candidates = applyRerankBlend(candidates, rerankScores, cfg.semanticBlendWeight);
          if (rerankMs >= RERANK_SLOW_MS || rerankScores.size === 0) {
            rerankReason = rerankScores.size === 0 ? "empty_or_timeout" : "slow";
            recordRerankFailure(sessionId, scene, rerankReason, rerankMs);
          } else {
            rerankReason = "ok";
            recordRerankSuccess();
          }
        }
        if (rerankDecision === "skip" && !breakerBefore.open) {
          recordRerankSuccess();
        }

        const result = candidates
          .filter((item) => item.score >= options.scoreThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, options.limit);
        const breakerAfter = getRerankBreakerState();
        logDebug(
          `retrieve.memory.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=${loadMs} rerankMs=${rerankMs} semanticHits=${semanticHits.length} loaded=${candidates.length} eligible=${eligibleCount} rerankDocs=${rerankDocs} rerankDecision=${rerankDecision} rerankReason=${rerankReason} breakerOpen=${breakerAfter.open ? "yes" : "no"} result=${result.length}`,
          sessionId,
        );
        return result;
      } catch (err) {
        logWarn(
          `retrieve.memory.done scene=${scene} elapsedMs=${Date.now() - startedAt} status=error error=${String(err)}`,
          sessionId,
        );
        throw err;
      }
    };

    const recallTimeline = async (
      query: string,
      options: TimelineRecallOptions,
      context?: {
        sessionId?: string;
        scene?: string;
        rerankMode?: RerankMode;
      },
    ): Promise<TimelineMatch[]> => {
      const sessionId = context?.sessionId ?? "system";
      const scene = context?.scene ?? "unknown";
      const rerankMode = normalizeRerankMode(context?.rerankMode);
      const startedAt = Date.now();
      try {
        const timelineTotal = await timelineStore.totalCount();
        const candidateLimit = Math.max(options.limit, options.limit * cfg.semanticCandidateMultiplier);
        const semanticQuery = truncate(query, 800);
        logDebug(
          `retrieve.timeline.start scene=${scene} limit=${options.limit} threshold=${options.scoreThreshold} candidateLimit=${candidateLimit} timelineTotal=${timelineTotal} rerankMode=${rerankMode} excludeSession=${options.excludeSessionId ?? ""} queryChars=${semanticQuery.length}`,
          sessionId,
        );

        const semanticStartedAt = Date.now();
        const semanticHits = await semantic.search(semanticQuery, {
          source: "timeline",
          limit: candidateLimit,
          excludeSessionId: options.excludeSessionId,
        });
        const semanticMs = Date.now() - semanticStartedAt;
        if (semanticHits.length === 0) {
          logDebug(
            `retrieve.timeline.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=0 rerankMs=0 semanticHits=0 loaded=0 eligible=0 rerankDocs=0 rerankDecision=skip rerankReason=no_semantic_hits result=0`,
            sessionId,
          );
          return [];
        }

        const loadStartedAt = Date.now();
        let candidates = await timelineStore.getByUris(
          semanticHits.map((item) => item.uri),
          {
            includeDetails: options.includeDetails,
            detailChars: options.detailChars,
            excludeSessionId: options.excludeSessionId,
          },
        );
        const loadMs = Date.now() - loadStartedAt;
        if (candidates.length === 0) {
          logDebug(
            `retrieve.timeline.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=${loadMs} rerankMs=0 semanticHits=${semanticHits.length} loaded=0 eligible=0 rerankDocs=0 rerankDecision=skip rerankReason=no_loaded_candidates result=0`,
            sessionId,
          );
          return [];
        }
        candidates = applySemanticScores(candidates, semanticHits);

        const semanticSorted = [...candidates].sort((a, b) => b.score - a.score);
        const eligibleCount = semanticSorted.filter((item) => item.score >= options.scoreThreshold).length;
        const top1 = semanticSorted[0]?.score ?? 0;
        const top2 = semanticSorted[1]?.score ?? 0;
        const topGap = top1 - top2;
        const nearTopCount = semanticSorted.filter((item) => top1 - item.score <= RERANK_NEAR_TOP_MARGIN).length;
        const breakerBefore = getRerankBreakerState();

        let rerankMs = 0;
        let rerankDocs = 0;
        let rerankDecision = "skip";
        let rerankReason = "not_needed";
        if (rerankMode === "never") {
          rerankReason = "disabled_by_mode";
        } else if (semanticSorted.length <= 1) {
          rerankReason = "insufficient_candidates";
        } else if (breakerBefore.open) {
          rerankReason = `breaker_open_${Math.ceil(breakerBefore.remainingMs / 1000)}s`;
        } else if (rerankMode !== "always" && eligibleCount <= options.limit) {
          rerankReason = "threshold_already_sufficient";
        } else if (
          rerankMode !== "always" &&
          topGap >= RERANK_AMBIGUITY_MARGIN &&
          nearTopCount < RERANK_NEAR_TOP_COUNT
        ) {
          rerankReason = "not_ambiguous";
        } else {
          rerankDecision = "run";
          const rerankLimit = computeAdaptiveRerankLimit(options.limit, semanticSorted.length);
          rerankDocs = Math.min(semanticSorted.length, rerankLimit);
          const rerankInput = semanticSorted
            .slice(0, rerankLimit)
            .map((item) => ({ id: item.uri, text: `${item.abstract}\n${item.overview}` }));
          const rerankStartedAt = Date.now();
          const rerankScores = await semantic.rerank(semanticQuery, rerankInput, RERANK_TIMEOUT_MS);
          rerankMs = Date.now() - rerankStartedAt;
          candidates = applyRerankBlend(candidates, rerankScores, cfg.semanticBlendWeight);
          if (rerankMs >= RERANK_SLOW_MS || rerankScores.size === 0) {
            rerankReason = rerankScores.size === 0 ? "empty_or_timeout" : "slow";
            recordRerankFailure(sessionId, scene, rerankReason, rerankMs);
          } else {
            rerankReason = "ok";
            recordRerankSuccess();
          }
        }
        if (rerankDecision === "skip" && !breakerBefore.open) {
          recordRerankSuccess();
        }

        const result = candidates
          .filter((item) => item.score >= options.scoreThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, options.limit);
        const breakerAfter = getRerankBreakerState();
        logDebug(
          `retrieve.timeline.done scene=${scene} elapsedMs=${Date.now() - startedAt} semanticMs=${semanticMs} loadMs=${loadMs} rerankMs=${rerankMs} semanticHits=${semanticHits.length} loaded=${candidates.length} eligible=${eligibleCount} rerankDocs=${rerankDocs} rerankDecision=${rerankDecision} rerankReason=${rerankReason} breakerOpen=${breakerAfter.open ? "yes" : "no"} result=${result.length}`,
          sessionId,
        );
        return result;
      } catch (err) {
        logWarn(
          `retrieve.timeline.done scene=${scene} elapsedMs=${Date.now() - startedAt} status=error error=${String(err)}`,
          sessionId,
        );
        throw err;
      }
    };

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall (Viking Local)",
        description:
          "Manual recall tool. Auto-recall runs before each round; call this only when explicit memory search/details are needed.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results" })),
          scoreThreshold: Type.Optional(Type.Number({ description: "Score threshold (0-1)" })),
          includeDetails: Type.Optional(Type.Boolean({ description: "Load L2 content snippets" })),
          detailChars: Type.Optional(Type.Number({ description: "Max chars for L2 snippets" })),
          source: Type.Optional(
            Type.Union([Type.Literal("hybrid"), Type.Literal("memory"), Type.Literal("timeline")]),
          ),
          categories: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Literal("preference"),
                Type.Literal("profile"),
                Type.Literal("fact"),
                Type.Literal("event"),
                Type.Literal("task"),
              ]),
              { minItems: 1, maxItems: 5 },
            ),
          ),
          rerankMode: Type.Optional(
            Type.Union([Type.Literal("adaptive"), Type.Literal("never"), Type.Literal("always")]),
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
          const categories = parseCategoryFilters((params as { categories?: unknown }).categories);
          const rerankMode = normalizeRerankMode((params as { rerankMode?: unknown }).rerankMode);
          const startedAt = Date.now();
          logDebug(
            `memory_recall.start source=${source} limit=${limit} timelineLimit=${timelineLimit} includeDetails=${includeDetails} rerankMode=${rerankMode} categories=${categories?.join("|") ?? ""} query="${truncate(query, 120)}"`,
            "tool",
          );

          let memoryMatches: MemoryMatch[] = [];
          let timelineMatches: TimelineMatch[] = [];
          if (source === "memory") {
            memoryMatches = await recallMemory(query, {
              limit,
              scoreThreshold,
              includeDetails,
              detailChars,
            }, {
              sessionId: "tool",
              scene: "tool_recall_memory",
              rerankMode,
              memoryCategories: categories,
            });
          } else if (source === "timeline") {
            timelineMatches = await recallTimeline(query, {
              limit: timelineLimit,
              scoreThreshold: timelineScoreThreshold,
              includeDetails,
              detailChars,
            }, {
              sessionId: "tool",
              scene: "tool_recall_timeline",
              rerankMode,
            });
          } else {
            [memoryMatches, timelineMatches] = await Promise.all([
              recallMemory(query, {
                limit,
                scoreThreshold,
                includeDetails,
                detailChars,
              }, {
                sessionId: "tool",
                scene: "tool_recall_hybrid",
                rerankMode,
                memoryCategories: categories,
              }),
              recallTimeline(query, {
                limit: timelineLimit,
                scoreThreshold: timelineScoreThreshold,
                includeDetails,
                detailChars,
              }, {
                sessionId: "tool",
                scene: "tool_recall_hybrid",
                rerankMode,
              }),
            ]);
          }

          if (memoryMatches.length === 0 && timelineMatches.length === 0) {
            logDebug(`memory_recall.done elapsedMs=${Date.now() - startedAt} memory=0 timeline=0 result=0`, "tool");
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

          logDebug(
            `memory_recall.done elapsedMs=${Date.now() - startedAt} memory=${memoryMatches.length} timeline=${timelineMatches.length} result=${memoryMatches.length + timelineMatches.length}`,
            "tool",
          );
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
              .catch((err) => logWarn(`semantic upsert(memory_store) failed: ${String(err)}`, "tool"));
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
                .catch((err) => logWarn(`semantic delete(id) failed: ${String(err)}`, "tool"));
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
                .catch((err) => logWarn(`semantic delete(uri) failed: ${String(err)}`, "tool"));
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
          }, {
            sessionId: "tool",
            scene: "memory_forget_lookup",
            rerankMode: "adaptive",
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
                .catch((err) => logWarn(`semantic delete(query) failed: ${String(err)}`, "tool"));
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
      const rawQuery = extractLatestUserText(event.messages) || sanitizeTextForMemory(event.prompt ?? "");
      const query = compactRecallQuery(rawQuery);
      if (!query || query.length < 3) {
        return;
      }

      const sessionId = resolveSessionIdFromEvent(event);
      const dedupState = nextInjectionDedupState(sessionId);
      try {
        const recallStartedAt = Date.now();
        const [memoryRevision, timelineRevision] = await Promise.all([
          store.getRevision(),
          timelineStore.getRevision(),
        ]);
        pruneAutoRecallCache();
        if (rawQuery !== query) {
          logDebug(
            `auto-recall.query-compact rawChars=${rawQuery.length} compactChars=${query.length}`,
            sessionId,
          );
        }
        logDebug(
          `auto-recall.start query="${truncate(query, 120)}" memoryLimit=${cfg.recallLimit} timelineLimit=${cfg.timelineRecallLimit} timelineFloor=${AUTO_RECALL_TIMELINE_FLOOR} recentRounds=${AUTO_RECALL_RECENT_ROUNDS} rerankMode=never round=${dedupState.round} dedupWindowRounds=${INJECTION_DEDUP_WINDOW_ROUNDS}`,
          sessionId,
        );
        const recentTimeline = (
          await timelineStore.getRecentSessionTimeline(sessionId, {
            limit: AUTO_RECALL_RECENT_TURNS,
            includeDetails: false,
            detailChars: cfg.detailChars,
            roles: ["user", "assistant"],
          })
        ).reverse();
        if (recentTimeline.length > 0) {
          logDebug(
            `auto-recall.recent session=${sessionId} turns=${recentTimeline.length} targetTurns=${AUTO_RECALL_RECENT_TURNS}`,
            sessionId,
          );
        }
        const recallCacheKey = buildAutoRecallCacheKey({
          sessionId,
          query,
          memoryRevision,
          timelineRevision,
          memoryLimit: cfg.recallLimit,
          timelineLimit: cfg.timelineRecallLimit,
          recallThreshold: cfg.recallScoreThreshold,
          timelineThreshold: cfg.timelineScoreThreshold,
        });
        const now = Date.now();
        let memories: MemoryMatch[] = [];
        let timeline: TimelineMatch[] = [];
        let timelineLimitUsed = cfg.timelineRecallLimit;
        const cacheEntry = autoRecallCache.get(recallCacheKey);
        if (cacheEntry && cacheEntry.expiresAt > now) {
          memories = cacheEntry.memories;
          timeline = cacheEntry.timeline;
          timelineLimitUsed =
            memories.length < AUTO_RECALL_MEMORY_ENOUGH ? cfg.timelineRecallLimit : AUTO_RECALL_TIMELINE_FLOOR;
          logDebug(
            `auto-recall.cache hit ageMs=${now - cacheEntry.createdAt} ttlMs=${AUTO_RECALL_CACHE_TTL_MS} memory=${memories.length} timeline=${timeline.length}`,
            sessionId,
          );
        } else {
          if (cacheEntry) {
            autoRecallCache.delete(recallCacheKey);
          }
          memories = await recallMemory(query, {
            limit: cfg.recallLimit,
            scoreThreshold: cfg.recallScoreThreshold,
            includeDetails: false,
            detailChars: cfg.detailChars,
          }, {
            sessionId,
            scene: "auto_recall",
            rerankMode: "never",
          });
          timelineLimitUsed =
            memories.length < AUTO_RECALL_MEMORY_ENOUGH ? cfg.timelineRecallLimit : AUTO_RECALL_TIMELINE_FLOOR;
          timeline = await recallTimeline(query, {
            limit: timelineLimitUsed,
            scoreThreshold: cfg.timelineScoreThreshold,
            includeDetails: false,
            detailChars: cfg.detailChars,
            excludeSessionId: sessionId,
          }, {
            sessionId,
            scene: "auto_recall",
            rerankMode: "never",
          });
          if (timelineLimitUsed < cfg.timelineRecallLimit) {
            logDebug(
              `auto-recall.timeline.limit reason=memory_sufficient memory=${memories.length} threshold=${AUTO_RECALL_MEMORY_ENOUGH} limit=${timelineLimitUsed}/${cfg.timelineRecallLimit}`,
              sessionId,
            );
          }
          autoRecallCache.set(recallCacheKey, {
            createdAt: now,
            expiresAt: now + AUTO_RECALL_CACHE_TTL_MS,
            memories,
            timeline,
          });
          logDebug(
            `auto-recall.cache store ttlMs=${AUTO_RECALL_CACHE_TTL_MS} memory=${memories.length} timeline=${timeline.length}`,
            sessionId,
          );
        }

        if (memories.length === 0 && timeline.length === 0 && recentTimeline.length === 0) {
          logDebug(
            `auto-recall.done elapsedMs=${Date.now() - recallStartedAt} memory=0 timeline=0 recent=0 injected=false`,
            sessionId,
          );
          return;
        }

        const dedupedMemories = filterRecentlyInjected(memories, dedupState);
        const dedupedTimeline = filterRecentlyInjected(timeline, dedupState);
        const filteredMemories = dedupedMemories.fresh;
        const filteredTimeline = dedupedTimeline.fresh;
        const dedupSkipped = dedupedMemories.skipped + dedupedTimeline.skipped;
        if (dedupSkipped > 0) {
          logDebug(
            `auto-recall.dedup round=${dedupState.round} skipped=${dedupSkipped} memorySkipped=${dedupedMemories.skipped} timelineSkipped=${dedupedTimeline.skipped}`,
            sessionId,
          );
        }
        if (filteredMemories.length === 0 && filteredTimeline.length === 0 && recentTimeline.length === 0) {
          logDebug(
            `auto-recall.done elapsedMs=${Date.now() - recallStartedAt} memory=0 timeline=0 recent=0 injected=false reason=dedup_window skipped=${dedupSkipped} round=${dedupState.round}`,
            sessionId,
          );
          return;
        }

        const dynamicCaps = computeDynamicInjectCaps(
          filteredMemories,
          filteredTimeline,
          cfg.recallLimit,
          timelineLimitUsed,
        );
        const cappedMemories = filteredMemories.slice(0, dynamicCaps.memoryCap);
        const cappedTimeline = filteredTimeline.slice(0, dynamicCaps.timelineCap);
        if (cappedMemories.length !== filteredMemories.length || cappedTimeline.length !== filteredTimeline.length) {
          logDebug(
            `auto-recall.topk memory=${cappedMemories.length}/${filteredMemories.length} timeline=${cappedTimeline.length}/${filteredTimeline.length} memoryConfidence=${dynamicCaps.memoryConfidence} timelineConfidence=${dynamicCaps.timelineConfidence}`,
            sessionId,
          );
        }

        const crossSeen = new Set<string>();
        const dedupRecent = dedupCrossBlocks(recentTimeline, crossSeen);
        const dedupTimeline = dedupCrossBlocks(cappedTimeline, crossSeen);
        const dedupMemory = dedupCrossBlocks(cappedMemories, crossSeen);
        const crossDedupSkipped = dedupRecent.skipped + dedupTimeline.skipped + dedupMemory.skipped;
        const finalRecentTimeline = dedupRecent.kept;
        const finalTimeline = dedupTimeline.kept;
        const finalMemories = dedupMemory.kept;
        if (crossDedupSkipped > 0) {
          logDebug(
            `auto-recall.cross-dedup skipped=${crossDedupSkipped} recentSkipped=${dedupRecent.skipped} timelineSkipped=${dedupTimeline.skipped} memorySkipped=${dedupMemory.skipped}`,
            sessionId,
          );
        }
        if (finalMemories.length === 0 && finalTimeline.length === 0 && finalRecentTimeline.length === 0) {
          logDebug(
            `auto-recall.done elapsedMs=${Date.now() - recallStartedAt} memory=0 timeline=0 recent=0 injected=false reason=cross_block_dedup`,
            sessionId,
          );
          return;
        }

        const parts: string[] = [];

        if (finalRecentTimeline.length > 0) {
          const lines = finalRecentTimeline.map((item, idx) => `${idx + 1}. [${item.role}] ${item.abstract}`);
          parts.push(`<recent-timeline>\n${lines.join("\n")}\n</recent-timeline>`);
        }

        if (finalTimeline.length > 0) {
          const lines = finalTimeline.map((item, idx) => `${idx + 1}. [${item.role}] ${item.abstract}`);
          parts.push(`<relevant-timeline>\n${lines.join("\n")}\n</relevant-timeline>`);
        }

        if (finalMemories.length > 0) {
          const lines = finalMemories.map((item, idx) => `${idx + 1}. [${item.category}] ${item.abstract}`);
          parts.push(`<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`);
        }

        markInjectedUris(dedupState, [
          ...finalMemories.map((item) => item.uri),
          ...finalTimeline.map((item) => item.uri),
        ]);

        logDebug(
          `auto-recall.done elapsedMs=${Date.now() - recallStartedAt} memory=${finalMemories.length} timeline=${finalTimeline.length} recent=${finalRecentTimeline.length} injected=true skipped=${dedupSkipped + crossDedupSkipped} round=${dedupState.round} query="${truncate(query, 120)}"`,
          sessionId,
        );

        return {
          prependContext: parts.join("\n\n"),
        };
      } catch (err) {
        logWarn(`auto-recall failed: ${String(err)}`, sessionId);
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
          sessionId,
        );
      } catch (err) {
        logWarn(`timeline-capture failed: ${String(err)}`, sessionId);
        return;
      }

      if (captureStats.ingested <= 0) {
        return;
      }

      if (captureStats.newChunks.length > 0) {
        await semantic
          .upsertTimelineRows(captureStats.newChunks)
          .catch((err) => logWarn(`semantic upsert(timeline) failed: ${String(err)}`, sessionId));
      }

      let batchDecision;
      try {
        batchDecision = await timelineStore.prepareExtractorBatch(sessionId, captureStats.newTurns);
      } catch (err) {
        logWarn(`mem0-batch failed: ${String(err)}`, sessionId);
        return;
      }

      if (!batchDecision.shouldExtract) {
        logDebug(
          `mem0 extraction deferred reason=${batchDecision.reason} pendingTurns=${batchDecision.pendingTurns} pendingChars=${batchDecision.pendingChars} pendingRounds=${batchDecision.pendingRounds}`,
          sessionId,
        );
        return;
      }

      try {
        const summaryStartedAt = Date.now();
        logDebug(
          `summary.mem0.start reason=${batchDecision.reason} batchTurns=${batchDecision.batch.length} pendingTurns=${batchDecision.pendingTurns} pendingChars=${batchDecision.pendingChars}`,
          sessionId,
        );
        const extracted = await mem0.extract(batchDecision.batch, sessionId);
        if (extracted.length === 0) {
          logDebug(
            `summary.mem0.done elapsedMs=${Date.now() - summaryStartedAt} extracted=0 stored=0 duplicate=0 reason=${batchDecision.reason}`,
            sessionId,
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
            .catch((err) => logWarn(`semantic upsert(mem0) failed: ${String(err)}`, sessionId));
        }

        logInfo(
          `mem0 stored=${storedCount}, duplicate=${duplicateCount}, candidates=${extracted.length}, reason=${batchDecision.reason}, batchTurns=${batchDecision.batch.length}`,
          sessionId,
        );
        logDebug(
          `summary.mem0.done elapsedMs=${Date.now() - summaryStartedAt} extracted=${extracted.length} stored=${storedCount} duplicate=${duplicateCount} reason=${batchDecision.reason}`,
          sessionId,
        );
      } catch (err) {
        await timelineStore
          .requeueExtractorBatch(sessionId, batchDecision.batch)
          .catch((queueErr) => logWarn(`mem0 batch requeue failed: ${String(queueErr)}`, sessionId));
        logWarn(`mem0-store failed: ${String(err)}`, sessionId);
      }
    });

    api.registerService({
      id: PLUGIN_ID,
      start: async () => {
        await Promise.all([store.init(), timelineStore.init()]);
        const repaired = await store.repairLayer0();
        if (repaired.fixedEntries > 0 || repaired.fixedFiles > 0) {
          logInfo(
            `memory layer0 repaired entries=${repaired.fixedEntries}, files=${repaired.fixedFiles}`,
          );
        }
        void semantic.startBackfill(store, timelineStore);
        if (!(await pathExists(cfg.envConfigPath))) {
          logWarn(`first-run env config not found at ${cfg.envConfigPath}. Run interactive setup once: vk-memory setup`);
        }
        logInfo(
          `initialized at ${cfg.rootDir} (roundCapture=always, recall=always, mem0=${cfg.mem0BaseUrl}, extractionWindow=chars>=${EXTRACTOR_MIN_PENDING_CHARS}/rounds>=${EXTRACTOR_MIN_PENDING_ROUNDS}|forceTurns>=${EXTRACTOR_FORCE_PENDING_TURNS}, rerank=adaptive(maxDocs=${RERANK_MAX_DOCS},timeoutMs=${RERANK_TIMEOUT_MS},slowMs=${RERANK_SLOW_MS},breaker=${RERANK_BREAKER_FAIL_THRESHOLD}/${RERANK_BREAKER_COOLDOWN_MS}ms), debugLogs=${cfg.debugLogs ? "on" : "off"}, logs=${cfg.rootDir}/logs/sessions/<session>/<YYYY-MM-DD>.log)`,
        );
      },
      stop: async () => {
        logInfo("stopped");
      },
    });
  },
};

export default memoryPlugin;
