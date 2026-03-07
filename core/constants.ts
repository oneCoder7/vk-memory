export const PLUGIN_ID = "memory-viking-local";
export const PLUGIN_NAME = "Memory (Viking Local)";
export const PLUGIN_DESCRIPTION =
  "Local L0/L1/L2 memory module for OpenClaw with lazy loading from ~/.viking-memory";

export const INDEX_PATH = ["index", "catalog.json"];
export const MEMORIES_DIR_PATH = ["memories"];
export const TIMELINE_INDEX_PATH = ["timeline", "index", "catalog.json"];
export const TIMELINE_CHUNKS_DIR_PATH = ["timeline", "chunks"];
export const TIMELINE_SESSIONS_DIR_PATH = ["timeline", "sessions"];

export const META_FILE = "meta.json";
export const ABSTRACT_FILE = ".abstract.md";
export const OVERVIEW_FILE = ".overview.md";
export const CONTENT_FILE = "content.md";

export const TIMELINE_RECENT_FINGERPRINT_LIMIT = 512;
export const EXTRACTOR_MIN_PENDING_CHARS = 200;
export const EXTRACTOR_MIN_PENDING_ROUNDS = 2;
export const EXTRACTOR_FORCE_PENDING_TURNS = 12;
export const EXTRACTOR_MAX_PENDING_TURNS = 30;
export const EXTRACTOR_MAX_PENDING_CHARS = 8_000;

export const SEMANTIC_QDRANT_URL = process.env.VIKING_MEMORY_QDRANT_URL?.trim() || "http://127.0.0.1:16333";
export const SEMANTIC_QDRANT_COLLECTION = "viking_memory_local";
export const SEMANTIC_EMBEDDING_BASE_URL =
  process.env.VIKING_MEMORY_EMBEDDING_URL?.trim() || "http://127.0.0.1:17997";
export const SEMANTIC_RERANK_BASE_URL =
  process.env.VIKING_MEMORY_RERANK_URL?.trim() || "http://127.0.0.1:17998";
export const SEMANTIC_QDRANT_API_KEY = process.env.VIKING_MEMORY_QDRANT_API_KEY?.trim() ?? "";
