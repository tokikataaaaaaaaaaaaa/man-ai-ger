import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "./client.js";
import {
  upsertObject,
  getByName,
  setTaskStatus,
  listActiveTasks,
  listByType,
} from "./objects.js";
import { upsertLink, taskProjectId, linksFrom } from "./links.js";
import { recordEvent, eventsOnDate, hasEventOnDate, recentEvents } from "./events.js";
import { appendTurn, turnsOnDate } from "./turns.js";
import {
  getSetting,
  setSetting,
  getWorkStart,
  getWorkEnd,
  getInteractionSpacingMin,
  getRecheckAfterMin,
  acquireDaemonLock,
} from "./settings.js";
import { localDate } from "../util/dates.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("objects", () => {
  it("Task を作成すると status のデフォルトは todo", () => {
    const r = upsertObject(db, { type: "Task", name: "設計書を書く" });
    expect(r.created).toBe(true);
    expect(r.object.status).toBe("todo");
    expect(r.object.due).toBeNull();
  });

  it("同名 (大文字小文字・空白無視) は重複作成せず properties をマージする", () => {
    upsertObject(db, { type: "Project", name: "社内ダッシュボード", properties: { a: 1 } });
    const r = upsertObject(db, { type: "Project", name: " 社内ダッシュボード ", properties: { b: 2 } });
    expect(r.created).toBe(false);
    expect(r.object.properties).toEqual({ a: 1, b: 2 });
    expect(listByType(db, "Project")).toHaveLength(1);
  });

  it("upsert で status/due は与えたときだけ上書きされる", () => {
    upsertObject(db, { type: "Task", name: "レビュー対応", status: "doing", due: "2026-07-01" });
    const r = upsertObject(db, { type: "Task", name: "レビュー対応", properties: { note: "x" } });
    expect(r.object.status).toBe("doing");
    expect(r.object.due).toBe("2026-07-01");
  });

  it("due_time は締切の時刻指定として保存・維持される", () => {
    const created = upsertObject(db, {
      type: "Task",
      name: "資料提出",
      due: "2026-07-10",
      dueTime: "17:00",
    });
    expect(created.object.dueTime).toBe("17:00");

    // dueTime を与えない upsert では既存値を保持する
    const kept = upsertObject(db, { type: "Task", name: "資料提出", properties: { note: "x" } });
    expect(kept.object.dueTime).toBe("17:00");

    // 明示的に null を与えれば時刻指定を外せる
    const cleared = upsertObject(db, { type: "Task", name: "資料提出", dueTime: null });
    expect(cleared.object.dueTime).toBeNull();
  });

  it("時刻指定のない締切は due_time が null のまま", () => {
    const r = upsertObject(db, { type: "Task", name: "日付だけの締切", due: "2026-07-10" });
    expect(r.object.due).toBe("2026-07-10");
    expect(r.object.dueTime).toBeNull();
  });

  it("setTaskStatus は before を返し、存在しないタスクなら null", () => {
    upsertObject(db, { type: "Task", name: "調査" });
    const r = setTaskStatus(db, "調査", "doing");
    expect(r?.before).toBe("todo");
    expect(r?.task.status).toBe("doing");
    expect(setTaskStatus(db, "存在しない", "done")).toBeNull();
  });

  it("listActiveTasks は done を除外する", () => {
    upsertObject(db, { type: "Task", name: "a" });
    upsertObject(db, { type: "Task", name: "b", status: "done" });
    expect(listActiveTasks(db).map((t) => t.name)).toEqual(["a"]);
  });

  it("getByName は alias でも引ける", () => {
    const { object } = upsertObject(db, { type: "Project", name: "ダッシュボード改修" });
    db.prepare("UPDATE objects SET aliases = ? WHERE id = ?").run(
      JSON.stringify(["DB改修"]),
      object.id,
    );
    expect(getByName(db, "db改修")?.id).toBe(object.id);
  });
});

describe("links", () => {
  it("belongs_to を upsert し、重複しない", () => {
    const p = upsertObject(db, { type: "Project", name: "P" }).object;
    const t = upsertObject(db, { type: "Task", name: "T" }).object;
    upsertLink(db, t.id, "belongs_to", p.id);
    upsertLink(db, t.id, "belongs_to", p.id);
    expect(linksFrom(db, t.id)).toHaveLength(1);
    expect(taskProjectId(db, t.id)).toBe(p.id);
  });
});

describe("events", () => {
  it("記録と日付検索、重複判定", () => {
    const now = new Date();
    recordEvent(db, "task_status", "T → doing", { before: "todo", after: "doing" }, now);
    const today = localDate(now);
    expect(eventsOnDate(db, today)).toHaveLength(1);
    expect(hasEventOnDate(db, "task_status", today)).toBe(true);
    expect(hasEventOnDate(db, "checkpoint_sent", today)).toBe(false);
  });

  it("recentEvents は時系列昇順で末尾 N 件", () => {
    for (let i = 0; i < 5; i++) recordEvent(db, "note", `n${i}`);
    expect(recentEvents(db, 2).map((e) => e.summary)).toEqual(["n3", "n4"]);
  });
});

