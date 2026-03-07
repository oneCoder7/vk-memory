import { createHash, randomUUID } from "node:crypto";
import { access, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { MemoryCategory, MemoryMatch, TimelineMatch } from "./types.js";

const MEMORY_BLOCK_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi;
const CJK_RE = /[\u3400-\u9fff]/;
const LATIN_TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu;
const CJK_BLOCK_RE = /[\u3400-\u9fff]{2,}/g;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function sanitizeTextForMemory(text: string): string {
  return normalizeSpaces(text.replace(MEMORY_BLOCK_RE, " ").replace(/\u0000/g, " "));
}

export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens = new Set<string>();

  for (const match of lowered.matchAll(LATIN_TOKEN_RE)) {
    const token = (match[0] ?? "").trim();
    if (token.length < 2) {
      continue;
    }
    tokens.add(token);
    if (tokens.size >= 256) {
      break;
    }
  }

  const cjkBlocks = lowered.match(CJK_BLOCK_RE) ?? [];
  for (const block of cjkBlocks.slice(0, 64)) {
    if (block.length <= 4) {
      tokens.add(block);
      continue;
    }
    for (let i = 0; i < block.length - 1 && i < 64; i += 1) {
      tokens.add(block.slice(i, i + 2));
    }
  }

  return [...tokens];
}

export function extractKeywords(text: string): string[] {
  return tokenize(text).slice(0, 24);
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
}

export function buildAbstract(text: string): string {
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    return truncate(sentences[0]!, CJK_RE.test(sentences[0]!) ? 90 : 160);
  }
  return truncate(normalizeSpaces(text), CJK_RE.test(text) ? 90 : 160);
}

export function buildOverview(text: string, category: MemoryCategory, abstract: string): string {
  const snippets = splitSentences(text).slice(0, 3);
  if (snippets.length === 0) {
    return abstract;
  }
  const lines = snippets.map((line) => `- ${truncate(line, 260)}`);
  return [`Category: ${category}`, ...lines].join("\n");
}

export function inferCategory(text: string): MemoryCategory {
  const normalized = text.toLowerCase();
  if (/prefer|preference|favorite|favourite|like|dislike|偏好|喜欢|讨厌|习惯/.test(normalized)) {
    return "preference";
  }
  if (/my name|i am|i'm|联系方式|电话|邮箱|生日|住在|来自|name is|我叫|我是|住在/.test(normalized)) {
    return "profile";
  }
  if (/today|yesterday|tomorrow|last|next|日期|时间|今天|昨天|明天|上周|下周/.test(normalized)) {
    return "event";
  }
  if (/todo|task|plan|need to|需要|待办|计划|安排/.test(normalized)) {
    return "task";
  }
  return "fact";
}

export function inferImportance(text: string, category: MemoryCategory): number {
  let score = 0.35;
  if (category === "preference" || category === "profile") {
    score += 0.22;
  }
  if (/important|must|always|never|优先|务必|一定|总是|永远/.test(text.toLowerCase())) {
    score += 0.2;
  }
  if (text.length > 400) {
    score += 0.08;
  }
  return clamp01(score);
}

