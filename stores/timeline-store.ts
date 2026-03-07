import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryLocalVikingConfig } from "../config.js";
import {
  ABSTRACT_FILE,
  CONTENT_FILE,
  EXTRACTOR_FORCE_PENDING_TURNS,
  EXTRACTOR_MAX_PENDING_CHARS,
  EXTRACTOR_MAX_PENDING_TURNS,
  EXTRACTOR_MIN_PENDING_CHARS,
  EXTRACTOR_MIN_PENDING_ROUNDS,
  META_FILE,
  OVERVIEW_FILE,
  TIMELINE_CHUNKS_DIR_PATH,
  TIMELINE_INDEX_PATH,
  TIMELINE_RECENT_FINGERPRINT_LIMIT,
  TIMELINE_SESSIONS_DIR_PATH,
} from "../core/constants.js";
import type {
  ExtractorBatchDecision,
  TimelineCaptureStats,
  TimelineChunkRecord,
  TimelineDetailRecord,
  TimelineIndexEntry,
  TimelineMatch,
  TimelineSessionState,
  TimelineTurn,
} from "../core/types.js";
import {
  buildAbstract,
  buildMemoryId,
  clamp01,
  contentHash,
  extractKeywords,
  extractTimelineMessages,
  normalizeForDedupe,
  nowIso,
  pathExists,
  safeJsonParse,
  sanitizeTextForMemory,
  splitSentences,
  truncate,
  truncateForDetail,
  writeJsonAtomic,
  writeTextAtomic,
} from "../core/utils.js";

function buildTimelineOverview(text: string, role: string, sessionId: string, abstract: string): string {
  const snippets = splitSentences(text).slice(0, 2);
  const lines = snippets.map((line) => `- ${truncate(line, 260)}`);
  if (lines.length === 0) {
    lines.push(`- ${abstract}`);
  }
  return [`Session: ${sessionId}`, `Role: ${role}`, ...lines].join("\n");
}

function inferTimelineImportance(role: string, text: string): number {
  let score = 0.28;
  if (role === "user") {
    score += 0.2;
  } else if (role === "assistant") {
    score += 0.08;
  } else {
    score += 0.12;
  }
  if (text.length > 420) {
    score += 0.08;
  }
  if (/must|always|never|important|必须|务必|总是|永远|关键/.test(text.toLowerCase())) {
    score += 0.12;
  }
  return clamp01(score);
}

export class VikingLocalTimelineStore {
  private readonly rootDir: string;
  private readonly indexPath: string;
  private readonly chunksDir: string;
  private readonly sessionsDir: string;
  private readonly detailCacheSize: number;

