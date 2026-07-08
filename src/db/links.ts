/**
 * Link (関係) の CRUD。(from, predicate, to) で一意 (Di.Ai.ry の設計を踏襲)。
 * Phase A1 の主用途は Task ──belongs_to──▶ Project。
 */
import type { Db } from "./client.js";
import { isoNow } from "../util/dates.js";
import type { Link, Predicate } from "./types.js";

interface Row {
  id: string;
  predicate: string;
  from_id: string;
  to_id: string;
  created_at: string;
}

function toLink(r: Row): Link {
  return {
    id: r.id,
    predicate: r.predicate as Predicate,
    fromId: r.from_id,
    toId: r.to_id,
    createdAt: r.created_at,
  };
}

function linkId(fromId: string, predicate: Predicate, toId: string): string {
  return `${fromId}__${predicate}__${toId}`;
}

/** 関係を upsert する。同じ組は重複しない。 */
export function upsertLink(db: Db, fromId: string, predicate: Predicate, toId: string, now?: Date): Link {
  const id = linkId(fromId, predicate, toId);
  db.prepare(
    "INSERT INTO links (id, predicate, from_id, to_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(id, predicate, fromId, toId, isoNow(now ?? new Date()));
  const r = db.prepare<[string], Row>("SELECT * FROM links WHERE id = ?").get(id)!;
  return toLink(r);
}

/** from 起点の link を引く。 */
export function linksFrom(db: Db, fromId: string, predicate?: Predicate): Link[] {
  const rows = predicate
    ? db
        .prepare<[string, string], Row>("SELECT * FROM links WHERE from_id = ? AND predicate = ?")
        .all(fromId, predicate)
    : db.prepare<[string], Row>("SELECT * FROM links WHERE from_id = ?").all(fromId);
  return rows.map(toLink);
}

/** Task が属する Project の id を返す (無ければ null)。 */
export function taskProjectId(db: Db, taskId: string): string | null {
  const ls = linksFrom(db, taskId, "belongs_to");
  return ls[0]?.toId ?? null;
}
