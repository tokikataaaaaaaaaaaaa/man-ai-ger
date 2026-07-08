import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { FakeLlm } from "../llm/types.js";
import { processTurn, buildContext } from "./run-turn.js";
import { applyActions } from "./actions.js";
import { upsertObject, getByName, listActiveTasks } from "../db/objects.js";
import { eventsOnDate } from "../db/events.js";
import { turnsOnDate } from "../db/turns.js";
import { localDate } from "../util/dates.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const ok = (reply: string, actions: unknown[] = []) =>
  JSON.stringify({ reply, actions });

function collectSend(): { sent: string[]; send: (t: string) => Promise<void> } {
  const sent: string[] = [];
  return { sent, send: async (t) => void sent.push(t) };
}

describe("applyActions", () => {
  it("create_task はプロジェクトに所属し、脚注と event を残す", () => {
    const notes = applyActions(db, [
      { type: "create_project", name: "改修" },
      { type: "create_task", name: "API 設計", project: "改修", due: "2026-07-03" },
    ]);
    expect(notes).toEqual([
      "📋 プロジェクト「改修」を追加しました",
      "📋 タスク「API 設計」を追加しました (締切: 2026-07-03)",
    ]);
    expect(getByName(db, "API 設計", "Task")?.due).toBe("2026-07-03");
    expect(eventsOnDate(db, localDate()).map((e) => e.kind)).toEqual([
      "project_created",
      "task_created",
    ]);
  });

  it("project 指定なしの create_task は Inbox に入る", () => {
    applyActions(db, [{ type: "create_task", name: "雑務" }]);
    expect(getByName(db, "Inbox", "Project")).not.toBeNull();
  });

  it("set_status は before → after を脚注にする。変化なしは黙る", () => {
    applyActions(db, [{ type: "create_task", name: "調査" }]);
    const n1 = applyActions(db, [{ type: "set_status", task: "調査", status: "doing" }]);
    expect(n1).toEqual(["📋 タスク「調査」: 未着手 → 進行中"]);
    const n2 = applyActions(db, [{ type: "set_status", task: "調査", status: "doing" }]);
    expect(n2).toEqual([]);
  });

  it("未登録タスクへの set_status は自己修復で作成する", () => {
    const notes = applyActions(db, [{ type: "set_status", task: "急な依頼", status: "done" }]);
    expect(notes).toEqual(["📋 タスク「急な依頼」を記録しました (完了)"]);
    expect(getByName(db, "急な依頼", "Task")?.status).toBe("done");
  });

  it("set_plan と defer_task は event を残す", () => {
    applyActions(db, [
      { type: "set_plan", task: "API 設計", summary: "10時にAPI設計から" },
      { type: "defer_task", task: "API 設計", until: null, reason: "今日は動けない" },
    ]);
    const kinds = eventsOnDate(db, localDate()).map((e) => e.kind);
    expect(kinds).toContain("plan_set");
    expect(kinds).toContain("task_status");
  });
});

describe("processTurn (user)", () => {
  it("正常系: user/assistant turn 記録 + actions 適用 + 脚注付き送信", async () => {
    const llm = new FakeLlm([
      ok("お疲れさまです！次は何をしますか？", [
        { type: "create_task", name: "画面実装", project: "改修", due: null },
      ]),
    ]);
    const { sent, send } = collectSend();
    const r = await processTurn({ db, llm }, { kind: "user", text: "画面実装が増えた" }, send);

    expect(r.usedFallback).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("お疲れさまです");
    expect(sent[0]).toContain("📋 タスク「画面実装」を追加しました");
    const turns = turnsOnDate(db, localDate());
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(listActiveTasks(db).map((t) => t.name)).toEqual(["画面実装"]);
  });

  it("LLM が壊れた JSON を返したらフォールバック文を送りターンは落とさない", async () => {
    const llm = new FakeLlm(["これはJSONではありません"]);
    const { sent, send } = collectSend();
    const r = await processTurn({ db, llm }, { kind: "user", text: "テスト" }, send);
    expect(r.usedFallback).toBe(true);
    expect(sent[0]).toContain("もう一度お願いできますか");
  });

  it("LLM が throw してもフォールバックで応答し、3連続失敗で doctor 案内", async () => {
    const mk = () => new FakeLlm([new Error("down")]);
    const { sent, send } = collectSend();
    await processTurn({ db, llm: mk() }, { kind: "user", text: "a" }, send);
    await processTurn({ db, llm: mk() }, { kind: "user", text: "b" }, send);
    await processTurn({ db, llm: mk() }, { kind: "user", text: "c" }, send);
    expect(sent[2]).toContain("manaiger doctor");
    // 成功したらカウンタはリセット
    const okLlm = new FakeLlm([ok("復帰しました")]);
    await processTurn({ db, llm: okLlm }, { kind: "user", text: "d" }, send);
    expect(sent[3]).not.toContain("manaiger doctor");
  });

  it("send が失敗したら assistant turn は記録されない (再送安全)", async () => {
    const llm = new FakeLlm([ok("hello")]);
    await expect(
      processTurn({ db, llm }, { kind: "user", text: "x" }, async () => {
        throw new Error("slack down");
      }),
    ).rejects.toThrow("slack down");
    const roles = turnsOnDate(db, localDate()).map((t) => t.role);
    expect(roles).toEqual(["user"]); // assistant は残らない
  });
});

