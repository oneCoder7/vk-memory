#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const VIKING_BASE = resolvePath(join(homedir(), ".viking-memory"));
const DEFAULT_CONFIG_PATH = resolvePath(join(VIKING_BASE, "plugin.env.json"));
const MODE_BASIC = "basic";
const MODE_ADVANCED = "advanced";
const SETUP_KEYS = [
  "rootDir",
  "debugLogs",
  "recallLimit",
  "recallScoreThreshold",
  "includeOverviewInInject",
  "timelineRecallLimit",
  "timelineScoreThreshold",
  "includeTimelineOverviewInInject",
  "detailOnRecallTool",
  "detailChars",
  "detailCacheSize",
  "mem0TimeoutMs",
  "semanticCandidateMultiplier",
  "semanticBlendWeight",
  "semanticTimeoutMs",
  "semanticBackfillLimit",
];

function toYesNo(value, fallback) {
  if (!value || !value.trim()) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["y", "yes", "1", "true", "on"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "0", "false", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toNumber(value, fallback, min, max) {
  if (!value || !value.trim()) {
    return fallback;
  }
  const n = Number(value.trim());
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function toFloat(value, fallback, min, max) {
  if (!value || !value.trim()) {
    return fallback;
  }
  const n = Number(value.trim());
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, n));
}

function ensureInsideBase(candidate, label) {
  const rel = relative(VIKING_BASE, candidate);
  const ok = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!ok) {
    throw new Error(`${label} must be inside ${VIKING_BASE}`);
  }
}

async function writeJson(path, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, payload, "utf-8");
}

