#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SETUP_HELPER_PATH = join(ROOT_DIR, "setup-helper", "cli.js");
const STACK_DIR = join(ROOT_DIR, "deploy", "local-stack");
const STACK_ENV_EXAMPLE_PATH = join(STACK_DIR, ".env.example");
const STACK_ENV_PATH = join(STACK_DIR, ".env");
const OPENCLAW_CONFIG_PATH = resolve(homedir(), ".openclaw", "openclaw.json");
const DEFAULT_PLUGIN_ENV_CONFIG_PATH = resolve(homedir(), ".viking-memory", "plugin.env.json");
const DEFAULT_ROOT_DIR = resolve(homedir(), ".viking-memory");
const DEFAULT_WORKSPACE_DIR = resolve(homedir(), ".openclaw", "workspace");
const DEFAULT_TARGET_URI = "viking://user/memories";
const DEFAULT_CHUNK_CHARS = 1200;
const PLUGIN_ID = "memory-viking-local";
const LOCAL_BIN_DIR = resolve(homedir(), ".local", "bin");
const GLOBAL_WRAPPER_PATH = join(LOCAL_BIN_DIR, "vk-memory");
const GLOBAL_WRAPPER_CMD_PATH = join(LOCAL_BIN_DIR, "vk-memory.cmd");
const LEGACY_GLOBAL_WRAPPER_PATH = join(homedir(), "bin", "vk-memory");

const STACK_DEFAULTS = {
  MEM0_LLM_API_KEY: "",
  MEM0_LLM_BASE_URL: "https://api.openai.com/v1",
  MEM0_LLM_MODEL: "gpt-4.1-nano-2025-04-14",
  MEM0_LLM_TEMPERATURE: "0.2",
  MEM0_URL: "http://mem0:8000",
  HOST_MEM0_PORT: "18888",
  HOST_QDRANT_PORT: "16333",
  HOST_EMBEDDING_PORT: "17997",
  HOST_RERANK_PORT: "17998",
};

function resolveUserPath(rawPath) {
  return resolve(String(rawPath).replace(/^~(?=$|\/|\\)/, homedir()));
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureInsideVikingBase(candidatePath, label) {
  const rel = relative(DEFAULT_ROOT_DIR, candidatePath);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new Error(`${label} must be inside ${DEFAULT_ROOT_DIR}`);
  }
}

function getOptionValue(args, key, fallback = undefined) {
  const prefix = `${key}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value || fallback;
    }
  }
  return fallback;
}

function hasOption(args, key) {
  return args.includes(key);
}

function toSafeInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeText(text) {
  return normalizeSpaces(String(text ?? "").replace(/\u0000/g, " "));
}

function normalizeForDedupe(text) {
  return sanitizeText(text).toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((line) => normalizeSpaces(line))
    .filter(Boolean);
}

function buildAbstract(text) {
  const sentences = splitSentences(text);
  if (sentences.length > 0) {
    return truncate(sentences[0], /[\u3400-\u9fff]/.test(sentences[0]) ? 90 : 160);
  }
  return truncate(normalizeSpaces(text), /[\u3400-\u9fff]/.test(text) ? 90 : 160);
}

function inferCategory(text) {
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

function inferImportance(text, category) {
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
  return Math.max(0, Math.min(1, score));
}

function extractKeywords(text) {
  const tokens = new Set();
  for (const match of String(text).toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,31}/gu)) {
    const token = String(match[0] ?? "").trim();
    if (!token) {
      continue;
    }
    tokens.add(token);
    if (tokens.size >= 24) {
      break;
    }
  }
  return [...tokens];
}

function buildOverview(text, category, abstract, sourceLabel) {
  const lines = splitSentences(text)
    .slice(0, 2)
    .map((line) => `- ${truncate(line, 240)}`);
  if (lines.length === 0) {
    lines.push(`- ${abstract}`);
  }
  return [`Category: ${category}`, `Source: ${sourceLabel}`, ...lines].join("\n");
}

function buildMemoryId() {
  const t = Date.now().toString(36);
  const r = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${t}-${r}`;
}

function contentHash(text) {
  return createHash("sha1").update(text).digest("hex");
}

function renderMemoryMeta(entry, extraMeta = {}) {
  return {
    id: entry.id,
    uri: entry.uri,
    category: entry.category,
    keywords: entry.keywords,
    importance: entry.importance,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    sourceRole: "system",
    metadata: {
      migrated: true,
      ...extraMeta,
    },
  };
}

