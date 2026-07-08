/**
 * SQLite 接続とスキーマ初期化 (architecture.md §2)。
 * better-sqlite3 (同期) を使う。単一ユーザー・単一プロセス前提なので同期で十分。
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS objects (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  properties  TEXT NOT NULL DEFAULT '{}',
  status      TEXT,
  due         TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type);
CREATE INDEX IF NOT EXISTS idx_objects_name ON objects(name);

CREATE TABLE IF NOT EXISTS links (
  id          TEXT PRIMARY KEY,
  predicate   TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  summary  TEXT NOT NULL,
  payload  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS turns (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  date     TEXT NOT NULL,
  role     TEXT NOT NULL,
  content  TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_date ON turns(date);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

/** DB を開いてスキーマを保証する。path が ":memory:" ならテスト用インメモリ。 */
export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