export function buildMemoryId(): string {
  const t = Date.now().toString(36);
  const r = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${t}-${r}`;
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  await writeTextAtomic(path, `${body}\n`);
}

export function parseMemoryIdFromUri(uri: string, targetUri: string): string | null {
  const normalizedTarget = targetUri.replace(/\/+$/, "");
  if (uri.startsWith(`${normalizedTarget}/`)) {
    return uri.slice(normalizedTarget.length + 1).trim() || null;
  }
  const match = uri.match(/^viking:\/\/user\/memories\/([^/?#]+)$/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

export function formatMemoryLines(memories: MemoryMatch[]): string {
  return memories
    .map((item, index) => {
      const scoreText = `${Math.round(item.score * 100)}%`;
      return `${index + 1}. [${item.category}] ${item.abstract} (${scoreText})\n   uri: ${item.uri}`;
    })
    .join("\n");
}

export function formatTimelineLines(chunks: TimelineMatch[]): string {
  return chunks
    .map((item, index) => {
      const scoreText = `${Math.round(item.score * 100)}%`;
      return `${index + 1}. [${item.role}] ${item.abstract} (${scoreText})\n   session: ${item.sessionId}\n   uri: ${item.uri}`;
    })
    .join("\n");
}

export function truncateForDetail(text: string, maxChars: number): string {
  return truncate(normalizeSpaces(text), maxChars);
}

function extractTextsFromUserMessages(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") {
      continue;
    }
    const content = msgObj.content;
    if (typeof content === "string") {
      const normalized = sanitizeTextForMemory(content);
      if (normalized) {
        texts.push(normalized);
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const blockObj = block as Record<string, unknown>;
      if (blockObj.type === "text" && typeof blockObj.text === "string") {
        const normalized = sanitizeTextForMemory(blockObj.text);
        if (normalized) {
          texts.push(normalized);
        }
      }
    }
  }
  return texts;
}

export function extractLatestUserText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) {
    return "";
  }
  const texts = extractTextsFromUserMessages(messages);
  if (texts.length === 0) {
    return "";
  }
  return sanitizeTextForMemory(texts[texts.length - 1] ?? "");
}

function sanitizeRole(rawRole: unknown): string {
  if (typeof rawRole !== "string") {
    return "unknown";
  }
  const role = rawRole.trim().toLowerCase();
  if (!role) {
    return "unknown";
  }
  return role;
}

function extractTextBlocksFromContent(content: unknown): string[] {
  if (typeof content === "string") {
    const cleaned = sanitizeTextForMemory(content);
    return cleaned ? [cleaned] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const obj = block as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      const cleaned = sanitizeTextForMemory(obj.text);
      if (cleaned) {
        blocks.push(cleaned);
      }
      continue;
    }
    if (obj.type === "input_text" && typeof obj.text === "string") {
      const cleaned = sanitizeTextForMemory(obj.text);
      if (cleaned) {
        blocks.push(cleaned);
      }
      continue;
    }
  }
  return blocks;
}

export function extractTimelineMessages(messages: unknown[]): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  const allowedRoles = new Set(["user", "assistant"]);

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const obj = msg as Record<string, unknown>;
    const role = sanitizeRole(obj.role);
    if (!allowedRoles.has(role)) {
      continue;
    }
    const textBlocks = extractTextBlocksFromContent(obj.content);

    for (const text of textBlocks) {
      if (!text) {
        continue;
      }
      out.push({ role, text });
    }
  }

  return out;
}

export function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "default";
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (safe.length > 0 && safe.length <= 72) {
    return safe;
  }
  return `s-${contentHash(trimmed).slice(0, 18)}`;
}

export function resolveSessionIdFromEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "default";
  }
  const ev = event as Record<string, unknown>;
  const directCandidates = [
    ev.sessionId,
    ev.session_id,
    ev.conversationId,
    ev.conversation_id,
    ev.threadId,
    ev.thread_id,
    ev.chatId,
    ev.chat_id,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeSessionId(candidate);
    }
  }

  const nestedCandidates: unknown[] = [];
  if (ev.session && typeof ev.session === "object") {
    nestedCandidates.push((ev.session as Record<string, unknown>).id);
    nestedCandidates.push((ev.session as Record<string, unknown>).sessionId);
  }
  if (ev.metadata && typeof ev.metadata === "object") {
    nestedCandidates.push((ev.metadata as Record<string, unknown>).sessionId);
    nestedCandidates.push((ev.metadata as Record<string, unknown>).conversationId);
  }

  for (const candidate of nestedCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeSessionId(candidate);
    }
  }

  return "default";
}

export function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Continue to best-effort extraction.
  }

  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore and continue.
    }
  }

  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(normalized.slice(firstBrace, lastBrace + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeExtractedCategory(raw: unknown): MemoryCategory {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "preference") {
    return "preference";
  }
  if (value === "profile") {
    return "profile";
  }
  if (value === "event") {
    return "event";
  }
  if (value === "task" || value === "rule") {
    return "task";
  }
  return "fact";
}