describe("processTurn (scheduled checks)", () => {
  it("start_check: 送信成功で checkpoint_sent が記録される", async () => {
    const llm = new FakeLlm([ok("「API 設計」の開始時間です。最初に触るのはどこにしますか？")]);
    const { sent, send } = collectSend();
    await processTurn(
      { db, llm },
      { kind: "start_check", taskId: "t1", taskName: "API 設計" },
      send,
    );
    expect(sent).toHaveLength(1);
    expect(eventsOnDate(db, localDate()).some((e) => e.kind === "checkpoint_sent")).toBe(true);
  });

  it("mid_check: LLM 不通なら決定論フォールバック", async () => {
    const llm = new FakeLlm([new Error("down")]);
    const { sent, send } = collectSend();
    await processTurn(
      { db, llm },
      { kind: "mid_check", taskId: "t1", taskName: "API 設計" },
      send,
    );
    expect(sent[0]).toContain("API 設計");
    expect(sent[0]).toContain("途中確認");
    expect(eventsOnDate(db, localDate()).some((e) => e.kind === "checkpoint_sent")).toBe(true);
  });

  it("end_check: フォールバックでも checkpoint_sent を記録する", async () => {
    const llm = new FakeLlm([new Error("down")]); // フォールバック経路で検証
    const { sent, send } = collectSend();
    await processTurn(
      { db, llm },
      { kind: "end_check", taskId: "t1", taskName: "API 設計" },
      send,
    );
    expect(sent[0]).toContain("締め時間");
    expect(eventsOnDate(db, localDate()).some((e) => e.kind === "checkpoint_sent")).toBe(true);
  });
});

describe("processTurn (start_of_day)", () => {
  it("Slack mention が無くても発火でき、聞き出した内容から create_task が記録される。checkpoint_sent は残らない", async () => {
    const llm = new FakeLlm([ok("今日取り組むことを教えてください。", [])]);
    const { sent, send } = collectSend();
    await processTurn({ db, llm }, { kind: "start_of_day" }, send);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("今日取り組むこと");
    // タスク非依存の flow なので checkpoint_sent (taskId 前提) は記録しない
    expect(eventsOnDate(db, localDate()).some((e) => e.kind === "checkpoint_sent")).toBe(false);
  });

  it("LLM 不通でも決定論フォールバックで応答する", async () => {
    const llm = new FakeLlm([new Error("down")]);
    const { sent, send } = collectSend();
    await processTurn({ db, llm }, { kind: "start_of_day" }, send);
    expect(sent[0]).toContain("今日取り組むこと");
  });

  it("聞き出した今日/将来のタスクが create_task で登録される", async () => {
    const llm = new FakeLlm([
      ok("2件、記録しました。", [
        { type: "create_task", name: "見積書のレビュー", project: null, due: localDate() },
        { type: "create_task", name: "来月の企画書たたき台", project: null, due: null },
      ]),
    ]);
    const { sent, send } = collectSend();
    await processTurn({ db, llm }, { kind: "start_of_day" }, send);

    expect(sent[0]).toContain("記録しました");
    expect(getByName(db, "見積書のレビュー", "Task")).not.toBeNull();
    expect(getByName(db, "来月の企画書たたき台", "Task")).not.toBeNull();
  });
});

describe("buildContext", () => {
  it("プロジェクト配下にタスクが並び、初日は空表示", () => {
    const empty = buildContext(db, new Date());
    expect(empty.tree).toEqual([]);

    applyActions(db, [
      { type: "create_project", name: "改修" },
      { type: "create_task", name: "API 設計", project: "改修" },
      { type: "create_task", name: "未分類作業" },
    ]);
    const ctx = buildContext(db, new Date());
    const names = ctx.tree.map((g) => g.project.name);
    expect(names).toContain("改修");
    expect(names).toContain("Inbox");
    const kaishu = ctx.tree.find((g) => g.project.name === "改修")!;
    expect(kaishu.tasks.map((t) => t.name)).toEqual(["API 設計"]);
  });
});
