import { describe, expect, it, beforeEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { recordEvent, eventsOnDate } from "../db/events.js";
import { upsertLink } from "../db/links.js";
import { upsertObject } from "../db/objects.js";
import { setOwnerSlackId, setSetting } from "../db/settings.js";
import { localDate } from "../util/dates.js";
import { renderDashboardPage } from "./render.js";
import { buildDashboardSnapshot } from "./snapshot.js";
import { handleDashboardIntent } from "./server.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

describe("buildDashboardSnapshot", () => {
  it("現在マネジメント中、5分類、Service を DB から作る", () => {
    const now = at("10:00");
    setOwnerSlackId(db, "U123");
    setSetting(db, "daemon_lock", JSON.stringify({ pid: process.pid, at: now.getTime() }));
    const project = upsertObject(db, { type: "Project", name: "請求書システム改修", now }).object;
    const doing = upsertObject(db, {
      type: "Task",
      name: "API 設計",
      status: "doing",
      due: localDate(now),
      now,
    }).object;
    upsertLink(db, doing.id, "belongs_to", project.id, now);
    upsertObject(db, { type: "Task", name: "画面実装", status: "todo", due: null, now });
    recordEvent(db, "task_candidate_detected", "タスク候補", {
      candidateId: "c1",
      name: "認証方式を決める",
      project: "請求書システム改修",
      due: localDate(now),
      sourceChannel: "#backend",
      sourceAuthor: "Tanaka",
      sourceText: "レビューできますか？",
    }, now);

    const snapshot = buildDashboardSnapshot(db, {
      now,
      slackConfigured: true,
      codexAvailable: true,
    });

    expect(snapshot.current?.title).toBe("請求書システム改修 / API 設計");
    expect(snapshot.metrics.map((m) => [m.label, m.count])).toEqual([
      ["タスク候補", 1],
      ["本日締め切り", 1],
      ["期限すぎ", 0],
      ["進行中", 1],
      ["未着手", 1],
    ]);
    expect(snapshot.services.map((s) => [s.name, s.detail])).toEqual([
      ["Slack連携", "接続中"],
      ["Codex App Server", "利用可"],
      ["最終同期", "10:00"],
    ]);
  });

  it("Slack Context は日本語状態チップを出し、内部状態名を出さない", () => {
    recordEvent(db, "task_candidate_detected", "タスク候補", {
      candidateId: "c1",
      name: "認証方式を決める",
      project: "請求書システム改修",
      due: localDate(at("10:00")),
      sourceChannel: "#backend",
      sourceAuthor: "Tanaka",
      sourceText: "レビューできますか？",
    }, at("10:00"));

    const html = renderDashboardPage(buildDashboardSnapshot(db, { now: at("10:00") }));

    expect(html).toContain("タスク候補");
    expect(html).toContain("承認待ち");
    expect(html).not.toMatch(/task_candidate|approval_required|Slack option/);
    expect(html).not.toContain("仕事の現在地");
  });
});

describe("handleDashboardIntent", () => {
  it("coach action は Slack DM へ送り、coaching_intent event を残す", async () => {
    const sent: { text: string; labels: string[] }[] = [];

    const result = await handleDashboardIntent(
      {
        db,
        sendToOwner: async (text, quickReplies) => {
          sent.push({ text, labels: (quickReplies ?? []).map((r) => r.label) });
        },
      },
      "coach:reluctant",
    );

    expect(result.message).toBe("Slack DMで相談を開始しました。");
    expect(sent[0]?.text).toContain("やりたくない前提");
    expect(sent[0]?.labels).toContain("5分だけ触る");
    expect(eventsOnDate(db, localDate()).some((e) => e.kind === "coaching_intent")).toBe(true);
  });

  it("candidate:judge は承認待ち候補を Slack DM へ再送する", async () => {
    recordEvent(db, "task_candidate_detected", "タスク候補", {
      candidateId: "c1",
      name: "認証方式を決める",
      project: "請求書システム改修",
      due: localDate(at("10:00")),
      sourceChannel: "#backend",
      sourceAuthor: "Tanaka",
      sourceText: "レビューできますか？",
    }, at("10:00"));
    const sent: { text: string; labels: string[] }[] = [];

    await handleDashboardIntent(
      {
        db,
        sendToOwner: async (text, quickReplies) => {
          sent.push({ text, labels: (quickReplies ?? []).map((r) => r.label) });
        },
      },
      "candidate:judge",
    );

    expect(sent[0]?.text).toContain("このmentionをタスク化しますか？");
    expect(sent[0]?.labels).toEqual(["タスク化する", "内容を修正", "タスク化しない"]);
  });
});