function splitByMaxChars(text, maxChars) {
  const safe = sanitizeText(text);
  if (!safe) {
    return [];
  }
  if (safe.length <= maxChars) {
    return [safe];
  }
  const parts = [];
  let offset = 0;
  while (offset < safe.length) {
    parts.push(safe.slice(offset, offset + maxChars));
    offset += maxChars;
  }
  return parts;
}

function chunkMarkdown(text, maxChars) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) {
    return [];
  }

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((p) => sanitizeText(p))
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks = [];
  let current = "";

  const pushPart = (part) => {
    if (!part) {
      return;
    }
    if (!current) {
      current = part;
      return;
    }
    if (current.length + 2 + part.length <= maxChars) {
      current = `${current}\n\n${part}`;
      return;
    }
    chunks.push(current);
    current = part;
  };

  for (const paragraph of paragraphs) {
    const pieces = splitByMaxChars(paragraph, maxChars);
    for (const piece of pieces) {
      pushPart(piece);
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function readJsonFile(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed === "undefined") {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, body, "utf-8");
}

async function resolveRootDirFromPluginConfig() {
  const cfg = await readJsonFile(DEFAULT_PLUGIN_ENV_CONFIG_PATH, null);
  if (!cfg || typeof cfg !== "object") {
    return DEFAULT_ROOT_DIR;
  }
  if (typeof cfg.rootDir === "string" && cfg.rootDir.trim()) {
    const resolved = resolveUserPath(cfg.rootDir.trim());
    ensureInsideVikingBase(resolved, "rootDir");
    return resolved;
  }
  return DEFAULT_ROOT_DIR;
}

async function listMarkdownFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function asMemoryContentRecord(filePath, text, chunkChars, workspaceDir) {
  const chunks = chunkMarkdown(text, chunkChars);
  if (chunks.length === 0) {
    return [];
  }
  const sourceLabel = filePath.startsWith(workspaceDir)
    ? filePath.slice(workspaceDir.length + 1).replace(/\\/g, "/")
    : filePath;

  return chunks.map((chunk, index) => ({
    sourceFile: filePath,
    sourceLabel,
    chunk,
    chunkIndex: index + 1,
    chunkTotal: chunks.length,
  }));
}

async function collectOpenClawMemoryInputs(workspaceDir, chunkChars) {
  const records = [];
  const rootMemoryPath = join(workspaceDir, "MEMORY.md");
  const memoryDir = join(workspaceDir, "memory");

  if (existsSync(rootMemoryPath)) {
    const body = await readFile(rootMemoryPath, "utf-8").catch(() => "");
    records.push(...asMemoryContentRecord(rootMemoryPath, body, chunkChars, workspaceDir));
  }

  if (existsSync(memoryDir)) {
    const memoryFiles = await listMarkdownFiles(memoryDir);
    for (const filePath of memoryFiles) {
      const body = await readFile(filePath, "utf-8").catch(() => "");
      records.push(...asMemoryContentRecord(filePath, body, chunkChars, workspaceDir));
    }
  }

  return records;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: vk-memory <command> [options]",
      "",
      "Commands:",
      "  setup            Initialize plugin config and local-stack .env",
      "  config           Update existing config and local-stack .env",
      "  start            Start local memory stack (docker compose up -d)",
      "  stop             Stop local memory stack (docker compose down)",
      "  status           Show local memory stack status (docker compose ps)",
      "  migrate          Import existing OpenClaw local file memory",
      "  uninstall        Remove memory-viking-local config, extension files, and global vk-memory command",
      "  help             Show this help",
      "",
      "Options:",
      "  --yes            Non-interactive defaults (for setup/config)",
      "  --basic          Basic mode for plugin config setup",
      "  --advanced       Advanced mode for plugin config setup",
      "  --config=<path>  Custom plugin env JSON path (for setup/config)",
      "  --workspace=<p>  OpenClaw workspace path (for migrate)",
      "  --root=<path>    Viking memory root dir (for migrate)",
      "  --chunk-chars=n  Max chars per migrated chunk (for migrate)",
      "  --openclaw-config=<path>  Custom OpenClaw config JSON path (for uninstall)",
      "  --dry-run        Show result without writing files (migrate/uninstall)",
      "",
      "Examples:",
      "  vk-memory setup",
      "  vk-memory config --advanced",
      "  vk-memory start",
      "  vk-memory stop",
      "  vk-memory migrate",
      "  vk-memory migrate --workspace=~/.openclaw/workspace --dry-run",
      "  vk-memory uninstall",
      "  vk-memory uninstall --dry-run",
    ].join("\n") + "\n",
  );
}

