import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { decideInteraction, startScheduler } from "./scheduler.js";
import { setOwnerSlackId, setSetting } from "../db/settings.js";
import { recordEvent } from "../db/events.js";
import { upsertObject } from "../db/objects.js";
import { localDate } from "../util/dates.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  setOwnerSlackId(db, "U123");
});

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

function task(name = "API 設計", status: "todo" | "doing" = "doing"): string {
  return upsertObject(db, {
    type: "Task",
    name,
    status,
    due: localDate(at("12:00")),
  }).object.id;
}

describe("decideInteraction", () => {
  it("オーナー未確定なら発火しない", () => {
    const fresh = openDb(":memory:");
    task();
    expect(decideInteraction(fresh, at("10:00"))).toBeNull();
  });

  it("開始予定前は発火しない", () => {
    task();
    expect(decideInteraction(db, at("08:59"))).toBeNull();
  });

  it("開始予定を過ぎた未送信 task は start_check", () => {
    const id = task("API 設計", "todo");
    expect(decideInteraction(db, at("09:00"))).toEqual({
      kind: "start_check",
      taskId: id,
      taskName: "API 設計",
    });
  });

  it("checkpoint_sent 済みなら同じ確認は重複送信しない", () => {
    const id = task("API 設計", "todo");
    recordEvent(db, "checkpoint_sent", "「API 設計」の開始確認を送信", {
      taskId: id,
      kind: "start_check",
    }, at("09:00"));
    expect(decideInteraction(db, at("09:10"))).toBeNull();
  });

  it("doing task は start_check 後に mid_check を送る", () => {
    const id = task("API 設計", "doing");
    recordEvent(db, "checkpoint_sent", "「API 設計」の開始確認を送信", {
      taskId: id,
      kind: "start_check",
    }, at("09:00"));
    expect(decideInteraction(db, at("13:30"))).toEqual({
      kind: "mid_check",
      taskId: id,
      taskName: "API 設計",
    });
  });

  it("終了予定を過ぎた task は end_check", () => {
    const id = task("API 設計", "todo");
    recordEvent(db, "checkpoint_sent", "「API 設計」の開始確認を送信", {
      taskId: id,
      kind: "start_check",
    }, at("09:00"));
    expect(decideInteraction(db, at("18:00"))).toEqual({
      kind: "end_check",
      taskId: id,
      taskName: "API 設計",
    });
  });

  it("day_off の日は以後の interaction を止める", () => {
    task();
    recordEvent(db, "day_off", "休み", {}, at("10:00"));
    expect(decideInteraction(db, at("18:00"))).toBeNull();
  });

  it("working hours 設定に従う", () => {
    setSetting(db, "work_start", "07:00");
    setSetting(db, "work_end", "21:00");
    const id = task("API 設計", "todo");
    expect(decideInteraction(db, at("06:59"))).toBeNull();
    expect(decideInteraction(db, at("07:00"))).toEqual({
      kind: "start_check",
      taskId: id,
      taskName: "API 設計",
    });
  });
});

describe("startScheduler", () => {
  beforeEach(() => {
    setSetting(db, "work_start", "00:00");
    setSetting(db, "work_end", "23:59");
    task("API 設計", "todo");
  });

  it("tick で runKick が呼ばれ、実行中は再入しない", async () => {
    let running = 0;
    let calls = 0;
    let maxConcurrent = 0;
    const sched = startScheduler({
      db,
      intervalMs: 10,
      runKick: async () => {
        calls++;
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    sched.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(maxConcurrent).toBe(1);
  });

  it("runKick が throw しても scheduler は止まらず onError に渡る", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const sched = startScheduler({
      db,
      intervalMs: 10,
      onError: (e) => errors.push(e),
      runKick: async () => {
        calls++;
        throw new Error("boom");
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    sched.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