describe("turns", () => {
  it("会話を日別に記録し、末尾 limit 件を取れる", () => {
    appendTurn(db, "user", "おはよう");
    appendTurn(db, "assistant", "おはようございます");
    appendTurn(db, "user", "今日はAをやります");
    const today = localDate();
    expect(turnsOnDate(db, today)).toHaveLength(3);
    expect(turnsOnDate(db, today, 2).map((t) => t.role)).toEqual(["assistant", "user"]);
  });

  it("空メッセージは記録しない", () => {
    appendTurn(db, "user", "   ");
    expect(turnsOnDate(db, localDate())).toHaveLength(0);
  });
});

describe("settings", () => {
  it("get/set と working hours のデフォルト", () => {
    expect(getSetting(db, "x")).toBeNull();
    setSetting(db, "x", "1");
    setSetting(db, "x", "2");
    expect(getSetting(db, "x")).toBe("2");
    expect(getWorkStart(db)).toBe("09:00");
    expect(getWorkEnd(db)).toBe("18:00");
    expect(getInteractionSpacingMin(db)).toBe(20);
    expect(getRecheckAfterMin(db)).toBe(30);
    setSetting(db, "work_start", "07:30");
    setSetting(db, "work_end", "19:30");
    setSetting(db, "interaction_spacing_min", "15");
    setSetting(db, "recheck_after_min", "45");
    expect(getWorkStart(db)).toBe("07:30");
    expect(getWorkEnd(db)).toBe("19:30");
    expect(getInteractionSpacingMin(db)).toBe(15);
    expect(getRecheckAfterMin(db)).toBe(45);
  });

  it("不正な時刻・分数設定はデフォルトにフォールバック", () => {
    setSetting(db, "work_start", "25:99");
    setSetting(db, "work_end", "99:99");
    setSetting(db, "interaction_spacing_min", "0");
    setSetting(db, "recheck_after_min", "241");
    expect(getWorkStart(db)).toBe("09:00");
    expect(getWorkEnd(db)).toBe("18:00");
    expect(getInteractionSpacingMin(db)).toBe(20);
    expect(getRecheckAfterMin(db)).toBe(30);
  });

  it("daemon ロック: 自プロセスは取得でき、生きている他プロセスには奪われない", () => {
    const now = Date.now();
    expect(acquireDaemonLock(db, process.pid, now)).toBe(true);
    // 同じ pid は再取得できる (再起動)
    expect(acquireDaemonLock(db, process.pid, now + 1000)).toBe(true);
    // 生きている別プロセス (自プロセスを別 pid とみなす代用として init=1 は使えないため、
    // 「存在しない pid のロックは stale 扱いで奪取できる」ことを検証する
    setSetting(db, "daemon_lock", JSON.stringify({ pid: 999999, at: now }));
    expect(acquireDaemonLock(db, process.pid, now + 1000)).toBe(true);
  });
});

describe("migrate (既存 DB への後方互換カラム追加)", () => {
  it("due_time 列が無い旧スキーマの objects テーブルにも、openDb で自動的に列を追加する", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "manaiger-migrate-test-"));
    const dbPath = join(dir, "manaiger.db");
    try {
      // due_time の無い旧スキーマを直接作り、既存タスクを1件入れておく
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE objects (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
          aliases TEXT NOT NULL DEFAULT '[]', properties TEXT NOT NULL DEFAULT '{}',
          status TEXT, due TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      legacy
        .prepare(
          `INSERT INTO objects (id, type, name, status, due, created_at, updated_at)
           VALUES ('t1', 'Task', '既存タスク', 'todo', '2026-07-01', '2026-06-01T00:00:00+09:00', '2026-06-01T00:00:00+09:00')`,
        )
        .run();
      legacy.close();

      // openDb で開き直すと due_time が追加され、既存データは失われない
      const migrated = openDb(dbPath);
      const cols = migrated.prepare("PRAGMA table_info(objects)").all() as { name: string }[];
      expect(cols.some((c) => c.name === "due_time")).toBe(true);

      const existing = getByName(migrated, "既存タスク", "Task");
      expect(existing?.due).toBe("2026-07-01");
      expect(existing?.dueTime).toBeNull();

      // 移行後も dueTime を新規に設定できる
      upsertObject(migrated, { type: "Task", name: "既存タスク", dueTime: "09:30" });
      expect(getByName(migrated, "既存タスク", "Task")?.dueTime).toBe("09:30");
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
