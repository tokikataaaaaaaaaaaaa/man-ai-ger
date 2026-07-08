/**
 * Phase A1 の細い E2E シナリオ。
 * FakeLlm + fake send で、Slack 発話 → DB 更新 → task interaction の
 * 一連の流れを検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db/client.js";
import { FakeLlm } from "../src/llm/types.js";
import { processTurn } from "../src/agent/run-turn.js";
import { decideInteraction } from "../src/flows/scheduler.js";
import { setOwnerSlackId, setSetting } from "../src/db/settings.js";
import { getByName } from "../src/db/objects.js";
import { eventsOnDate } from "../src/db/events.js";
import { turnsOnDate } from "../src/db/turns.js";
import { localDate } from "../src/util/dates.js";
import { followUpQuickReplies, quickReplyBlock, validateBlocks, textBlocks } from "../src/slack/blocks.js";

const reply = (text: string, actions: unknown[] = []): string => JSON.stringify({ reply: text, actions });

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

let db: Db;
let sent: string[];
const send = async (text: string): Promise<void> => {
  sent.push(text);
};

beforeEach(() => {
  db = openDb(":memory:");
  setOwnerSlackId(db, "U1");
  setSetting(db, "work_start", "09:00");
  setSetting(db, "work_end", "18:00");
  sent = [];
});

describe("シナリオ: Slack 発話 → タスク管理 → 延期", () => {
  it("ユーザー発話で task が作られ、start_check 後に延期として閉じられる", async () => {
    await processTurn(
      {
        db,
        llm: new FakeLlm([
          reply("「請求書システム改修」の「API 設計」を今日の管理対象にします。", [
            { type: "create_project", name: "請求書システム改修" },
            { type: "create_task", name: "API 設計", project: "請求書システム改修", due: localDate(at("12:00")) },
            { type: "set_status", task: "API 設計", status: "doing" },
          ]),
        ]),
        now: () => at("08:55"),
      },
      { kind: "user", text: "請求書システム改修の API 設計を今日進めます" },
      send,
    );

    const task = getByName(db, "API 設計", "Task");
    expect(task?.status).toBe("doing");
    expect(decideInteraction(db, at("09:00"))).toEqual({
      kind: "start_check",
      taskId: task!.id,
      taskName: "API 設計",
    });

    await processTurn(
      {
        db,
        llm: new FakeLlm([reply("「API 設計」の開始時間です。最初に触るのはどこにしますか？")]),
        now: () => at("09:00"),
      },
      { kind: "start_check", taskId: task!.id, taskName: "API 設計" },
      send,
    );

    await processTurn(
      {
        db,
        llm: new FakeLlm([
          reply("延期として記録しました。次は明日の午前に候補比較から再開しましょう。", [
            { type: "defer_task", task: "API 設計", until: null, reason: "今日は進めづらい" },
          ]),
        ]),
        now: () => at("09:10"),
      },
      { kind: "user", text: "今日は延期にします。明日の午前に候補比較からやります" },
      send,
    );

    expect(getByName(db, "API 設計", "Task")?.status).toBe("deferred");
    expect(decideInteraction(db, at("13:30"))).toBeNull();
    expect(eventsOnDate(db, localDate(at("12:00"))).some((e) => e.kind === "checkpoint_sent")).toBe(true);
    expect(turnsOnDate(db, localDate(at("12:00"))).map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});

describe("シナリオ: Slack UI (ボタン) が常に制約内", () => {
  it("相談ボタンと確認ボタンが valid", () => {
    const check = [
      ...textBlocks("「API 設計」の開始時間です。最初の一歩は何から始めますか？"),
      quickReplyBlock(followUpQuickReplies("最初の一歩は何から始めますか？"))!,
    ];
    expect(validateBlocks(check)).toEqual([]);

    const recap = [
      ...textBlocks("補足はありますか？"),
      quickReplyBlock(followUpQuickReplies("補足はありますか？"))!,
    ];
    expect(validateBlocks(recap)).toEqual([]);
  });
});
