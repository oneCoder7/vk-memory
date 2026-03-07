import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

type FileLogLevel = "info" | "warn" | "error" | "debug";

export class VikingSessionFileLogger {
  private writeQueue: Promise<void> = Promise.resolve();
  private ensuredDirs = new Set<string>();

  constructor(private readonly rootDir: string) {}

  private normalizeSessionId(sessionId: string): string {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      return "system";
    }
    return trimmed
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 128) || "system";
  }

  private buildDailyLogPath(sessionId: string, now: Date): { dir: string; file: string } {
    const safeSession = this.normalizeSessionId(sessionId);
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const date = String(now.getDate()).padStart(2, "0");
    const day = `${year}-${month}-${date}`;
    const dir = join(this.rootDir, "logs", "sessions", safeSession);
    return {
      dir,
      file: join(dir, `${day}.log`),
    };
  }

  private enqueue(job: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(job, job).catch(() => undefined);
  }

  log(level: FileLogLevel, message: string, sessionId = "system"): void {
    const now = new Date();
    const { dir, file } = this.buildDailyLogPath(sessionId, now);
    const line = `[${now.toISOString()}] [${level.toUpperCase()}] ${message}\n`;

    this.enqueue(async () => {
      if (!this.ensuredDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        this.ensuredDirs.add(dir);
      }
      await appendFile(file, line, "utf-8");
    });
  }
}