function hasDockerCompose() {
  const result = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function parseDotEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    out[key] = value;
  }
  return out;
}

function renderDotEnv(values) {
  const lines = [
    "# Mem0 OSS summarization driver (OpenAI-compatible).",
    "# Set to any compatible vendor endpoint/key/model.",
    `MEM0_LLM_API_KEY=${values.MEM0_LLM_API_KEY ?? ""}`,
    `MEM0_LLM_BASE_URL=${values.MEM0_LLM_BASE_URL ?? STACK_DEFAULTS.MEM0_LLM_BASE_URL}`,
    `MEM0_LLM_MODEL=${values.MEM0_LLM_MODEL ?? STACK_DEFAULTS.MEM0_LLM_MODEL}`,
    `MEM0_LLM_TEMPERATURE=${values.MEM0_LLM_TEMPERATURE ?? STACK_DEFAULTS.MEM0_LLM_TEMPERATURE}`,
    "",
    "# Internal Mem0 URL used by mem0-configurator.",
    `MEM0_URL=${values.MEM0_URL ?? STACK_DEFAULTS.MEM0_URL}`,
    "",
    "# Optional host port overrides (change only if conflicts exist)",
    `HOST_MEM0_PORT=${values.HOST_MEM0_PORT ?? STACK_DEFAULTS.HOST_MEM0_PORT}`,
    `HOST_QDRANT_PORT=${values.HOST_QDRANT_PORT ?? STACK_DEFAULTS.HOST_QDRANT_PORT}`,
    `HOST_EMBEDDING_PORT=${values.HOST_EMBEDDING_PORT ?? STACK_DEFAULTS.HOST_EMBEDDING_PORT}`,
    `HOST_RERANK_PORT=${values.HOST_RERANK_PORT ?? STACK_DEFAULTS.HOST_RERANK_PORT}`,
    "",
  ];
  return lines.join("\n");
}

async function readStackEnv() {
  if (!existsSync(STACK_ENV_PATH)) {
    return {};
  }
  const raw = await readFile(STACK_ENV_PATH, "utf-8");
  return parseDotEnv(raw);
}

