import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryLocalVikingConfig } from "../config.js";
import {
  CONTENT_FILE,
  INDEX_PATH,
  MEMORIES_DIR_PATH,
  ABSTRACT_FILE,
  OVERVIEW_FILE,
  META_FILE,
} from "../core/constants.js";
import type { MemoryDetailRecord, MemoryIndexEntry, MemoryMatch, MemoryCategory } from "../core/types.js";
import {
  buildAbstract,
  buildMemoryId,
  buildOverview,
  clamp01,
  contentHash,
  extractKeywords,
  inferCategory,
  inferImportance,
  normalizeForDedupe,
  parseMemoryIdFromUri,
  pathExists,
  safeJsonParse,
  sanitizeTextForMemory,
  truncateForDetail,
  writeJsonAtomic,
  writeTextAtomic,
  nowIso,
} from "../core/utils.js";

export class VikingLocalMemoryStore {
  private readonly rootDir: string;
  private readonly indexPath: string;
  private readonly memoriesDir: string;
  private readonly targetUri: string;
  private readonly detailCacheSize: number;

  private indexCache: MemoryIndexEntry[] | null = null;
  private detailCache = new Map<string, MemoryDetailRecord>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: Required<MemoryLocalVikingConfig>) {
    this.rootDir = cfg.rootDir;
    this.indexPath = join(this.rootDir, ...INDEX_PATH);
    this.memoriesDir = join(this.rootDir, ...MEMORIES_DIR_PATH);
    this.targetUri = cfg.targetUri.replace(/\/+$/, "");
    this.detailCacheSize = cfg.detailCacheSize;
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(join(this.rootDir, "index"), { recursive: true });
    await mkdir(this.memoriesDir, { recursive: true });
  }

  async repairLayer0(): Promise<{ fixedEntries: number; fixedFiles: number }> {
    return this.enqueueWrite(async () => {
      const index = await this.loadIndex();
      if (index.length === 0) {
        return { fixedEntries: 0, fixedFiles: 0 };
      }

      let fixedEntries = 0;
      let fixedFiles = 0;
      let indexChanged = false;

      for (const entry of index) {
        const memoryDir = this.getMemoryDir(entry.id);
        const abstractPath = join(memoryDir, ABSTRACT_FILE);
        let abstract = typeof entry.abstract === "string" ? entry.abstract.trim() : "";

        if (!abstract) {
          const detail = await this.getDetail(entry.id);
          const content = typeof detail?.content === "string" ? detail.content.trim() : "";
          if (content) {
            abstract = buildAbstract(content);
          } else if (typeof entry.overview === "string" && entry.overview.trim()) {
            abstract = buildAbstract(entry.overview.trim());
          }
          if (abstract) {
            entry.abstract = abstract;
            entry.updatedAt = nowIso();
            fixedEntries += 1;
            indexChanged = true;
          }
        }

        if (abstract && !(await pathExists(abstractPath))) {
          await writeTextAtomic(abstractPath, `${abstract}\n`);
          fixedFiles += 1;
        }
      }

      if (indexChanged) {
        index.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        await this.persistIndex(index);
      }

      return { fixedEntries, fixedFiles };
    });
  }

  private enqueueWrite<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(job, job);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadIndex(): Promise<MemoryIndexEntry[]> {
    if (this.indexCache) {
      return this.indexCache;
    }
    if (!(await pathExists(this.indexPath))) {
      this.indexCache = [];
      return this.indexCache;
    }
    const raw = await readFile(this.indexPath, "utf-8");
    const parsed = safeJsonParse<MemoryIndexEntry[]>(raw, []);
    const normalized = Array.isArray(parsed)
      ? parsed
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: String(item.id ?? ""),
            uri: String(item.uri ?? ""),
            category: (item.category ?? "fact") as MemoryCategory,
            abstract: String(item.abstract ?? ""),
            overview: String(item.overview ?? ""),
            keywords: Array.isArray(item.keywords)
              ? item.keywords
                  .map((v) => String(v ?? "").trim())
                  .filter(Boolean)
                  .slice(0, 64)
              : [],
            importance: clamp01(typeof item.importance === "number" ? item.importance : 0.35),
            sourceHash: String(item.sourceHash ?? ""),
            createdAt: String(item.createdAt ?? ""),
            updatedAt: String(item.updatedAt ?? ""),
          }))
          .filter((item) => item.id && item.uri && item.abstract)
      : [];

    normalized.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    this.indexCache = normalized;
    return normalized;
  }

  private async persistIndex(index: MemoryIndexEntry[]): Promise<void> {
    await writeJsonAtomic(this.indexPath, index);
    this.indexCache = index;
  }

  private getMemoryDir(id: string): string {
    return join(this.memoriesDir, id);
  }

  private async getDetail(id: string): Promise<MemoryDetailRecord | null> {
    const cached = this.detailCache.get(id);
    if (cached) {
      this.detailCache.delete(id);
      this.detailCache.set(id, cached);
      return cached;
    }

    const dir = this.getMemoryDir(id);
    const contentPath = join(dir, CONTENT_FILE);
    const metaPath = join(dir, META_FILE);

    if (!(await pathExists(contentPath))) {
      return null;
    }

    const content = await readFile(contentPath, "utf-8").catch(() => "");
    const metaRaw = await readFile(metaPath, "utf-8").catch(() => "{}");
    const meta = safeJsonParse<Record<string, unknown>>(metaRaw, {});

    const detail: MemoryDetailRecord = {
      content,
      sourceRole: typeof meta.sourceRole === "string" ? meta.sourceRole : "user",
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

  async store(
    rawText: string,
    options?: {
      sourceRole?: string;
      category?: MemoryCategory;
      metadata?: Record<string, unknown>;
      abstract?: string;
      overview?: string;
      importance?: number;
    },
  ): Promise<{ entry: MemoryIndexEntry; duplicate: boolean; content: string }> {
    const sanitized = sanitizeTextForMemory(rawText);
    if (!sanitized) {
      throw new Error("Cannot store empty memory text");
    }

    const normalizedDedupe = normalizeForDedupe(sanitized);
    const sourceHash = contentHash(normalizedDedupe);

    return this.enqueueWrite(async () => {
      const index = await this.loadIndex();
      const existing = index.find((item) => item.sourceHash === sourceHash);
      if (existing) {
        return { entry: existing, duplicate: true, content: sanitized };
      }

      const id = buildMemoryId();
      const category = options?.category ?? inferCategory(sanitized);
      const abstract = options?.abstract?.trim() ? options.abstract.trim() : buildAbstract(sanitized);
      const overview = options?.overview?.trim()
        ? options.overview.trim()
        : buildOverview(sanitized, category, abstract);
      const keywords = extractKeywords(`${abstract}\n${sanitized}`);
      const createdAt = nowIso();
      const updatedAt = createdAt;
      const importance =
        typeof options?.importance === "number" ? clamp01(options.importance) : inferImportance(sanitized, category);

      const entry: MemoryIndexEntry = {
        id,
        uri: `${this.targetUri}/${id}`,
        category,
        abstract,
        overview,
        keywords,
        importance,
        sourceHash,
        createdAt,
        updatedAt,
      };

      const memoryDir = this.getMemoryDir(id);
      await mkdir(memoryDir, { recursive: true });

      await Promise.all([
        writeTextAtomic(join(memoryDir, ABSTRACT_FILE), `${abstract}\n`),
        writeTextAtomic(join(memoryDir, OVERVIEW_FILE), `${overview}\n`),
        writeTextAtomic(join(memoryDir, CONTENT_FILE), `${sanitized}\n`),
        writeJsonAtomic(join(memoryDir, META_FILE), {
          id,
          uri: entry.uri,
          category,
          keywords,
          importance,
          createdAt,
          updatedAt,
          sourceRole: options?.sourceRole ?? "user",
          metadata: options?.metadata ?? {},
        }),
      ]);

      const nextIndex = [entry, ...index];
      await this.persistIndex(nextIndex);
      return { entry, duplicate: false, content: sanitized };
    });
  }

  async getByUris(
    uris: string[],
    options: { includeDetails: boolean; detailChars: number },
  ): Promise<MemoryMatch[]> {
    if (uris.length === 0) {
      return [];
    }
    const index = await this.loadIndex();
    if (index.length === 0) {
      return [];
    }

    const map = new Map(index.map((entry) => [entry.uri, entry]));
    const seen = new Set<string>();
    const matches: MemoryMatch[] = [];

    for (const uri of uris) {
      if (!uri || seen.has(uri)) {
        continue;
      }
      seen.add(uri);
      const entry = map.get(uri);
      if (!entry) {
        continue;
      }
      const match: MemoryMatch = {
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

  async exportForSemantic(limit: number): Promise<Array<{ entry: MemoryIndexEntry; content: string }>> {
    const safeLimit = Math.max(0, Math.floor(limit));
    if (safeLimit === 0) {
      return [];
    }
    const index = await this.loadIndex();
    const rows: Array<{ entry: MemoryIndexEntry; content: string }> = [];
    for (const entry of index.slice(0, safeLimit)) {
      const detail = await this.getDetail(entry.id);
      if (!detail?.content) {
        continue;
      }
      rows.push({ entry, content: detail.content });
    }
    return rows;
  }

  async forgetById(id: string): Promise<boolean> {
    const cleanedId = id.trim();
    if (!cleanedId) {
      return false;
    }

    return this.enqueueWrite(async () => {
      const index = await this.loadIndex();
      const found = index.find((item) => item.id === cleanedId);
      if (!found) {
        return false;
      }

      const nextIndex = index.filter((item) => item.id !== cleanedId);
      await this.persistIndex(nextIndex);

      const dir = this.getMemoryDir(cleanedId);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      this.detailCache.delete(cleanedId);
      return true;
    });
  }

  async forgetByUri(uri: string): Promise<boolean> {
    const id = parseMemoryIdFromUri(uri, this.targetUri);
    if (!id) {
      return false;
    }
    return this.forgetById(id);
  }

  async totalCount(): Promise<number> {
    const index = await this.loadIndex();
    return index.length;
  }

  async getRevision(): Promise<string> {
    const index = await this.loadIndex();
    if (index.length === 0) {
      return "0";
    }
    const latest = index[0]?.updatedAt ?? "";
    return `${index.length}:${latest}`;
  }

  async stats(): Promise<Record<string, unknown>> {
    const index = await this.loadIndex();
    const byCategory = new Map<MemoryCategory, number>();
    for (const item of index) {
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
    }

    let diskBytes = 0;
    for (const item of index.slice(0, 2000)) {
      const dir = this.getMemoryDir(item.id);
      const file = join(dir, CONTENT_FILE);
      const s = await stat(file).catch(() => null);
      if (s?.isFile()) {
        diskBytes += s.size;
      }
    }

    return {
      rootDir: this.rootDir,
      total: index.length,
      byCategory: Object.fromEntries(byCategory.entries()),
      detailCacheSize: this.detailCache.size,
      sampledContentBytes: diskBytes,
    };
  }
}
