import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { MemoryLocalVikingConfig } from "../config.js";
import type { ExtractedMemoryCandidate, TimelineTurn } from "../core/types.js";
import {
  buildAbstract,
  buildOverview,
  inferCategory,
  inferImportance,
  normalizeForDedupe,
  safeJsonParse,
  sanitizeTextForMemory,
  truncate,
} from "../core/utils.js";

const MEM0_MAX_TURNS_PER_CALL = 30;
const MEM0_MAX_MSG_CHARS = 2_000;
const MEM0_MAX_RESULTS_PER_CALL = 40;

type Mem0ResultRow = Record<string, unknown>;

export class Mem0ExtractorClient {
  private warnedUnavailable = false;

  constructor(
    private readonly cfg: Required<MemoryLocalVikingConfig>,
    private readonly logger: OpenClawPluginApi["logger"],
  ) {}

  private normalizeRole(role: string): "user" | "assistant" {
    const lowered = role.trim().toLowerCase();
    if (lowered === "user") {
      return "user";
    }
    return "assistant";
  }

  private normalizeRows(payload: unknown): Mem0ResultRow[] {
    if (Array.isArray(payload)) {
      return payload.filter((item) => item && typeof item === "object") as Mem0ResultRow[];
    }
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.results)) {
      return obj.results.filter((item) => item && typeof item === "object") as Mem0ResultRow[];
    }
    return [];
  }

  private buildTroubleshootingHint(errorText: string): string {
    const normalized = errorText.toLowerCase();
    if (normalized.includes("/chat/completions") || normalized.includes("url.not_found")) {
      return "check MEM0_LLM_BASE_URL and MEM0_LLM_MODEL (provider must support OpenAI /chat/completions).";
    }
    if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("invalid api key")) {
      return "check MEM0_LLM_API_KEY.";
    }
    if (normalized.includes("model") && normalized.includes("not found")) {
      return "check MEM0_LLM_MODEL is valid for your provider.";
    }
    return "";
  }

  private normalizeCandidates(rows: Mem0ResultRow[]): ExtractedMemoryCandidate[] {
    const out: ExtractedMemoryCandidate[] = [];
    const seen = new Set<string>();

    for (const row of rows.slice(0, MEM0_MAX_RESULTS_PER_CALL)) {
      const eventRaw = typeof row.event === "string" ? row.event.trim().toUpperCase() : "ADD";
      if (eventRaw === "DELETE" || eventRaw === "NOOP") {
        continue;
      }

      const memoryRaw =
        typeof row.memory === "string"
          ? row.memory
          : typeof row.content === "string"
            ? row.content
            : typeof row.text === "string"
              ? row.text
              : "";
      const memory = sanitizeTextForMemory(memoryRaw);
      if (!memory || memory.length < 6) {
        continue;
      }

      const dedupeKey = normalizeForDedupe(memory);
      if (!dedupeKey || seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const category = inferCategory(memory);
      const abstract = buildAbstract(memory);
      const overview = buildOverview(memory, category, abstract);
      const importance = inferImportance(memory, category);

      out.push({
        category,
        abstract,
        overview,
        content: memory,
        importance,
      });
    }

    return out;
  }

  async extract(turns: TimelineTurn[], sessionId: string): Promise<ExtractedMemoryCandidate[]> {
    if (turns.length === 0) {
      return [];
    }
    if (!this.cfg.mem0BaseUrl) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn("memory-viking-local: mem0BaseUrl is empty; Mem0 extraction skipped.");
      }
      return [];
    }

    const messages = turns
      .slice(-MEM0_MAX_TURNS_PER_CALL)
      .map((turn) => ({
        role: this.normalizeRole(turn.role),
        content: truncate(sanitizeTextForMemory(turn.text), MEM0_MAX_MSG_CHARS),
      }))
      .filter((item) => item.content);
    if (messages.length === 0) {
      return [];
    }

    const payload: Record<string, unknown> = {
      messages,
      user_id: this.cfg.mem0UserId,
      run_id: sessionId,
      metadata: {
        source: "openclaw-memory-viking-local",
      },
    };
    if (this.cfg.mem0AgentId) {
      payload.agent_id = this.cfg.mem0AgentId;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.mem0TimeoutMs);
    try {
      const response = await fetch(`${this.cfg.mem0BaseUrl}/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${truncate(bodyText, 180)}`);
      }

      const parsed = bodyText ? safeJsonParse<unknown>(bodyText, null) : null;
      const rows = this.normalizeRows(parsed);
      const candidates = this.normalizeCandidates(rows);
      if (candidates.length === 0) {
        this.logger.info?.(
          `memory-viking-local: Mem0 returned no durable memories (session=${sessionId}, rows=${rows.length})`,
        );
      }
      return candidates;
    } catch (err) {
      const raw = String(err);
      const hint = this.buildTroubleshootingHint(raw);
      this.logger.warn(
        `memory-viking-local: Mem0 extraction failed: ${raw}${hint ? ` (hint: ${hint})` : ""}`,
      );
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
