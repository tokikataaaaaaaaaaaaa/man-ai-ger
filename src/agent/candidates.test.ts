import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { FakeLlm } from "../llm/types.js";
import {
  approveCandidate,
  detectCandidate,
  listPendingCandidates,
  parseCandidateRevisionText,
  parseDueReply,
  rejectCandidate,
  reviseCandidate,
} from "./candidates.js";
import { getByName } from "../db/objects.js";
import { eventsOnDate } from "../db/events.js";
import { localDate } from "../util/dates.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const triage = (body: unknown): string => JSON.stringify(body);

describe("task candidates", () => {
  it("Slack message を観測し、task true なら pending candidate を作る", async () => {
    const llm = new FakeLlm([
      triage({
        task: true,
        name: "請求APIの認証方式を決める",
        project: "請求書システム改修",
        due: "2026-07-08",
      }),
    ]);

    const candidate = await detectCandidate(
      db,
      llm,
      {
        channel: "C123",
        author: "U_TANAKA",
        text: "<@U_OWNER> 請求APIの認証方式、今日中に決めたいです。レビューできますか？",
      },
      [],
      new Date("2026-07-08T11:42:00"),
    );

    expect(candidate?.name).toBe("請求APIの認証方式を決める");
    expect(listPendingCandidates(db)).toHaveLength(1);
    const kinds = eventsOnDate(db, "2026-07-08").map((e) => e.kind);
    expect(kinds).toEqual(["slack_message_observed", "task_candidate_detected"]);
  });

  it("task false なら観測だけ残し candidate は作らない", async () => {
    const llm = new FakeLlm([triage({ task: false, name: null, project: null, due: null })]);
    const candidate = await detectCandidate(
      db,
      llm,
      { channel: "C123", author: "U1", text: "FYIです" },
      [],
      new Date("2026-07-08T12:00:00"),
    );
    expect(candidate).toBeNull();
    expect(listPendingCandidates(db)).toEqual([]);
    expect(eventsOnDate(db, "2026-07-08").map((e) => e.kind)).toEqual([
      "slack_message_observed",
    ]);
  });

  it("approve した候補だけ Task を作り pending から消える", async () => {
    const llm = new FakeLlm([
      triage({ task: true, name: "API をレビューする", project: "改修", due: null }),
    ]);
    const candidate = (await detectCandidate(
      db,
      llm,
      { channel: "C123", author: "U1", text: "<@U_OWNER> API見てください" },
      [],
    ))!;

    const footnote = approveCandidate(db, candidate);

    expect(footnote).toContain("タスク「API をレビューする」を追加しました");
    expect(getByName(db, "API をレビューする", "Task")).not.toBeNull();
    expect(listPendingCandidates(db)).toEqual([]);
    expect(eventsOnDate(db, localDate()).map((e) => e.kind)).toContain("task_candidate_approved");
  });

  it("既存 Task に紐づく候補承認は task_created を重複記録しない", async () => {
    const llm = new FakeLlm([
      triage({ task: true, name: "API をレビューする", project: "改修", due: null }),
      triage({ task: true, name: "API をレビューする", project: "改修", due: null }),
    ]);
    const first = (await detectCandidate(
      db,
      llm,
      { channel: "C123", author: "U1", text: "<@U_OWNER> API見てください" },
      [],
      new Date("2026-07-08T10:00:00"),
    ))!;
    approveCandidate(db, first, new Date("2026-07-08T10:01:00"));
    const second = (await detectCandidate(
      db,
      llm,
      { channel: "C456", author: "U2", text: "<@U_OWNER> APIレビューお願いします" },
      [],
      new Date("2026-07-08T11:00:00"),
    ))!;

    const footnote = approveCandidate(db, second, new Date("2026-07-08T11:01:00"));

    expect(footnote).toContain("既存タスク「API をレビューする」に紐づけました");
    expect(listPendingCandidates(db)).toEqual([]);
    const kinds = eventsOnDate(db, "2026-07-08").map((e) => e.kind);
    expect(kinds.filter((k) => k === "task_created")).toHaveLength(1);
    expect(kinds.filter((k) => k === "task_updated")).toHaveLength(1);
    expect(kinds.filter((k) => k === "task_candidate_approved")).toHaveLength(2);
  });

  it("reject した候補は Task を作らず pending から消える", async () => {
    const llm = new FakeLlm([
      triage({ task: true, name: "不要な相談を確認する", project: null, due: null }),
    ]);
    const candidate = (await detectCandidate(
      db,
      llm,
      { channel: "C123", author: "U1", text: "<@U_OWNER> 参考まで" },
      [],
    ))!;

    rejectCandidate(db, candidate);

    expect(getByName(db, "不要な相談を確認する", "Task")).toBeNull();
    expect(listPendingCandidates(db)).toEqual([]);
    expect(eventsOnDate(db, localDate()).map((e) => e.kind)).toContain("task_candidate_rejected");
  });

  it("revision は同じ candidateId の detected を再 emit する", async () => {
    const llm = new FakeLlm([
      triage({ task: true, name: "古い名前", project: null, due: null }),
    ]);
    const candidate = (await detectCandidate(
      db,
      llm,
      { channel: "C123", author: "U1", text: "<@U_OWNER> review" },
      [],
    ))!;

    const revised = reviseCandidate(db, candidate, {
      name: "新しい名前",
      project: "新Project",
      due: "2026-07-09",
    });

    expect(revised.id).toBe(candidate.id);
    expect(listPendingCandidates(db)[0]).toMatchObject({
      id: candidate.id,
      name: "新しい名前",
      project: "新Project",
      due: "2026-07-09",
    });
  });

  it("revision text はラベル付き項目または素のタスク名を読める", () => {
    expect(parseCandidateRevisionText("タスク名: 認証方式を比較する / Project: 請求書 / Due: 2026-07-09")).toEqual({
      name: "認証方式を比較する",
      project: "請求書",
      due: "2026-07-09",
    });
    expect(parseCandidateRevisionText("認証方式を比較する")).toEqual({
      name: "認証方式を比較する",
    });
    expect(parseCandidateRevisionText("Due: 今日")).toEqual({});
  });
});

