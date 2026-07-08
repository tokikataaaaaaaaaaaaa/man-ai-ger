/**
 * オントロジー object の CRUD。
 * name で upsert (重複作成しない、大文字小文字と前後空白を無視して照合)。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./client.js";
import { isoNow } from "../util/dates.js";
import type { ObjectType, TaskStatus, WorkObject } from "./types.js";

interface Row {
  id: string;
  type: string;
  name: string;
  aliases: string;
  properties: string;
  status: string | null;
  due: string | null;
  created_at: string;
  updated_at: string;
}

function toObject(r: Row): WorkObject {
  return {
    id: r.id,
    type: r.type as ObjectType,
    name: r.name,
    aliases: safeParse(r.aliases, []),
    properties: safeParse(r.properties, {}),
    status: (r.status as TaskStatus | null) ?? null,
    due: r.due,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function normName(name: string): string {
  return name.trim().toLowerCase();
}

/** name (または alias) で object を引く。type を指定すると絞り込む。 */
export function getByName(db: Db, name: string, type?: ObjectType): WorkObject | null {
  const rows = db
    .prepare<[], Row>(`SELECT * FROM objects${type ? " WHERE type = ?" : ""}`)
    .all(...((type ? [type] : []) as []));
  const key = normName(name);
  for (const r of rows) {
    if (normName(r.name) === key) return toObject(r);
    const aliases = safeParse<string[]>(r.aliases, []);
    if (aliases.some((a) => normName(a) === key)) return toObject(r);
  }
  return null;
}

export function getById(db: Db, id: string): WorkObject | null {
  const r = db.prepare<[string], Row>("SELECT * FROM objects WHERE id = ?").get(id);
  return r ? toObject(r) : null;
}

export interface UpsertInput {
  type: ObjectType;
  name: string;
  properties?: Record<string, unknown>;
  status?: TaskStatus | null;
  due?: string | null;
  now?: Date;
}

export interface UpsertResult {
  object: WorkObject;
  created: boolean;
}

/**
 * name で upsert。既存なら properties をマージし、status/due は与えられたときだけ上書き。
 * type は変えない (既存の type を尊重する)。
 */
export function upsertObject(db: Db, input: UpsertInput): UpsertResult {
  const now = isoNow(input.now ?? new Date());
  const existing = getByName(db, input.name, input.type);
  if (existing) {
    const merged = { ...existing.properties, ...(input.properties ?? {}) };
    const status = input.status !== undefined ? input.status : existing.status;
    const due = input.due !== undefined ? input.due : existing.due;
    db.prepare(
      "UPDATE objects SET properties = ?, status = ?, due = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(merged), status, due, now, existing.id);
    return { object: getById(db, existing.id)!, created: false };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO objects (id, type, name, aliases, properties, status, due, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.name.trim(),
    JSON.stringify(input.properties ?? {}),
    input.status ?? (input.type === "Task" ? "todo" : null),
    input.due ?? null,
    now,
    now,
  );
  return { object: getById(db, id)!, created: true };
}

/** Task の status を変更。before/after を返す (痕跡用)。対象が無ければ null。 */
export function setTaskStatus(
  db: Db,
  taskName: string,
  status: TaskStatus,
  now?: Date,
): { task: WorkObject; before: TaskStatus | null } | null {
  const task = getByName(db, taskName, "Task");
  if (!task) return null;
  const before = task.status;
  db.prepare("UPDATE objects SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    isoNow(now ?? new Date()),
    task.id,
  );
  return { task: getById(db, task.id)!, before };
}

export function listByType(db: Db, type: ObjectType): WorkObject[] {
  return db
    .prepare<[string], Row>("SELECT * FROM objects WHERE type = ? ORDER BY created_at")
    .all(type)
    .map(toObject);
}

/** 進行中 (done 以外) の Task を返す。 */
export function listActiveTasks(db: Db): WorkObject[] {
  return db
    .prepare<[], Row>(
      "SELECT * FROM objects WHERE type = 'Task' AND (status IS NULL OR status != 'done') ORDER BY created_at",
    )
    .all()
    .map(toObject);
}
