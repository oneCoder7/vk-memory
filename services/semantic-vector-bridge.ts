import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryLocalVikingConfig } from "../config.js";
import {
  SEMANTIC_EMBEDDING_BASE_URL,
  SEMANTIC_QDRANT_API_KEY,
  SEMANTIC_QDRANT_COLLECTION,
  SEMANTIC_QDRANT_URL,
  SEMANTIC_RERANK_BASE_URL,
} from "../core/constants.js";
import type {
  MemoryIndexEntry,
  SemanticRecallOptions,
  SemanticRerankDoc,
  SemanticSearchHit,
  TimelineChunkRecord,
} from "../core/types.js";
import { clamp01, safeJsonParse, truncate } from "../core/utils.js";
import type { VikingLocalMemoryStore } from "../stores/memory-store.js";
import type { VikingLocalTimelineStore } from "../stores/timeline-store.js";

export class SemanticVectorBridge {
  private warnedUnavailable = false;
  private collectionVectorSize: number | null = null;
  private backfillStarted = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly cfg: Required<MemoryLocalVikingConfig>,
    private readonly logger: OpenClawPluginApi["logger"],
  ) {}

  private enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job, job);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private qdrantCollectionPath(): string {
    return `${SEMANTIC_QDRANT_URL}/collections/${encodeURIComponent(SEMANTIC_QDRANT_COLLECTION)}`;
  }

  private qdrantHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (SEMANTIC_QDRANT_API_KEY) {
      headers["api-key"] = SEMANTIC_QDRANT_API_KEY;
    }
    return headers;
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text().catch(() => "");
      const body = text ? safeJsonParse<unknown>(text, null) : null;
      return {
        ok: response.ok,
        status: response.status,
        body,
        text,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private warnUnavailable(reason: string): void {
    if (this.warnedUnavailable) {
      return;
    }
    this.warnedUnavailable = true;
    this.logger.warn(
      `memory-viking-local: semantic layer unavailable (${reason}); recall may return empty until services recover.`,
    );
  }

  private async embed(text: string): Promise<number[] | null> {
    const payload = {
      model: this.cfg.semanticEmbeddingModel,
      input: truncate(text, 8_000),
    };

    const endpointA = `${SEMANTIC_EMBEDDING_BASE_URL}/embeddings`;
    const a = await this.fetchJson(
      endpointA,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (a?.ok && a.body && typeof a.body === "object") {
      const body = a.body as Record<string, unknown>;
      const data = Array.isArray(body.data) ? body.data : [];
      const first = data[0] as Record<string, unknown> | undefined;
      const embedding = Array.isArray(first?.embedding) ? first.embedding : [];
      const vector = embedding
        .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
        .filter((v): v is number => v !== null);
      if (vector.length > 0) {
        return vector;
      }
    }

    const endpointB = `${SEMANTIC_EMBEDDING_BASE_URL}/api/embed`;
    const b = await this.fetchJson(
      endpointB,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (b?.ok && b.body && typeof b.body === "object") {
      const body = b.body as Record<string, unknown>;
      const embeddings = Array.isArray(body.embeddings) ? body.embeddings : [];
      const first = Array.isArray(embeddings[0]) ? embeddings[0] : [];
      const vector = first
        .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
        .filter((v): v is number => v !== null);
      if (vector.length > 0) {
        return vector;
      }
    }

    this.warnUnavailable("embedding endpoint error");
    return null;
  }

  private async ensureCollection(vectorSize: number): Promise<boolean> {
    if (this.collectionVectorSize === vectorSize) {
      return true;
    }

    const base = this.qdrantCollectionPath();
    const getRes = await this.fetchJson(
      base,
      {
        method: "GET",
        headers: this.qdrantHeaders(),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (getRes?.ok) {
      this.collectionVectorSize = vectorSize;
      return true;
    }

    const createRes = await this.fetchJson(
      base,
      {
        method: "PUT",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        }),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (createRes?.ok) {
      this.collectionVectorSize = vectorSize;
      return true;
    }

    this.warnUnavailable("qdrant collection unavailable");
    return false;
  }

  private normalizeRankScores(raw: Array<{ id: string; score: number }>): Map<string, number> {
    if (raw.length === 0) {
      return new Map<string, number>();
    }
    const scores = raw.map((item) => item.score).filter((v) => Number.isFinite(v));
    if (scores.length === 0) {
      return new Map<string, number>();
    }
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    const out = new Map<string, number>();
    for (const item of raw) {
      if (!Number.isFinite(item.score)) {
        continue;
      }
      if (range <= 1e-9) {
        out.set(item.id, clamp01(item.score));
      } else {
        out.set(item.id, clamp01((item.score - min) / range));
      }
    }
    return out;
  }

  async rerank(query: string, docs: SemanticRerankDoc[]): Promise<Map<string, number>> {
    if (docs.length === 0) {
      return new Map<string, number>();
    }
    const endpoint = `${SEMANTIC_RERANK_BASE_URL}/rerank`;
    const res = await this.fetchJson(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.semanticRerankModel,
          query,
          documents: docs.map((d) => d.text),
          top_n: docs.length,
        }),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (!res?.ok || !res.body || typeof res.body !== "object") {
      return new Map<string, number>();
    }

    const body = res.body as Record<string, unknown>;
    const results = Array.isArray(body.results) ? body.results : [];
    const scored: Array<{ id: string; score: number }> = [];
    for (const item of results) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const idx = typeof row.index === "number" && Number.isFinite(row.index) ? Math.floor(row.index) : -1;
      if (idx < 0 || idx >= docs.length) {
        continue;
      }
      const rawScore =
        typeof row.relevance_score === "number"
          ? row.relevance_score
          : typeof row.score === "number"
            ? row.score
            : NaN;
      if (!Number.isFinite(rawScore)) {
        continue;
      }
      scored.push({ id: docs[idx]!.id, score: rawScore });
    }

    return this.normalizeRankScores(scored);
  }

  async search(query: string, options: SemanticRecallOptions): Promise<SemanticSearchHit[]> {
    const vector = await this.embed(query);
    if (!vector || vector.length === 0) {
      return [];
    }
    const ok = await this.ensureCollection(vector.length);
    if (!ok) {
      return [];
    }

    const filter: Record<string, unknown> = {
      must: [
        {
          key: "kind",
          match: { value: options.source },
        },
      ],
    };
    if (options.excludeSessionId && options.source === "timeline") {
      filter.must_not = [
        {
          key: "sessionId",
          match: { value: options.excludeSessionId },
        },
      ];
    }

    const endpoint = `${this.qdrantCollectionPath()}/points/search`;
    const res = await this.fetchJson(
      endpoint,
      {
        method: "POST",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          vector,
          with_payload: true,
          limit: Math.max(1, options.limit),
          filter,
        }),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);

    if (!res?.ok || !res.body || typeof res.body !== "object") {
      this.warnUnavailable("qdrant search failed");
      return [];
    }

    const body = res.body as Record<string, unknown>;
    const rows = Array.isArray(body.result) ? body.result : [];
    const hits: SemanticSearchHit[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") {
        continue;
      }
      const item = row as Record<string, unknown>;
      const payload =
        item.payload && typeof item.payload === "object" ? (item.payload as Record<string, unknown>) : {};
      const uri =
        typeof payload.uri === "string" ? payload.uri : typeof item.id === "string" ? item.id : "";
      const score = clamp01(typeof item.score === "number" ? item.score : 0);
      if (!uri) {
        continue;
      }
      hits.push({ uri, score });
    }
    return hits;
  }

  async upsertMemoryRows(rows: Array<{ entry: MemoryIndexEntry; content: string }>): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.enqueueWrite(async () => {
      const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
      for (const row of rows) {
        const text = `${row.entry.abstract}\n${row.entry.overview}\n${row.content}`;
        const vector = await this.embed(text);
        if (!vector || vector.length === 0) {
          continue;
        }
        const ok = await this.ensureCollection(vector.length);
        if (!ok) {
          return;
        }
        points.push({
          id: row.entry.uri,
          vector,
          payload: {
            kind: "memory",
            uri: row.entry.uri,
            category: row.entry.category,
            abstract: row.entry.abstract,
            overview: row.entry.overview,
            updatedAt: row.entry.updatedAt,
          },
        });
      }
      if (points.length === 0) {
        return;
      }
      const endpoint = `${this.qdrantCollectionPath()}/points?wait=false`;
      const res = await this.fetchJson(
        endpoint,
        {
          method: "PUT",
          headers: this.qdrantHeaders(),
          body: JSON.stringify({ points }),
        },
        this.cfg.semanticTimeoutMs,
      ).catch(() => null);
      if (!res?.ok) {
        this.warnUnavailable("qdrant upsert failed");
      }
    });
  }

  async upsertTimelineRows(rows: TimelineChunkRecord[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.enqueueWrite(async () => {
      const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> = [];
      for (const row of rows) {
        const text = `${row.entry.abstract}\n${row.entry.overview}\n${row.content}`;
        const vector = await this.embed(text);
        if (!vector || vector.length === 0) {
          continue;
        }
        const ok = await this.ensureCollection(vector.length);
        if (!ok) {
          return;
        }
        points.push({
          id: row.entry.uri,
          vector,
          payload: {
            kind: "timeline",
            uri: row.entry.uri,
            sessionId: row.entry.sessionId,
            role: row.entry.role,
            abstract: row.entry.abstract,
            overview: row.entry.overview,
            updatedAt: row.entry.updatedAt,
          },
        });
      }
      if (points.length === 0) {
        return;
      }
      const endpoint = `${this.qdrantCollectionPath()}/points?wait=false`;
      const res = await this.fetchJson(
        endpoint,
        {
          method: "PUT",
          headers: this.qdrantHeaders(),
          body: JSON.stringify({ points }),
        },
        this.cfg.semanticTimeoutMs,
      ).catch(() => null);
      if (!res?.ok) {
        this.warnUnavailable("qdrant upsert failed");
      }
    });
  }

  async deleteUris(uris: string[]): Promise<void> {
    if (uris.length === 0) {
      return;
    }
    const cleaned = [...new Set(uris.map((u) => u.trim()).filter(Boolean))];
    if (cleaned.length === 0) {
      return;
    }
    const endpoint = `${this.qdrantCollectionPath()}/points/delete?wait=false`;
    const res = await this.fetchJson(
      endpoint,
      {
        method: "POST",
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          points: cleaned,
        }),
      },
      this.cfg.semanticTimeoutMs,
    ).catch(() => null);
    if (!res?.ok) {
      this.warnUnavailable("qdrant delete failed");
    }
  }

  async startBackfill(store: VikingLocalMemoryStore, timelineStore: VikingLocalTimelineStore): Promise<void> {
    if (this.backfillStarted || this.cfg.semanticBackfillLimit <= 0) {
      return;
    }
    this.backfillStarted = true;
    const limit = this.cfg.semanticBackfillLimit;
    try {
      const [memRows, timelineRows] = await Promise.all([
        store.exportForSemantic(limit),
        timelineStore.exportForSemantic(limit),
      ]);
      await this.upsertMemoryRows(memRows);
      await this.upsertTimelineRows(timelineRows);
      this.logger.info?.(
        `memory-viking-local: semantic backfill complete memory=${memRows.length}, timeline=${timelineRows.length}`,
      );
    } catch (err) {
      this.logger.warn(`memory-viking-local: semantic backfill failed: ${String(err)}`);
    }
  }
}

export function applySemanticScores<T extends { uri: string; score: number }>(
  rows: T[],
  hits: SemanticSearchHit[],
): T[] {
  if (rows.length === 0 || hits.length === 0) {
    return rows;
  }
  const semanticMap = new Map<string, number>(hits.map((hit) => [hit.uri, clamp01(hit.score)]));
  return rows.map((row) => {
    const semanticScore = semanticMap.get(row.uri);
    if (typeof semanticScore !== "number") {
      return row;
    }
    return {
      ...row,
      score: semanticScore,
    };
  });
}

export function applyRerankBlend<T extends { uri: string; score: number }>(
  rows: T[],
  rerankScores: Map<string, number>,
  blendWeight: number,
): T[] {
  if (rows.length === 0 || rerankScores.size === 0) {
    return rows;
  }
  const weight = clamp01(blendWeight);
  return rows.map((row) => {
    const rank = rerankScores.get(row.uri);
    if (typeof rank !== "number") {
      return row;
    }
    return {
      ...row,
      score: clamp01(clamp01(row.score) * (1 - weight) + clamp01(rank) * weight),
    };
  });
}