describe("parseDueReply (締切確認への返信パース)", () => {
  const now = new Date(2026, 6, 8, 10, 0); // 2026-07-08 (水)

  it("YYYY-MM-DD 形式を受け付ける", () => {
    expect(parseDueReply("2026-07-10", now)).toEqual({ due: "2026-07-10", dueTime: null });
  });

  it("YYYY-MM-DD HH:MM / YYYY-MM-DDTHH:MM の両方を受け付ける", () => {
    expect(parseDueReply("2026-07-10 17:00", now)).toEqual({ due: "2026-07-10", dueTime: "17:00" });
    expect(parseDueReply("2026-07-10T09:30", now)).toEqual({ due: "2026-07-10", dueTime: "09:30" });
  });

  it("今日/明日/明後日 の相対表現を日付参照表なしで解決する", () => {
    expect(parseDueReply("今日", now)).toEqual({ due: "2026-07-08", dueTime: null });
    expect(parseDueReply("明日", now)).toEqual({ due: "2026-07-09", dueTime: null });
    expect(parseDueReply("明後日 18:00", now)).toEqual({ due: "2026-07-10", dueTime: "18:00" });
  });

  it("「わからない」「決まっていない」等は due なしとして確定させる (聞き返さない)", () => {
    expect(parseDueReply("わからない", now)).toEqual({ due: null, dueTime: null });
    expect(parseDueReply("決まっていない", now)).toEqual({ due: null, dueTime: null });
    expect(parseDueReply("なし", now)).toEqual({ due: null, dueTime: null });
  });

  it("読み取れない自由文は null を返し、呼び出し側が聞き直せるようにする", () => {
    expect(parseDueReply("来週あたり", now)).toBeNull();
    expect(parseDueReply("金曜日", now)).toBeNull();
    expect(parseDueReply("", now)).toBeNull();
  });
});
