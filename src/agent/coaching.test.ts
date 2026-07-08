import { describe, expect, it, beforeEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { eventsOnDate } from "../db/events.js";
import { upsertObject } from "../db/objects.js";
import { localDate } from "../util/dates.js";
import { handleCoachingIntent, parseCoachingIntent } from "./coaching.js";

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

describe("parseCoachingIntent", () => {
  it("Slack button command と日本語の相談文を intent に変換する", () => {
    expect(parseCoachingIntent("manaiger:coach:reluctant")).toBe("reluctant");
    expect(parseCoachingIntent("やりたくない")).toBe("reluctant");
    expect(parseCoachingIntent("面倒")).toBe("annoying");
    expect(parseCoachingIntent("タスク分解して")).toBe("breakdown");
    expect(parseCoachingIntent("ブロッカーまとめて")).toBe("blockers");
    expect(parseCoachingIntent("今やらなくていい")).toBe("defer");
  });

  it("後続ボタンの自然文を coaching intent と誤判定しない", () => {
    expect(parseCoachingIntent("API 設計を延期として記録します")).toBeNull();
    expect(parseCoachingIntent("API 設計の詰まりを書きます")).toBeNull();
  });
});

describe("handleCoachingIntent", () => {
  it("進行中タスクを対象に返信し、coaching_intent event を残す", () => {
    upsertObject(db, {
      type: "Task",
      name: "請求API設計",
      status: "todo",
      due: localDate(at("12:00")),
    });
    const doing = upsertObject(db, {
      type: "Task",
      name: "画面実装",
      status: "doing",
      due: null,
    }).object;

    const result = handleCoachingIntent(db, "reluctant", at("10:00"));

    expect(result.reply).toContain("「画面実装」");
    expect(result.quickReplies.map((r) => r.label)).toEqual([
      "5分だけ触る",
      "延期する",
      "詰まりを書く",
    ]);
    const events = eventsOnDate(db, localDate(at("10:00")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "coaching_intent",
      summary: "AIへの相談: やりたくない",
      payload: { intent: "reluctant", taskId: doing.id, taskName: "画面実装" },
    });
  });

  it("対象タスクが無くても相談 flow は返る", () => {
    const result = handleCoachingIntent(db, "defer", at("10:00"));

    expect(result.reply).toContain("今のタスク");
    expect(result.quickReplies.map((r) => r.label)).toEqual([
      "延期として記録",
      "今日5分だけ",
      "理由を書く",
    ]);
  });
});
