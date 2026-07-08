/**
 * 環境設定の読み込み。環境依存物はすべてここに集約する (requirements.md §3 環境移植性)。
 * .env は dotenv でなく手動で読む (依存を増やさない)。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  home: string;
  dbPath: string;
  logPath: string;
  codexPath: string;
  codexModel: string | null;
  slackBotToken: string | null;
  slackAppToken: string | null;
}

/** カレント → home の順に .env を読み、既存の env を上書きしない。 */
export function loadDotEnv(cwd: string = process.cwd()): void {
  for (const p of [join(cwd, ".env"), join(resolveHome(), ".env")]) {
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, "utf8").split("\n");
      for (const line of lines) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1]!;
        const value = m[2]!.replace(/^["']|["']$/g, "");
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      /* .env が読めなくても起動は続ける */
    }
  }
}

function resolveHome(): string {
  const h = process.env.MANAIGER_HOME;
  if (h && h.trim()) return h.replace(/^~(?=$|\/)/, homedir());
  return join(homedir(), ".manaiger");
}

export function loadConfig(): Config {
  loadDotEnv();
  const home = resolveHome();
  return {
    home,
    dbPath: join(home, "manaiger.db"),
    logPath: join(home, "manaiger.log"),
    codexPath: process.env.MANAIGER_CODEX_PATH ?? "codex",
    codexModel: process.env.MANAIGER_CODEX_MODEL ?? null,
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? null,
    slackAppToken: process.env.SLACK_APP_TOKEN ?? null,
  };
}
