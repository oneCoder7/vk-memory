import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";

export type MemoryLocalVikingConfig = {
  envConfigPath?: string;
  rootDir?: string;
  debugLogs?: boolean;
  targetUri?: string;
  recallLimit?: number;
  recallScoreThreshold?: number;
  includeOverviewInInject?: boolean;
  detailOnRecallTool?: boolean;
  detailChars?: number;
  detailCacheSize?: number;
  timelineRecallLimit?: number;
  timelineScoreThreshold?: number;
  includeTimelineOverviewInInject?: boolean;
  mem0BaseUrl?: string;
  mem0UserId?: string;
  mem0AgentId?: string;
  mem0TimeoutMs?: number;
  semanticCandidateMultiplier?: number;
  semanticBlendWeight?: number;
  semanticTimeoutMs?: number;
  semanticEmbeddingModel?: string;
  semanticRerankModel?: string;
  semanticBackfillLimit?: number;
};

const DEFAULT_ROOT_DIR = "~/.viking-memory";
const DEFAULT_ENV_CONFIG_PATH = "~/.viking-memory/plugin.env.json";
const DEFAULT_DEBUG_LOGS = false;
const DEFAULT_TARGET_URI = "viking://user/memories";
const DEFAULT_RECALL_LIMIT = 6;
const DEFAULT_RECALL_SCORE_THRESHOLD = 0.12;
const DEFAULT_DETAIL_CHARS = 1_200;
const DEFAULT_DETAIL_CACHE_SIZE = 64;
const DEFAULT_TIMELINE_RECALL_LIMIT = 4;
const DEFAULT_TIMELINE_SCORE_THRESHOLD = 0.08;
const DEFAULT_MEM0_BASE_URL = "http://127.0.0.1:18888";
const DEFAULT_MEM0_USER_ID = "openclaw-user";
const DEFAULT_MEM0_AGENT_ID = "openclaw-agent";
const DEFAULT_MEM0_TIMEOUT_MS = 30_000;
const DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER = 6;
const DEFAULT_SEMANTIC_BLEND_WEIGHT = 0.6;
const DEFAULT_SEMANTIC_TIMEOUT_MS = 8_000;
const DEFAULT_SEMANTIC_EMBEDDING_MODEL = "BAAI/bge-m3";
const DEFAULT_SEMANTIC_RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
const DEFAULT_SEMANTIC_BACKFILL_LIMIT = 400;

const VIKING_ROOT_BASE = resolvePath(join(homedir(), ".viking-memory"));

const ENV_CONFIG_ALLOWED_KEYS = [
  "envConfigPath",
  "rootDir",
  "debugLogs",
  "recallLimit",
  "recallScoreThreshold",
  "includeOverviewInInject",
  "detailOnRecallTool",
  "detailChars",
  "detailCacheSize",
  "timelineRecallLimit",
  "timelineScoreThreshold",
  "includeTimelineOverviewInInject",
  "mem0TimeoutMs",
  "semanticCandidateMultiplier",
  "semanticBlendWeight",
  "semanticTimeoutMs",
  "semanticBackfillLimit",
] as const;

const INTERNAL_FIXED_KEYS = [
  "targetUri",
  "mem0UserId",
  "mem0AgentId",
  "mem0ApiKey",
  "mem0BaseUrl",
  "semanticEmbeddingModel",
  "semanticRerankModel",
] as const;

function resolveUserPath(rawPath: string): string {
  return resolvePath(resolveEnvVars(rawPath).replace(/^~/, homedir()));
}

function ensureInsideVikingBase(candidatePath: string, label: string): string {
  const rel = relative(VIKING_ROOT_BASE, candidatePath);
  const isInsideBase = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!isInsideBase) {
    throw new Error(`${label} must be inside ${VIKING_ROOT_BASE}`);
  }
  return candidatePath;
}

function readEnvConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`memory-viking-local env config must be a JSON object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function dropInternalFixedKeys(value: Record<string, unknown>): void {
  for (const key of INTERNAL_FIXED_KEYS) {
    if (key in value) {
      delete value[key];
    }
  }
}

function resolveOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveEnvVars(trimmed);
}

export const memoryLocalVikingConfigSchema = {
  parse(value: unknown): Required<MemoryLocalVikingConfig> {
    let pluginCfgRaw: Record<string, unknown> = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      pluginCfgRaw = value as Record<string, unknown>;
    }
    dropInternalFixedKeys(pluginCfgRaw);
    assertAllowedKeys(pluginCfgRaw, [...ENV_CONFIG_ALLOWED_KEYS], "memory-viking-local config");

    const rawEnvConfigPath =
      typeof pluginCfgRaw.envConfigPath === "string" && pluginCfgRaw.envConfigPath.trim()
        ? pluginCfgRaw.envConfigPath.trim()
        : DEFAULT_ENV_CONFIG_PATH;
    const resolvedEnvConfigPath = ensureInsideVikingBase(
      resolveUserPath(rawEnvConfigPath),
      "memory-viking-local envConfigPath",
    );

    const envCfgRaw = readEnvConfig(resolvedEnvConfigPath);
    dropInternalFixedKeys(envCfgRaw);
    assertAllowedKeys(envCfgRaw, [...ENV_CONFIG_ALLOWED_KEYS], "memory-viking-local env config");

    const cfg: Record<string, unknown> = {
      ...envCfgRaw,
      ...pluginCfgRaw,
      envConfigPath: resolvedEnvConfigPath,
    };

    const rawRootDir =
      typeof cfg.rootDir === "string" && cfg.rootDir.trim() ? cfg.rootDir.trim() : DEFAULT_ROOT_DIR;
    const resolvedRootDir = ensureInsideVikingBase(
      resolveUserPath(rawRootDir),
      "memory-viking-local rootDir",
    );

    const mem0BaseUrl = (process.env.VIKING_MEMORY_MEM0_URL?.trim() || DEFAULT_MEM0_BASE_URL).replace(/\/+$/, "");
    const mem0UserId = DEFAULT_MEM0_USER_ID;
    const mem0AgentId = DEFAULT_MEM0_AGENT_ID;
    const semanticEmbeddingModel = DEFAULT_SEMANTIC_EMBEDDING_MODEL;
    const semanticRerankModel = DEFAULT_SEMANTIC_RERANK_MODEL;

    return {
      envConfigPath: resolvedEnvConfigPath,
      rootDir: resolvedRootDir,
      debugLogs: cfg.debugLogs === true,
      targetUri: DEFAULT_TARGET_URI,
      recallLimit: Math.max(1, Math.min(20, Math.floor(toNumber(cfg.recallLimit, DEFAULT_RECALL_LIMIT)))),
      recallScoreThreshold: Math.max(
        0,
        Math.min(1, toNumber(cfg.recallScoreThreshold, DEFAULT_RECALL_SCORE_THRESHOLD)),
      ),
      includeOverviewInInject: cfg.includeOverviewInInject !== false,
      detailOnRecallTool: cfg.detailOnRecallTool === true,
      detailChars: Math.max(120, Math.min(20_000, Math.floor(toNumber(cfg.detailChars, DEFAULT_DETAIL_CHARS)))),
      detailCacheSize: Math.max(
        8,
        Math.min(1_024, Math.floor(toNumber(cfg.detailCacheSize, DEFAULT_DETAIL_CACHE_SIZE))),
      ),
      timelineRecallLimit: Math.max(
        1,
        Math.min(20, Math.floor(toNumber(cfg.timelineRecallLimit, DEFAULT_TIMELINE_RECALL_LIMIT))),
      ),
      timelineScoreThreshold: Math.max(
        0,
        Math.min(1, toNumber(cfg.timelineScoreThreshold, DEFAULT_TIMELINE_SCORE_THRESHOLD)),
      ),
      includeTimelineOverviewInInject: cfg.includeTimelineOverviewInInject !== false,
      mem0BaseUrl,
      mem0UserId,
      mem0AgentId,
      mem0TimeoutMs: Math.max(
        1_000,
        Math.min(120_000, Math.floor(toNumber(cfg.mem0TimeoutMs, DEFAULT_MEM0_TIMEOUT_MS))),
      ),
      semanticCandidateMultiplier: Math.max(
        1,
        Math.min(20, Math.floor(toNumber(cfg.semanticCandidateMultiplier, DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER))),
      ),
      semanticBlendWeight: Math.max(
        0,
        Math.min(1, toNumber(cfg.semanticBlendWeight, DEFAULT_SEMANTIC_BLEND_WEIGHT)),
      ),
      semanticTimeoutMs: Math.max(
        500,
        Math.min(120_000, Math.floor(toNumber(cfg.semanticTimeoutMs, DEFAULT_SEMANTIC_TIMEOUT_MS))),
      ),
      semanticEmbeddingModel,
      semanticRerankModel,
      semanticBackfillLimit: Math.max(
        0,
        Math.min(10_000, Math.floor(toNumber(cfg.semanticBackfillLimit, DEFAULT_SEMANTIC_BACKFILL_LIMIT))),
      ),
    };
  },
  uiHints: {
    envConfigPath: {
      label: "Env Config Path",
      placeholder: DEFAULT_ENV_CONFIG_PATH,
      help: "First-run interactive config JSON path. Plugin reads this file automatically.",
      advanced: true,
    },
    rootDir: {
      label: "Memory Root Dir",
      placeholder: DEFAULT_ROOT_DIR,
      help: "All memory and timeline data is stored here.",
    },
    debugLogs: {
      label: "Debug Logs",
      help: "Enable verbose runtime logs for troubleshooting.",
      placeholder: String(DEFAULT_DEBUG_LOGS),
      advanced: true,
    },
    recallLimit: {
      label: "Memory Recall Limit",
      placeholder: String(DEFAULT_RECALL_LIMIT),
      advanced: true,
    },
    recallScoreThreshold: {
      label: "Memory Recall Threshold",
      placeholder: String(DEFAULT_RECALL_SCORE_THRESHOLD),
      advanced: true,
    },
    includeOverviewInInject: {
      label: "Inject Memory Overview",
      help: "Include L1 overview snippets for extracted memories.",
      advanced: true,
    },
    timelineRecallLimit: {
      label: "Timeline Recall Limit",
      placeholder: String(DEFAULT_TIMELINE_RECALL_LIMIT),
      advanced: true,
    },
    timelineScoreThreshold: {
      label: "Timeline Recall Threshold",
      placeholder: String(DEFAULT_TIMELINE_SCORE_THRESHOLD),
      advanced: true,
    },
    includeTimelineOverviewInInject: {
      label: "Inject Timeline Overview",
      help: "Include L1 overview snippets for timeline chunks.",
      advanced: true,
    },
    detailOnRecallTool: {
      label: "Recall Tool Loads Details",
      help: "Whether recall tools load L2 details by default.",
      advanced: true,
    },
    detailChars: {
      label: "Detail Snippet Chars",
      placeholder: String(DEFAULT_DETAIL_CHARS),
      help: "Max L2 characters returned when details are requested.",
      advanced: true,
    },
    detailCacheSize: {
      label: "Detail Cache Size",
      placeholder: String(DEFAULT_DETAIL_CACHE_SIZE),
      help: "Max L2 files kept in in-memory LRU cache.",
      advanced: true,
    },
    mem0TimeoutMs: {
      label: "Mem0 Timeout (ms)",
      placeholder: String(DEFAULT_MEM0_TIMEOUT_MS),
      advanced: true,
    },
    semanticCandidateMultiplier: {
      label: "Semantic Candidate Multiplier",
      placeholder: String(DEFAULT_SEMANTIC_CANDIDATE_MULTIPLIER),
      help: "Multiplier for semantic candidate pool before rerank.",
      advanced: true,
    },
    semanticBlendWeight: {
      label: "Semantic Blend Weight",
      placeholder: String(DEFAULT_SEMANTIC_BLEND_WEIGHT),
      help: "Final score blend: semantic*(1-w)+rerank*w.",
      advanced: true,
    },
    semanticTimeoutMs: {
      label: "Semantic Timeout (ms)",
      placeholder: String(DEFAULT_SEMANTIC_TIMEOUT_MS),
      advanced: true,
    },
    semanticBackfillLimit: {
      label: "Semantic Backfill Limit",
      placeholder: String(DEFAULT_SEMANTIC_BACKFILL_LIMIT),
      help: "How many recent memory/timeline chunks to backfill into vector index on startup.",
      advanced: true,
    },
  },
};
