/**
 * settings = key-value の動作設定。
 * オーナー Slack ID・working hours・単一インスタンスロックの heartbeat を持つ。
 */
import type { Db } from "./client.js";
import { isHHMM } from "../util/dates.js";

export function getSetting(db: Db, key: string): string | null {
  const r = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return r?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// --- 型付きヘルパ -----------------------------------------------------------

export const DEFAULT_WORK_START = "09:00";
export const DEFAULT_WORK_END = "18:00";
export const DEFAULT_INTERACTION_SPACING_MIN = 20;
export const DEFAULT_RECHECK_AFTER_MIN = 30;

export function getWorkStart(db: Db): string {
  const v =
    getSetting(db, "work_start") ??
    process.env.MANAIGER_WORK_START ??
    DEFAULT_WORK_START;
  return isHHMM(v) ? v : DEFAULT_WORK_START;
}

export function getWorkEnd(db: Db): string {
  const v =
    getSetting(db, "work_end") ??
    process.env.MANAIGER_WORK_END ??
    DEFAULT_WORK_END;
  return isHHMM(v) ? v : DEFAULT_WORK_END;
}

function readMinuteSetting(
  db: Db,
  key: string,
  envKey: string,
  fallback: number,
): number {
  const raw = getSetting(db, key) ?? process.env[envKey] ?? "";
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 240) return fallback;
  return n;
}

export function getInteractionSpacingMin(db: Db): number {
  return readMinuteSetting(
    db,
    "interaction_spacing_min",
    "MANAIGER_INTERACTION_SPACING_MIN",
    DEFAULT_INTERACTION_SPACING_MIN,
  );
}

export function getRecheckAfterMin(db: Db): number {
  return readMinuteSetting(
    db,
    "recheck_after_min",
    "MANAIGER_RECHECK_AFTER_MIN",
    DEFAULT_RECHECK_AFTER_MIN,
  );
}

/** オーナー (単一ユーザー) の Slack user ID。初回 DM で確定する。 */
export function getOwnerSlackId(db: Db): string | null {
  return getSetting(db, "owner_slack_id");
}

export function setOwnerSlackId(db: Db, id: string): void {
  setSetting(db, "owner_slack_id", id);
}

// --- 単一インスタンスロック (二重 DM 防止, architecture.md §1) ---------------

const HEARTBEAT_STALE_MS = 90_000;

/**
 * daemon ロックの取得を試みる。生きている別プロセスがいれば false。
 * heartbeat が古い (クラッシュ残骸) 場合は奪取する。
 */
export function acquireDaemonLock(db: Db, pid: number, nowMs: number = Date.now()): boolean {
  const cur = getSetting(db, "daemon_lock");
  if (cur) {
    try {
      const { pid: curPid, at } = JSON.parse(cur) as { pid: number; at: number };
      if (curPid !== pid && nowMs - at < HEARTBEAT_STALE_MS && isProcessAlive(curPid)) {
        return false;
      }
    } catch {
      /* 壊れたロックは奪取 */
    }
  }
  setSetting(db, "daemon_lock", JSON.stringify({ pid, at: nowMs }));
  return true;
}

export function heartbeatDaemonLock(db: Db, pid: number, nowMs: number = Date.now()): void {
  setSetting(db, "daemon_lock", JSON.stringify({ pid, at: nowMs }));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