  private indexCache: TimelineIndexEntry[] | null = null;
  private detailCache = new Map<string, TimelineDetailRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: Required<MemoryLocalVikingConfig>) {
    this.rootDir = cfg.rootDir;
    this.indexPath = join(this.rootDir, ...TIMELINE_INDEX_PATH);
    this.chunksDir = join(this.rootDir, ...TIMELINE_CHUNKS_DIR_PATH);
    this.sessionsDir = join(this.rootDir, ...TIMELINE_SESSIONS_DIR_PATH);
    this.detailCacheSize = cfg.detailCacheSize;
  }

  async init(): Promise<void> {
    await mkdir(join(this.rootDir, "timeline"), { recursive: true });
    await mkdir(join(this.rootDir, "timeline", "index"), { recursive: true });
    await mkdir(this.chunksDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
  }

  private enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job, job);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadIndex(): Promise<TimelineIndexEntry[]> {
    if (this.indexCache) {
      return this.indexCache;
    }
    if (!(await pathExists(this.indexPath))) {
      this.indexCache = [];
      return this.indexCache;
    }
    const raw = await readFile(this.indexPath, "utf-8");
    const parsed = safeJsonParse<TimelineIndexEntry[]>(raw, []);
    const normalized = Array.isArray(parsed)
      ? parsed
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: String(item.id ?? ""),
            uri: String(item.uri ?? ""),
            sessionId: String(item.sessionId ?? ""),
            role: String(item.role ?? "unknown"),
            abstract: String(item.abstract ?? ""),
            overview: String(item.overview ?? ""),
            keywords: Array.isArray(item.keywords)
              ? item.keywords
                  .map((v) => String(v ?? "").trim())
                  .filter(Boolean)
                  .slice(0, 64)
              : [],
            importance: clamp01(typeof item.importance === "number" ? item.importance : 0.25),
            sourceHash: String(item.sourceHash ?? ""),
            createdAt: String(item.createdAt ?? ""),
            updatedAt: String(item.updatedAt ?? ""),
          }))
          .filter((item) => item.id && item.uri && item.abstract && item.sessionId)
      : [];

    normalized.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    this.indexCache = normalized;
    return normalized;
  }

  private async persistIndex(index: TimelineIndexEntry[]): Promise<void> {
    await writeJsonAtomic(this.indexPath, index);
    this.indexCache = index;
  }

  private getChunkDir(id: string): string {
    return join(this.chunksDir, id);
  }

  private getStatePath(sessionId: string): string {
    return join(this.sessionsDir, sessionId, "state.json");
  }

  private async loadSessionState(sessionId: string): Promise<TimelineSessionState> {
    const path = this.getStatePath(sessionId);
    if (!(await pathExists(path))) {
      return {
        sessionId,
        processedCount: 0,
        recentFingerprints: [],
        extractorPendingTurns: [],
        extractorPendingChars: 0,
        extractorPendingRounds: 0,
        updatedAt: nowIso(),
      };
    }
    const raw = await readFile(path, "utf-8").catch(() => "{}");
    const parsed = safeJsonParse<Record<string, unknown>>(raw, {});

    const pendingTurns = Array.isArray(parsed.extractorPendingTurns)
      ? parsed.extractorPendingTurns
          .map((rawTurn) => {
            if (!rawTurn || typeof rawTurn !== "object") {
              return null;
            }
            const turn = rawTurn as Record<string, unknown>;
            const role = typeof turn.role === "string" ? turn.role.trim() : "";
            const text = typeof turn.text === "string" ? sanitizeTextForMemory(turn.text) : "";
            if (!role || !text) {
              return null;
            }
            return { role, text };
          })
          .filter((turn): turn is TimelineTurn => Boolean(turn))
          .slice(-EXTRACTOR_MAX_PENDING_TURNS)
      : [];

    const pendingChars =
      typeof parsed.extractorPendingChars === "number" && Number.isFinite(parsed.extractorPendingChars)
        ? Math.max(0, Math.floor(parsed.extractorPendingChars))
        : pendingTurns.reduce((sum, turn) => sum + turn.text.length, 0);

    return {
      sessionId,
      processedCount:
        typeof parsed.processedCount === "number" && Number.isFinite(parsed.processedCount)
          ? Math.max(0, Math.floor(parsed.processedCount))
          : 0,
      recentFingerprints: Array.isArray(parsed.recentFingerprints)
        ? parsed.recentFingerprints
            .map((v) => String(v ?? "").trim())
            .filter(Boolean)
            .slice(-TIMELINE_RECENT_FINGERPRINT_LIMIT)
        : [],
      extractorPendingTurns: pendingTurns,
      extractorPendingChars: pendingChars,
      extractorPendingRounds:
        typeof parsed.extractorPendingRounds === "number" && Number.isFinite(parsed.extractorPendingRounds)
          ? Math.max(0, Math.floor(parsed.extractorPendingRounds))
          : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    };
  }

  private async persistSessionState(sessionId: string, state: TimelineSessionState): Promise<void> {
    const sessionDir = join(this.sessionsDir, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeJsonAtomic(this.getStatePath(sessionId), state);
  }

  private finalizePendingTurns(turns: TimelineTurn[]): { turns: TimelineTurn[]; chars: number } {
    const normalized: TimelineTurn[] = [];
    let chars = 0;

    for (const turn of turns) {
      const role = typeof turn.role === "string" ? turn.role.trim() : "";
      const text = typeof turn.text === "string" ? sanitizeTextForMemory(turn.text) : "";
      if (!role || !text) {
        continue;
      }
      normalized.push({ role, text });
      chars += text.length;
    }

    while (normalized.length > EXTRACTOR_MAX_PENDING_TURNS) {
      const removed = normalized.shift();
      if (removed) {
        chars = Math.max(0, chars - removed.text.length);
      }
    }

    while (chars > EXTRACTOR_MAX_PENDING_CHARS && normalized.length > 1) {
      const removed = normalized.shift();
      if (removed) {
        chars = Math.max(0, chars - removed.text.length);
      }
    }

    return { turns: normalized, chars };
  }

  async prepareExtractorBatch(sessionId: string, newTurns: TimelineTurn[]): Promise<ExtractorBatchDecision> {
    if (newTurns.length === 0) {
      return {
        shouldExtract: false,
        reason: "empty_new_turns",
        batch: [],
        pendingTurns: 0,
        pendingChars: 0,
        pendingRounds: 0,
      };
    }

    return this.enqueueWrite(async () => {
      const state = await this.loadSessionState(sessionId);
      const merged = [...state.extractorPendingTurns, ...newTurns];
      const finalized = this.finalizePendingTurns(merged);

      const pendingTurns = finalized.turns.length;
      const pendingChars = finalized.chars;
      const pendingRounds = Math.max(0, state.extractorPendingRounds) + 1;
      const shouldForce = pendingTurns >= EXTRACTOR_FORCE_PENDING_TURNS;
      const shouldByWindow =
        pendingRounds >= EXTRACTOR_MIN_PENDING_ROUNDS && pendingChars >= EXTRACTOR_MIN_PENDING_CHARS;
      const shouldExtract = shouldForce || shouldByWindow;

      const nextState: TimelineSessionState = {
        ...state,
        extractorPendingTurns: shouldExtract ? [] : finalized.turns,
        extractorPendingChars: shouldExtract ? 0 : pendingChars,
        extractorPendingRounds: shouldExtract ? 0 : pendingRounds,
        updatedAt: nowIso(),
      };
      await this.persistSessionState(sessionId, nextState);

      if (shouldExtract) {
        return {
          shouldExtract: true,
          reason: shouldForce ? "force_turn_cap" : "window_reached",
          batch: finalized.turns,
          pendingTurns,
          pendingChars,
          pendingRounds,
        };
      }

      return {
        shouldExtract: false,
        reason: "window_not_reached",
        batch: [],
        pendingTurns,
        pendingChars,
        pendingRounds,
      };
    });
  }

  async requeueExtractorBatch(sessionId: string, batch: TimelineTurn[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    await this.enqueueWrite(async () => {
      const state = await this.loadSessionState(sessionId);
      const merged = [...batch, ...state.extractorPendingTurns];
      const finalized = this.finalizePendingTurns(merged);
      const nextState: TimelineSessionState = {
        ...state,
        extractorPendingTurns: finalized.turns,
        extractorPendingChars: finalized.chars,
        extractorPendingRounds: Math.max(1, state.extractorPendingRounds),
        updatedAt: nowIso(),
      };
      await this.persistSessionState(sessionId, nextState);
    });
  }

  private async getDetail(id: string): Promise<TimelineDetailRecord | null> {
    const cached = this.detailCache.get(id);
    if (cached) {
      this.detailCache.delete(id);
      this.detailCache.set(id, cached);
      return cached;
    }

    const dir = this.getChunkDir(id);
    const contentPath = join(dir, CONTENT_FILE);
    const metaPath = join(dir, META_FILE);
    if (!(await pathExists(contentPath))) {
      return null;
    }

    const content = await readFile(contentPath, "utf-8").catch(() => "");
    const metaRaw = await readFile(metaPath, "utf-8").catch(() => "{}");
    const meta = safeJsonParse<Record<string, unknown>>(metaRaw, {});
    const detail: TimelineDetailRecord = {
      content,
      role: typeof meta.role === "string" ? meta.role : "unknown",
      metadata:
        typeof meta.metadata === "object" && meta.metadata ? (meta.metadata as Record<string, unknown>) : undefined,
    };

    this.detailCache.set(id, detail);
    while (this.detailCache.size > this.detailCacheSize) {
      const oldest = this.detailCache.keys().next().value;
      if (!oldest) {
        break;
      }
      this.detailCache.delete(oldest);
    }

    return detail;
  }

  private buildUri(sessionId: string, id: string): string {
    return `viking://user/timeline/${sessionId}/${id}`;
  }

  async captureEvent(sessionId: string, messages: unknown[]): Promise<TimelineCaptureStats> {
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        sessionId,
        observed: 0,
        ingested: 0,
        duplicates: 0,
        processedCount: 0,
        newTurns: [],
        newChunks: [],
      };
    }

    return this.enqueueWrite(async () => {
      const index = await this.loadIndex();
      const state = await this.loadSessionState(sessionId);
      const safeProcessed = Number.isFinite(state.processedCount) && state.processedCount >= 0 ? state.processedCount : 0;
      const start = messages.length >= safeProcessed ? safeProcessed : 0;
      const recentList = [...state.recentFingerprints].slice(-TIMELINE_RECENT_FINGERPRINT_LIMIT);
      const recentSet = new Set<string>(recentList);

      const observedMessages = extractTimelineMessages(messages.slice(start));
      const newEntries: TimelineIndexEntry[] = [];
      const newTurns: TimelineTurn[] = [];
      const newChunks: TimelineChunkRecord[] = [];
      let duplicates = 0;

      for (const item of observedMessages) {
        const fingerprint = contentHash(`${sessionId}|${item.role}|${normalizeForDedupe(item.text)}`);
        if (recentSet.has(fingerprint)) {
          duplicates += 1;
          const existingIdx = recentList.indexOf(fingerprint);
          if (existingIdx >= 0) {
            recentList.splice(existingIdx, 1);
          }
          recentList.push(fingerprint);
          continue;
        }

        recentSet.add(fingerprint);
        recentList.push(fingerprint);

        const id = buildMemoryId();
        const createdAt = nowIso();
        const abstract = buildAbstract(item.text);
        const overview = buildTimelineOverview(item.text, item.role, sessionId, abstract);
        const importance = inferTimelineImportance(item.role, item.text);
        const keywords = extractKeywords(`${item.role} ${item.text}`);
        const entry: TimelineIndexEntry = {
          id,
          uri: this.buildUri(sessionId, id),
          sessionId,
          role: item.role,
          abstract,
          overview,
          keywords,
          importance,
          sourceHash: `${sessionId}:${fingerprint}`,
          createdAt,
          updatedAt: createdAt,
        };

        const chunkDir = this.getChunkDir(id);
        await mkdir(chunkDir, { recursive: true });
        await Promise.all([
          writeTextAtomic(join(chunkDir, ABSTRACT_FILE), `${abstract}\n`),
          writeTextAtomic(join(chunkDir, OVERVIEW_FILE), `${overview}\n`),
          writeTextAtomic(join(chunkDir, CONTENT_FILE), `${item.text}\n`),
          writeJsonAtomic(join(chunkDir, META_FILE), {
            id,
            uri: entry.uri,
            sessionId,
            role: item.role,
            keywords,
            importance,
            createdAt,
            updatedAt: createdAt,
          }),
        ]);

        newEntries.push(entry);
        newTurns.push({ role: item.role, text: item.text });
        newChunks.push({ entry, content: item.text });
      }

      const trimmedRecent = recentList.slice(-TIMELINE_RECENT_FINGERPRINT_LIMIT);
      const nextState: TimelineSessionState = {
        sessionId,
        processedCount: messages.length,
        recentFingerprints: trimmedRecent,
        extractorPendingTurns: state.extractorPendingTurns,
        extractorPendingChars: state.extractorPendingChars,
        extractorPendingRounds: state.extractorPendingRounds,
        updatedAt: nowIso(),
      };
      await this.persistSessionState(sessionId, nextState);

      if (newEntries.length > 0) {
        const nextIndex = [...newEntries.reverse(), ...index];
        await this.persistIndex(nextIndex);
      }

      return {
        sessionId,
        observed: observedMessages.length,
        ingested: newEntries.length,
        duplicates,
        processedCount: messages.length,
        newTurns,
        newChunks,
      };
    });
  }

  async getByUris(
    uris: string[],
    options: { includeDetails: boolean; detailChars: number; excludeSessionId?: string },
  ): Promise<TimelineMatch[]> {
    if (uris.length === 0) {
      return [];
    }
    const index = await this.loadIndex();
    if (index.length === 0) {
      return [];
    }

    const map = new Map(index.map((entry) => [entry.uri, entry]));
    const seen = new Set<string>();
    const matches: TimelineMatch[] = [];

    for (const uri of uris) {
      if (!uri || seen.has(uri)) {
        continue;
      }
      seen.add(uri);
      const entry = map.get(uri);
      if (!entry) {
        continue;
      }
      if (options.excludeSessionId && entry.sessionId === options.excludeSessionId) {
        continue;
      }
      const match: TimelineMatch = {
        ...entry,
        score: 0,
      };
      if (options.includeDetails) {
        const detail = await this.getDetail(entry.id);
        if (detail?.content) {
          match.detail = truncateForDetail(detail.content, options.detailChars);
        }
      }
      matches.push(match);
    }
    return matches;
  }

  async exportForSemantic(limit: number): Promise<TimelineChunkRecord[]> {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) {
      return [];
    }
    const index = await this.loadIndex();
    const rows: TimelineChunkRecord[] = [];
    for (const entry of index.slice(0, safeLimit)) {
      const detail = await this.getDetail(entry.id);
      if (!detail?.content) {
        continue;
      }
      rows.push({ entry, content: detail.content });
    }
    return rows;
  }

  async stats(): Promise<Record<string, unknown>> {
    const index = await this.loadIndex();
    const byRole = new Map<string, number>();
    const sessions = new Set<string>();

    for (const item of index) {
      byRole.set(item.role, (byRole.get(item.role) ?? 0) + 1);
      sessions.add(item.sessionId);
    }

    let diskBytes = 0;
    for (const item of index.slice(0, 2000)) {
      const file = join(this.getChunkDir(item.id), CONTENT_FILE);
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) {
        diskBytes += s.size;
      }
    }

    return {
      rootDir: join(this.rootDir, "timeline"),
      total: index.length,
      sessions: sessions.size,
      byRole: Object.fromEntries(byRole.entries()),
      detailCacheSize: this.detailCache.size,
      sampledContentBytes: diskBytes,
    };
  }
}