async function writeStackEnv(values) {
  await mkdir(dirname(STACK_ENV_PATH), { recursive: true });
  await writeFile(STACK_ENV_PATH, renderDotEnv(values), "utf-8");
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${String(code ?? -1)}`));
    });
  });
}

async function askLine(rl, label, fallback) {
  const answer = await rl.question(`${label} [${fallback}]: `);
  const trimmed = answer.trim();
  return trimmed || fallback;
}

async function ensureStackEnv(args) {
  const yesMode = args.includes("--yes") || args.includes("-y");

  if (!existsSync(STACK_ENV_EXAMPLE_PATH)) {
    throw new Error(`Stack env template not found: ${STACK_ENV_EXAMPLE_PATH}`);
  }

  const existing = await readStackEnv();
  const values = {
    ...STACK_DEFAULTS,
    ...existing,
  };

  if (!existsSync(STACK_ENV_PATH)) {
    await copyFile(STACK_ENV_EXAMPLE_PATH, STACK_ENV_PATH);
  }

  if (yesMode) {
    if (!values.MEM0_LLM_API_KEY && process.env.MEM0_LLM_API_KEY) {
      values.MEM0_LLM_API_KEY = process.env.MEM0_LLM_API_KEY;
    }
    await writeStackEnv(values);
    if (!values.MEM0_LLM_API_KEY) {
      process.stdout.write(
        `[WARN] ${STACK_ENV_PATH} created, but MEM0_LLM_API_KEY is empty. Set it before running vk-memory start.\n`,
      );
    }
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive stack env setup requires TTY. Use --yes for non-interactive mode.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nConfigure Mem0 LLM and local ports\n");
    values.MEM0_LLM_API_KEY = await askLine(rl, "MEM0_LLM_API_KEY", values.MEM0_LLM_API_KEY);
    values.MEM0_LLM_BASE_URL = await askLine(rl, "MEM0_LLM_BASE_URL", values.MEM0_LLM_BASE_URL);
    values.MEM0_LLM_MODEL = await askLine(rl, "MEM0_LLM_MODEL", values.MEM0_LLM_MODEL);
    values.MEM0_LLM_TEMPERATURE = await askLine(rl, "MEM0_LLM_TEMPERATURE", values.MEM0_LLM_TEMPERATURE);
    values.HOST_MEM0_PORT = await askLine(rl, "HOST_MEM0_PORT", values.HOST_MEM0_PORT);
    values.HOST_QDRANT_PORT = await askLine(rl, "HOST_QDRANT_PORT", values.HOST_QDRANT_PORT);
    values.HOST_EMBEDDING_PORT = await askLine(rl, "HOST_EMBEDDING_PORT", values.HOST_EMBEDDING_PORT);
    values.HOST_RERANK_PORT = await askLine(rl, "HOST_RERANK_PORT", values.HOST_RERANK_PORT);
  } finally {
    rl.close();
  }

  if (!values.MEM0_LLM_API_KEY.trim()) {
    throw new Error("MEM0_LLM_API_KEY cannot be empty.");
  }

  await writeStackEnv(values);
  process.stdout.write(`[OK] Updated ${STACK_ENV_PATH}\n`);
}

function buildSetupHelperArgs(args) {
  const out = [SETUP_HELPER_PATH];
  for (const arg of args) {
    if (
      arg === "--yes" ||
      arg === "-y" ||
      arg === "--basic" ||
      arg === "--advanced" ||
      arg.startsWith("--mode=") ||
      arg.startsWith("--config=")
    ) {
      out.push(arg);
    }
  }
  return out;
}

async function setupPluginConfig(args) {
  await runCommand("node", buildSetupHelperArgs(args), { cwd: ROOT_DIR });
}

async function cmdSetup(args) {
  await setupPluginConfig(args);
  await ensureStackEnv(args);
  process.stdout.write("[OK] vk-memory setup completed.\n");
}

async function cmdConfig(args) {
  const setupArgs = args.includes("--advanced") || args.includes("--basic") ? args : [...args, "--advanced"];
  await setupPluginConfig(setupArgs);
  await ensureStackEnv(args);
  process.stdout.write("[OK] vk-memory config completed.\n");
}

async function ensureReadyForStart() {
  if (!hasDockerCompose()) {
    throw new Error("docker compose is required. Install Docker Desktop / Docker Compose first.");
  }
  if (!existsSync(STACK_ENV_PATH)) {
    throw new Error(`Stack env file not found: ${STACK_ENV_PATH}. Run: vk-memory setup`);
  }
  const env = await readStackEnv();
  if (!env.MEM0_LLM_API_KEY || !env.MEM0_LLM_API_KEY.trim()) {
    throw new Error(`MEM0_LLM_API_KEY is empty in ${STACK_ENV_PATH}. Run: vk-memory config`);
  }
}

async function cmdStart() {
  await ensureReadyForStart();
  await runCommand("docker", ["compose", "--env-file", ".env", "up", "-d"], { cwd: STACK_DIR });
  process.stdout.write("[OK] local memory stack started.\n");
}

async function cmdStop() {
  if (!hasDockerCompose()) {
    throw new Error("docker compose is required.");
  }
  await runCommand("docker", ["compose", "--env-file", ".env", "down"], { cwd: STACK_DIR });
  process.stdout.write("[OK] local memory stack stopped.\n");
}

async function cmdStatus() {
  if (!hasDockerCompose()) {
    throw new Error("docker compose is required.");
  }
  await runCommand("docker", ["compose", "--env-file", ".env", "ps"], { cwd: STACK_DIR });
}

async function cmdMigrate(args) {
  const workspaceRaw = getOptionValue(args, "--workspace", DEFAULT_WORKSPACE_DIR);
  const rootRaw = getOptionValue(args, "--root", "");
  const chunkCharsRaw = getOptionValue(args, "--chunk-chars", String(DEFAULT_CHUNK_CHARS));
  const dryRun = hasOption(args, "--dry-run");

  const workspaceDir = resolveUserPath(workspaceRaw);
  if (!existsSync(workspaceDir)) {
    throw new Error(`OpenClaw workspace not found: ${workspaceDir}`);
  }

  const rootDir = rootRaw ? resolveUserPath(rootRaw) : await resolveRootDirFromPluginConfig();
  ensureInsideVikingBase(rootDir, "migrate root");
  const chunkChars = toSafeInt(chunkCharsRaw, DEFAULT_CHUNK_CHARS, 200, 8000);

  const memoryDir = join(rootDir, "memories");
  const indexPath = join(rootDir, "index", "catalog.json");

  const records = await collectOpenClawMemoryInputs(workspaceDir, chunkChars);
  if (records.length === 0) {
    process.stdout.write(`[WARN] No local OpenClaw memory files found in ${workspaceDir}\n`);
    process.stdout.write("Expected files: MEMORY.md and/or memory/*.md\n");
    return;
  }

  const existingIndexRaw = await readJsonFile(indexPath, []);
  const existingIndex = Array.isArray(existingIndexRaw) ? existingIndexRaw : [];
  const existingHashes = new Set(
    existingIndex
      .map((item) => (item && typeof item === "object" ? String(item.sourceHash ?? "") : ""))
      .filter(Boolean),
  );

  const newEntries = [];
  const writeJobs = [];
  let duplicates = 0;

  for (const record of records) {
    const cleaned = sanitizeText(record.chunk);
    if (!cleaned) {
      continue;
    }
    const normalized = normalizeForDedupe(cleaned);
    if (!normalized) {
      continue;
    }
    const sourceHash = contentHash(normalized);
    if (existingHashes.has(sourceHash)) {
      duplicates += 1;
      continue;
    }
    existingHashes.add(sourceHash);

    const createdAt = new Date().toISOString();
    const category = inferCategory(cleaned);
    const abstract = buildAbstract(cleaned);
    const overview = buildOverview(cleaned, category, abstract, record.sourceLabel);
    const importance = inferImportance(cleaned, category);
    const keywords = extractKeywords(`${abstract}\n${cleaned}`);
    const id = buildMemoryId();
    const uri = `${DEFAULT_TARGET_URI}/${id}`;

    const entry = {
      id,
      uri,
      category,
      abstract,
      overview,
      keywords,
      importance,
      sourceHash,
      createdAt,
      updatedAt: createdAt,
    };
    newEntries.push(entry);

    const itemDir = join(memoryDir, id);
    const meta = renderMemoryMeta(entry, {
      migratedFrom: "openclaw-workspace",
      sourceFile: record.sourceLabel,
      chunkIndex: record.chunkIndex,
      chunkTotal: record.chunkTotal,
    });

    writeJobs.push({
      itemDir,
      abstract,
      overview,
      content: cleaned,
      meta,
    });
  }

  process.stdout.write(`Workspace: ${workspaceDir}\n`);
  process.stdout.write(`Target root: ${rootDir}\n`);
  process.stdout.write(`Source chunks: ${records.length}\n`);
  process.stdout.write(`New memories: ${newEntries.length}\n`);
  process.stdout.write(`Duplicates skipped: ${duplicates}\n`);
  process.stdout.write(`Chunk chars: ${chunkChars}\n`);

  if (dryRun) {
    process.stdout.write("[OK] Dry run complete, no files were written.\n");
    return;
  }

  await mkdir(join(rootDir, "index"), { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  for (const job of writeJobs) {
    await mkdir(job.itemDir, { recursive: true });
    await Promise.all([
      writeFile(join(job.itemDir, ".abstract.md"), `${job.abstract}\n`, "utf-8"),
      writeFile(join(job.itemDir, ".overview.md"), `${job.overview}\n`, "utf-8"),
      writeFile(join(job.itemDir, "content.md"), `${job.content}\n`, "utf-8"),
      writeJsonFile(join(job.itemDir, "meta.json"), job.meta),
    ]);
  }

  const mergedIndex = [...newEntries, ...existingIndex];
  mergedIndex.sort((a, b) => {
    const aTime = Date.parse(String(a.updatedAt ?? ""));
    const bTime = Date.parse(String(b.updatedAt ?? ""));
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });

  await writeJsonFile(indexPath, mergedIndex);

  process.stdout.write(`[OK] Migration completed. Imported ${newEntries.length} memories.\n`);
  process.stdout.write(
    "Only local OpenClaw file memory was imported (MEMORY.md + memory/*.md). context-store is not supported.\n",
  );
}

async function cmdUninstall(args) {
  const openclawConfigRaw = getOptionValue(args, "--openclaw-config", OPENCLAW_CONFIG_PATH);
  const configPath = resolveUserPath(openclawConfigRaw);
  const openclawDir = dirname(configPath);
  const extensionDirPath = join(openclawDir, "extensions", PLUGIN_ID);
  const dryRun = hasOption(args, "--dry-run");
  const wrapperCandidates = [GLOBAL_WRAPPER_PATH, GLOBAL_WRAPPER_CMD_PATH, LEGACY_GLOBAL_WRAPPER_PATH];
  const wrappersToRemove = wrapperCandidates.filter((path) => existsSync(path));
  const extensionDirExists = existsSync(extensionDirPath);

  let configFound = false;
  let root = null;
  let removedSlot = false;
  let removedEntry = false;
  let removedInstall = false;

  if (existsSync(configPath)) {
    configFound = true;
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isObjectRecord(parsed)) {
      throw new Error(`Invalid OpenClaw config JSON object: ${configPath}`);
    }

    root = parsed;
    const plugins = isObjectRecord(root.plugins) ? root.plugins : null;
    if (plugins) {
      const slots = isObjectRecord(plugins.slots) ? plugins.slots : null;
      const entries = isObjectRecord(plugins.entries) ? plugins.entries : null;
      const installs = isObjectRecord(plugins.installs) ? plugins.installs : null;

      if (slots && slots.memory === PLUGIN_ID) {
        delete slots.memory;
        removedSlot = true;
        if (Object.keys(slots).length === 0) {
          delete plugins.slots;
        }
      }

      if (entries && Object.prototype.hasOwnProperty.call(entries, PLUGIN_ID)) {
        delete entries[PLUGIN_ID];
        removedEntry = true;
        if (Object.keys(entries).length === 0) {
          delete plugins.entries;
        }
      }

      if (installs && Object.prototype.hasOwnProperty.call(installs, PLUGIN_ID)) {
        delete installs[PLUGIN_ID];
        removedInstall = true;
        if (Object.keys(installs).length === 0) {
          delete plugins.installs;
        }
      }
    }
  }

  process.stdout.write(`OpenClaw config: ${configPath}\n`);
  process.stdout.write(`Config file exists: ${configFound ? "yes" : "no"}\n`);
  process.stdout.write(`Remove plugins.slots.memory: ${removedSlot ? "yes" : "no"}\n`);
  process.stdout.write(`Remove plugins.entries.${PLUGIN_ID}: ${removedEntry ? "yes" : "no"}\n`);
  process.stdout.write(`Remove plugins.installs.${PLUGIN_ID}: ${removedInstall ? "yes" : "no"}\n`);
  process.stdout.write(`Remove extension directory: ${extensionDirExists ? "yes" : "no"}\n`);
  if (extensionDirExists) {
    process.stdout.write(`  - ${extensionDirPath}\n`);
  }
  process.stdout.write(`Remove global vk-memory command files: ${wrappersToRemove.length}\n`);
  for (const path of wrappersToRemove) {
    process.stdout.write(`  - ${path}\n`);
  }

  if (!configFound && !extensionDirExists && wrappersToRemove.length === 0) {
    process.stdout.write("[WARN] Nothing to uninstall.\n");
    return;
  }

  if (dryRun) {
    process.stdout.write("[OK] Dry run complete, no files were changed.\n");
    return;
  }

  if (configFound && root && (removedSlot || removedEntry || removedInstall)) {
    await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
    process.stdout.write("[OK] Removed memory-viking-local from OpenClaw config.\n");
  } else if (configFound) {
    process.stdout.write("[INFO] No memory-viking-local entries found in OpenClaw config.\n");
  }

  if (extensionDirExists) {
    await rm(extensionDirPath, { recursive: true, force: true });
    process.stdout.write("[OK] Removed memory-viking-local extension directory.\n");
  } else {
    process.stdout.write("[INFO] No memory-viking-local extension directory found.\n");
  }

  for (const path of wrappersToRemove) {
    await rm(path, { force: true });
  }
  if (wrappersToRemove.length > 0) {
    process.stdout.write("[OK] Removed global vk-memory command file(s).\n");
  } else {
    process.stdout.write("[INFO] No global vk-memory command file found.\n");
  }

  process.stdout.write("[OK] Local memory data under ~/.viking-memory was preserved.\n");
  process.stdout.write("[INFO] Restart OpenClaw manually to apply: openclaw gateway\n");
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }
  if (command === "setup") {
    await cmdSetup(args);
    return;
  }
  if (command === "config") {
    await cmdConfig(args);
    return;
  }
  if (command === "start") {
    await cmdStart();
    return;
  }
  if (command === "stop") {
    await cmdStop();
    return;
  }
  if (command === "status") {
    await cmdStatus();
    return;
  }
  if (command === "migrate") {
    await cmdMigrate(args);
    return;
  }
  if (command === "uninstall") {
    await cmdUninstall(args);
    return;
  }

  printHelp();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`[ERROR] ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
