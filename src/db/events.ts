/**
 * events = 全変化の痕跡 (トレーサビリティ)。
 * scheduler の重複送信防止 (checkpoint_sent) にも使う。
 */
import type { Db } from "./client.js";
import { isoNow, localDate } from "../util/dates.js";
import type { EventKind, WorkEvent } from "./types.js";

interface Row {
  id: number;
  ts: string;
  kind: string;
  summary: string;
  payload: string;
}

function toEvent(r: Row): WorkEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    /* 壊れた payload は空として扱う */
  }
  return { id: r.id, ts: r.ts, kind: r.kind as EventKind, summary: r.summary, payload };
}

export function recordEvent(
  db: Db,
  kind: EventKind,
  summary: string,
  payload: Record<string, unknown> = {},
  now?: Date,
): WorkEvent {
  const ts = isoNow(now ?? new Date());
  const info = db
    .prepare("INSERT INTO events (ts, kind, summary, payload) VALUES (?, ?, ?, ?)")
    .run(ts, kind, summary, JSON.stringify(payload));
  return { id: Number(info.lastInsertRowid), ts, kind, summary, payload };
}

/** 指定ローカル日付の events (時系列昇順)。 */
export function eventsOnDate(db: Db, date: string): WorkEvent[] {
  return db
    .prepare<[string], Row>("SELECT * FROM events WHERE ts LIKE ? || 'T%' ORDER BY id")
    .all(date)
    .map(toEvent);
}

export function recentEvents(db: Db, limit: number): WorkEvent[] {
  return db
    .prepare<[number], Row>("SELECT * FROM events ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map(toEvent)
    .reverse();
}

/** その日に kind の event が既にあるか (scheduler の重複防止)。 */
export function hasEventOnDate(db: Db, kind: EventKind, date: string = localDate()): boolean {
  const r = db
    .prepare<[string, string], { c: number }>(
      "SELECT COUNT(*) c FROM events WHERE kind = ? AND ts LIKE ? || 'T%'",
    )
    .get(kind, date);
  return (r?.c ?? 0) > 0;
}
