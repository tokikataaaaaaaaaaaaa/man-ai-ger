/**
 * Phase A1 の細い E2E シナリオ。
 * FakeLlm + fake send で、Slack 発話 → DB 更新 → task interaction の
 * 一連の流れを検証する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../src/db/client.js";
import { FakeLlm } from "../src/llm/types.js";
import { processTurn, buildContext } from "../src/agent/run-turn.js";
import { decideInteraction } from "../src/flows/scheduler.js";
import { setOwnerSlackId, setSetting } from "../src/db/settings.js";
import { getByName } from "../src/db/objects.js";
import { eventsOnDate } from "../src/db/events.js";
import { turnsOnDate } from "../src/db/turns.js";
import { localDate } from "../src/util/dates.js";
import { followUpQuickReplies, quickReplyBlock, validateBlocks, textBlocks } from "../src/slack/blocks.js";
import {
  detectCandidate,
  approveCandidate,
  listPendingCandidates,
} from "../src/agent/candidates.js";
import { buildDashboardSnapshot } from "../src/dashboard/snapshot.js";
import { handleDashboardIntent } from "../src/dashboard/server.js";

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

describe("シナリオ: mention → タスク候補 → 承認 → Dashboard 反映 (DoD 1-4)", () => {
  it("mention が候補になり、承認で Task 化され、Dashboard に現れる", async () => {
    // --- 1. #backend での owner mention を観測 → triage が候補と判定 ---------
    const triageLlm = new FakeLlm([
      JSON.stringify({
        task: true,
        name: "請求APIの認証方式を決める",
        project: "請求書システム改修",
        due: localDate(at("12:00")),
      }),
    ]);
    const candidate = await detectCandidate(
      db,
      triageLlm,
      { channel: "#backend", author: "Tanaka", text: "請求APIの認証方式、今日中に決めたいです。レビューできますか？" },
      buildContext(db, at("11:42")).tree,
      at("11:42"),
    );
    expect(candidate).not.toBeNull();

    // --- 2. 候補は Dashboard の Slack Context に「タスク候補」「承認待ち」で出る --
    const before = buildDashboardSnapshot(db, { now: at("11:43"), slackConfigured: true, codexAvailable: true });
    const candidateMetric = before.metrics.find((m) => m.label === "タスク候補");
    expect(candidateMetric?.count).toBe(1);
    const contextChips = before.slackContext.flatMap((c) => c.chips.map((chip) => chip.label));
    expect(contextChips).toContain("タスク候補");
    expect(contextChips).toContain("承認待ち");
    // 内部名は UI に出さない
    expect(JSON.stringify(before)).not.toContain("task_candidate");
    expect(JSON.stringify(before)).not.toContain("approval_required");

    // --- 3. 承認 → Task 作成 + events 痕跡 (承認したときだけ作られる) ----------
    expect(getByName(db, "請求APIの認証方式を決める", "Task")).toBeNull();
    approveCandidate(db, candidate!, at("11:45"));
    const task = getByName(db, "請求APIの認証方式を決める", "Task");
    expect(task).not.toBeNull();
    expect(listPendingCandidates(db)).toHaveLength(0);
    const kinds = eventsOnDate(db, localDate(at("12:00"))).map((e) => e.kind);
    expect(kinds).toContain("task_candidate_detected");
    expect(kinds).toContain("task_candidate_approved");
    expect(kinds).toContain("task_created");

    // --- 4. Dashboard: 本日締め切りに反映され、候補は消える --------------------
    const after = buildDashboardSnapshot(db, { now: at("11:46"), slackConfigured: true, codexAvailable: true });
    expect(after.metrics.find((m) => m.label === "タスク候補")?.count).toBe(0);
    expect(after.metrics.find((m) => m.label === "本日締め切り")?.count).toBe(1);
  });

  it("Dashboard の相談ボタン intent は Slack DM フローを開始する", async () => {
    const sentToOwner: { text: string }[] = [];
    const result = await handleDashboardIntent(
      {
        db,
        sendToOwner: async (text) => {
          sentToOwner.push({ text });
        },
      },
      "coach:reluctant",
    );
    expect(result.message).toContain("Slack");
    expect(sentToOwner).toHaveLength(1);
    expect(sentToOwner[0]!.text.length).toBeGreaterThan(0);
  });

  it("Dashboard の「タスク追加」ボタンは、まだ登録されていない仕事を聞き出し登録する", async () => {
    const sentToOwner: { text: string }[] = [];
    const llm = new FakeLlm([
      reply("1件、記録しました。", [
        { type: "create_task", name: "社内wikiの更新", project: null, due: null },
      ]),
    ]);
    const result = await handleDashboardIntent(
      { db, llm, sendToOwner: async (text) => void sentToOwner.push({ text }) },
      "flow:add_task",
    );
    expect(result.message).toContain("Slack");
    expect(sentToOwner).toHaveLength(1);
    expect(getByName(db, "社内wikiの更新", "Task")).not.toBeNull();
  });

  it("llm 未設定で「タスク追加」を押すと 409 を投げる (silent failしない)", async () => {
    await expect(
      handleDashboardIntent({ db, sendToOwner: async () => undefined }, "flow:add_task"),
    ).rejects.toThrow(/Codex/);
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