async function readExisting(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ask(rl, question, fallback) {
  const suffix = typeof fallback === "undefined" ? "" : ` [${String(fallback)}]`;
  const answer = await rl.question(`${question}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed === "" ? fallback : trimmed;
}

function parseMode(value, fallback = MODE_BASIC) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === MODE_ADVANCED) {
    return MODE_ADVANCED;
  }
  if (normalized === MODE_BASIC) {
    return MODE_BASIC;
  }
  return fallback;
}

function parseArgs(argv) {
  const argSet = new Set(argv);
  const yesMode = argSet.has("-y") || argSet.has("--yes");
  const helpMode = argSet.has("-h") || argSet.has("--help");
  const freshMode = argSet.has("--fresh") || argSet.has("--reset-defaults");
  const configPathArg = argv.find((arg) => arg.startsWith("--config="));
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));

  let preferredMode = null;
  if (argSet.has("--advanced")) {
    preferredMode = MODE_ADVANCED;
  } else if (argSet.has("--basic")) {
    preferredMode = MODE_BASIC;
  } else if (modeArg) {
    preferredMode = parseMode(modeArg.slice("--mode=".length), MODE_BASIC);
  }

  return {
    yesMode,
    helpMode,
    freshMode,
    preferredMode,
    configPathRaw: configPathArg ? configPathArg.slice("--config=".length) : DEFAULT_CONFIG_PATH,
  };
}

function printHelp() {
  output.write("Usage: node ./setup-helper/cli.js [options]\n");
  output.write("\n");
  output.write("Options:\n");
  output.write("  -y, --yes            Non-interactive, write defaults\n");
  output.write("  --basic              Use basic interactive mode (fewer questions)\n");
  output.write("  --advanced           Use advanced interactive mode (all questions)\n");
  output.write("  --mode=basic|advanced\n");
  output.write("  --fresh              Ignore existing JSON and use built-in defaults as prompt seeds\n");
  output.write("  --config=<path>      Config JSON path (must be inside ~/.viking-memory)\n");
  output.write("  -h, --help           Show this message\n");
}

async function runInteractive(configPath, options) {
  const { yesMode, preferredMode, useExisting } = options;

  const defaults = {
    rootDir: "~/.viking-memory",
    debugLogs: false,
    recallLimit: 10,
    recallScoreThreshold: 0.18,
    includeOverviewInInject: true,
    timelineRecallLimit: 6,
    timelineScoreThreshold: 0.12,
    includeTimelineOverviewInInject: true,
    detailOnRecallTool: false,
    detailChars: 1200,
    detailCacheSize: 64,
    mem0TimeoutMs: 30000,
    semanticCandidateMultiplier: 6,
    semanticBlendWeight: 0.6,
    semanticTimeoutMs: 30000,
    semanticBackfillLimit: 400,
  };

  if (yesMode) {
    return defaults;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive setup requires a TTY. Use --yes for non-interactive mode.");
  }

  const existingFiltered = {};
  if (useExisting) {
    const existing = await readExisting(configPath);
    if (existing && typeof existing === "object") {
      for (const key of SETUP_KEYS) {
        if (Object.prototype.hasOwnProperty.call(existing, key)) {
          existingFiltered[key] = existing[key];
        }
      }
    }
  }
  const seed = { ...defaults, ...existingFiltered };

  const rl = createInterface({ input, output });
  try {
    output.write(`\nOpenClaw Memory Setup\n`);
    output.write(`Config file: ${configPath}\n`);
    output.write(`Choose setup mode: basic (fewer questions) / advanced (full options)\n`);
    output.write(`Press Enter to use default values.\n\n`);

    const selectedMode = preferredMode
      ? parseMode(preferredMode, MODE_BASIC)
      : parseMode(await ask(rl, "setupMode (basic/advanced)", MODE_BASIC), MODE_BASIC);

    output.write(`Setup mode: ${selectedMode}\n`);

    const rootDir = await ask(rl, "rootDir", seed.rootDir);
    const debugLogs = toYesNo(await ask(rl, "debugLogs (y/n)", seed.debugLogs ? "y" : "n"), seed.debugLogs);

    const recallLimit = toNumber(await ask(rl, "recallLimit", String(seed.recallLimit)), seed.recallLimit, 1, 20);
    const timelineRecallLimit = toNumber(
      await ask(rl, "timelineRecallLimit", String(seed.timelineRecallLimit)),
      seed.timelineRecallLimit,
      1,
      20,
    );

    if (selectedMode === MODE_BASIC) {
      return {
        ...seed,
        rootDir,
        debugLogs,
        recallLimit,
        timelineRecallLimit,
      };
    }

    const recallScoreThreshold = toFloat(
      await ask(rl, "recallScoreThreshold", String(seed.recallScoreThreshold)),
      seed.recallScoreThreshold,
      0,
      1,
    );
    const includeOverviewInInject = toYesNo(
      await ask(rl, "includeOverviewInInject (y/n)", seed.includeOverviewInInject ? "y" : "n"),
      seed.includeOverviewInInject,
    );

    const timelineScoreThreshold = toFloat(
      await ask(rl, "timelineScoreThreshold", String(seed.timelineScoreThreshold)),
      seed.timelineScoreThreshold,
      0,
      1,
    );
    const includeTimelineOverviewInInject = toYesNo(
      await ask(
        rl,
        "includeTimelineOverviewInInject (y/n)",
        seed.includeTimelineOverviewInInject ? "y" : "n",
      ),
      seed.includeTimelineOverviewInInject,
    );

    const detailOnRecallTool = toYesNo(
      await ask(rl, "detailOnRecallTool (y/n)", seed.detailOnRecallTool ? "y" : "n"),
      seed.detailOnRecallTool,
    );
    const detailChars = toNumber(await ask(rl, "detailChars", String(seed.detailChars)), seed.detailChars, 120, 20000);
    const detailCacheSize = toNumber(
      await ask(rl, "detailCacheSize", String(seed.detailCacheSize)),
      seed.detailCacheSize,
      8,
      1024,
    );
    const mem0TimeoutMs = toNumber(
      await ask(rl, "mem0TimeoutMs", String(seed.mem0TimeoutMs)),
      seed.mem0TimeoutMs,
      1000,
      120000,
    );
    const semanticCandidateMultiplier = toNumber(
      await ask(rl, "semanticCandidateMultiplier", String(seed.semanticCandidateMultiplier)),
      seed.semanticCandidateMultiplier,
      1,
      20,
    );
    const semanticBlendWeight = toFloat(
      await ask(rl, "semanticBlendWeight", String(seed.semanticBlendWeight)),
      seed.semanticBlendWeight,
      0,
      1,
    );
    const semanticTimeoutMs = toNumber(
      await ask(rl, "semanticTimeoutMs", String(seed.semanticTimeoutMs)),
      seed.semanticTimeoutMs,
      500,
      120000,
    );
    const semanticBackfillLimit = toNumber(
      await ask(rl, "semanticBackfillLimit", String(seed.semanticBackfillLimit)),
      seed.semanticBackfillLimit,
      0,
      10000,
    );

    return {
      rootDir,
      debugLogs,
      recallLimit,
      recallScoreThreshold,
      includeOverviewInInject,
      timelineRecallLimit,
      timelineScoreThreshold,
      includeTimelineOverviewInInject,
      detailOnRecallTool,
      detailChars,
      detailCacheSize,
      mem0TimeoutMs,
      semanticCandidateMultiplier,
      semanticBlendWeight,
      semanticTimeoutMs,
      semanticBackfillLimit,
    };
  } finally {
    rl.close();
  }
}

async function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (parsedArgs.helpMode) {
    printHelp();
    return;
  }

  const configPathRaw = parsedArgs.configPathRaw;
  const configPath = resolvePath(configPathRaw.replace(/^~/, homedir()));
  ensureInsideBase(configPath, "configPath");

  const config = await runInteractive(configPath, {
    yesMode: parsedArgs.yesMode,
    preferredMode: parsedArgs.preferredMode,
    useExisting: !parsedArgs.freshMode,
  });

  const resolvedRoot = resolvePath(String(config.rootDir).replace(/^~/, homedir()));
  ensureInsideBase(resolvedRoot, "rootDir");

  await writeJson(configPath, config);

  output.write(`\n[OK] Saved config to ${configPath}\n`);
  output.write("The plugin will auto-read this JSON on next startup.\n");
}

main().catch((err) => {
  console.error(`[ERROR] ${String(err?.message ?? err)}`);
  process.exitCode = 1;
});
