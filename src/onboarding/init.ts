import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { openDb } from "../db/client.js";
import {
  DEFAULT_INTERACTION_SPACING_MIN,
  DEFAULT_RECHECK_AFTER_MIN,
  DEFAULT_WORK_END,
  DEFAULT_WORK_START,
  getInteractionSpacingMin,
  getRecheckAfterMin,
  getWorkEnd,
  getWorkStart,
  setSetting,
} from "../db/settings.js";
import { isHHMM } from "../util/dates.js";

export interface InitConfig {
  home: string;
  slackBotToken: string;
  slackAppToken: string;
  workStart: string;
  workEnd: string;
  interactionSpacingMin: number;
  recheckAfterMin: number;
  dashboardPort: number;
  codexPath: string;
  codexModel: string | null;
}

export interface InitResult {
  home: string;
  envPath: string;
  dbPath: string;
  dashboardUrl: string;
  maskedSlackBotToken: string;
  maskedSlackAppToken: string;
}

export interface InitRuntimeDefaults {
  workStart: string;
  workEnd: string;
  interactionSpacingMin: number;
  recheckAfterMin: number;
}

export interface InitValidation {
  ok: boolean;
  errors: string[];
}

export interface ApplyInitOptions {
  bootstrapEnvPath?: string;
}

export const DEFAULT_DASHBOARD_PORT = 7799;
export const DEFAULT_CODEX_PATH = "codex";

export function defaultInitHome(): string {
  return join(osHome(), ".manaiger");
}

export function defaultBootstrapEnvPath(): string {
  return join(defaultInitHome(), ".env");
}

export function expandHomePath(path: string): string {
  return path.replace(/^~(?=$|\/)/, osHome());
}

export function readInitRuntimeDefaults(dbPath: string): InitRuntimeDefaults {
  if (!existsSync(dbPath)) {
    return {
      workStart: envHHMM("MANAIGER_WORK_START", DEFAULT_WORK_START),
      workEnd: envHHMM("MANAIGER_WORK_END", DEFAULT_WORK_END),
      interactionSpacingMin: envMinutes(
        "MANAIGER_INTERACTION_SPACING_MIN",
        DEFAULT_INTERACTION_SPACING_MIN,
      ),
      recheckAfterMin: envMinutes("MANAIGER_RECHECK_AFTER_MIN", DEFAULT_RECHECK_AFTER_MIN),
    };
  }
  const db = openDb(dbPath);
  try {
    return {
      workStart: getWorkStart(db),
      workEnd: getWorkEnd(db),
      interactionSpacingMin: getInteractionSpacingMin(db),
      recheckAfterMin: getRecheckAfterMin(db),
    };
  } finally {
    db.close();
  }
}

export function validateInitConfig(config: InitConfig): InitValidation {
  const errors: string[] = [];
  if (!config.home.trim()) errors.push("データ保存先を入力してください");
  if (!config.slackBotToken.startsWith("xoxb-")) {
    errors.push("SLACK_BOT_TOKEN は xoxb- で始まる値にしてください");
  }
  if (!config.slackAppToken.startsWith("xapp-")) {
    errors.push("SLACK_APP_TOKEN は xapp- で始まる値にしてください");
  }
  if (!isHHMM(config.workStart)) errors.push("作業開始時刻は HH:MM 形式にしてください");
  if (!isHHMM(config.workEnd)) errors.push("作業終了時刻は HH:MM 形式にしてください");
  if (!isMinutes(config.interactionSpacingMin)) {
    errors.push("連続確認の最小間隔は 1-240 分で指定してください");
  }
  if (!isMinutes(config.recheckAfterMin)) {
    errors.push("未応答の再確認までは 1-240 分で指定してください");
  }
  if (!Number.isInteger(config.dashboardPort) || config.dashboardPort < 1 || config.dashboardPort > 65_535) {
    errors.push("Dashboard port は 1-65535 の整数で指定してください");
  }
  if (!config.codexPath.trim()) errors.push("Codex CLI path を入力してください");
  return { ok: errors.length === 0, errors };
}

export function applyInitConfig(
  rawConfig: InitConfig,
  opts: ApplyInitOptions = {},
): InitResult {
  const config: InitConfig = {
    ...rawConfig,
    home: expandHomePath(rawConfig.home.trim()),
    codexPath: rawConfig.codexPath.trim(),
    codexModel: rawConfig.codexModel?.trim() ? rawConfig.codexModel.trim() : null,
  };
  const validation = validateInitConfig(config);
  if (!validation.ok) throw new Error(validation.errors.join("\n"));

  const envPath = opts.bootstrapEnvPath ?? defaultBootstrapEnvPath();
  mkdirSync(config.home, { recursive: true });
  updateDotEnvFile(envPath, {
    MANAIGER_HOME: config.home,
    SLACK_BOT_TOKEN: config.slackBotToken,
    SLACK_APP_TOKEN: config.slackAppToken,
    MANAIGER_DASHBOARD_PORT: String(config.dashboardPort),
    MANAIGER_CODEX_PATH: config.codexPath,
    MANAIGER_CODEX_MODEL: config.codexModel,
  });

  const dbPath = join(config.home, "manaiger.db");
  const db = openDb(dbPath);
  try {
    setSetting(db, "work_start", config.workStart);
    setSetting(db, "work_end", config.workEnd);
    setSetting(db, "interaction_spacing_min", String(config.interactionSpacingMin));
    setSetting(db, "recheck_after_min", String(config.recheckAfterMin));
  } finally {
    db.close();
  }

  return {
    home: config.home,
    envPath,
    dbPath,
    dashboardUrl: `http://127.0.0.1:${config.dashboardPort}/`,
    maskedSlackBotToken: maskSecret(config.slackBotToken),
    maskedSlackAppToken: maskSecret(config.slackAppToken),
  };
}

export function updateDotEnvFile(path: string, values: Record<string, string | null>): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = readExistingLines(path);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const line of existing) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    const key = m?.[1];
    if (!key || !(key in values)) {
      next.push(line);
      continue;
    }
    seen.add(key);
    const value = values[key];
    if (value !== undefined && value !== null) {
      next.push(`${key}=${formatDotEnvValue(value)}`);
    }
  }
  if (next.length === 0) next.push("# Man.Ai.ger bootstrap settings");
  for (const [key, value] of Object.entries(values)) {
    if (seen.has(key) || value === null) continue;
    next.push(`${key}=${formatDotEnvValue(value)}`);
  }
  writeFileSync(path, `${next.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 5)}${"*".repeat(Math.max(3, value.length - 8))}${value.slice(-3)}`;
}

function isMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 240;
}

function envHHMM(key: string, fallback: string): string {
  const value = process.env[key];
  return value && isHHMM(value) ? value : fallback;
}

function envMinutes(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? "");
  return isMinutes(value) ? value : fallback;
}

function readExistingLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").replace(/\n$/, "").split("\n");
  } catch {
    return [];
  }
}

function formatDotEnvValue(value: string): string {
  if (value === "") return "\"\"";
  if (!/[\s#"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function osHome(): string {
  return process.env.HOME || homedir();
}
