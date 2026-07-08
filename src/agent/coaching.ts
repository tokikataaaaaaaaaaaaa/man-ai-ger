/**
 * 働きたくない時の相談 flow (requirements.md §6)。
 * LLM 不通時でも最初の受け止めと次の選択肢だけは返せるよう、入口は決定論的に処理する。
 */
import type { Db } from "../db/client.js";
import { recordEvent } from "../db/events.js";
import { listActiveTasks } from "../db/objects.js";
import type { WorkObject } from "../db/types.js";
import { localDate } from "../util/dates.js";

export type CoachingIntent = "reluctant" | "annoying" | "breakdown" | "blockers" | "defer";

export interface CoachingOption {
  intent: CoachingIntent;
  label: string;
  value: string;
}

export const COACHING_OPTIONS: CoachingOption[] = [
  { intent: "reluctant", label: "やりたくない", value: "manaiger:coach:reluctant" },
  { intent: "annoying", label: "めんどくさい", value: "manaiger:coach:annoying" },
  { intent: "breakdown", label: "タスク分解して", value: "manaiger:coach:breakdown" },
  { intent: "blockers", label: "ブロッカーまとめて", value: "manaiger:coach:blockers" },
  { intent: "defer", label: "今やらなくていい", value: "manaiger:coach:defer" },
];

const INTENT_LABEL: Record<CoachingIntent, string> = Object.fromEntries(
  COACHING_OPTIONS.map((o) => [o.intent, o.label]),
) as Record<CoachingIntent, string>;

const TEXT_ALIASES: Record<CoachingIntent, string[]> = {
  reluctant: ["やりたくない", "働きたくない", "気が進まない"],
  annoying: ["めんどくさい", "面倒くさい", "面倒"],
  breakdown: ["タスク分解して", "分解して", "小さくして"],
  blockers: ["ブロッカーまとめて", "詰まりをまとめて", "詰まりまとめて"],
  defer: ["今やらなくていい", "延期したい", "今日はやらない"],
};

export interface CoachingResult {
  reply: string;
  quickReplies: { label: string; value: string }[];
}

export function parseCoachingIntent(raw: string): CoachingIntent | null {
  const text = raw.trim();
  const command = /^manaiger:coach:(reluctant|annoying|breakdown|blockers|defer)$/.exec(text);
  if (command) return command[1] as CoachingIntent;

  const normalized = text.replace(/\s+/g, "");
  for (const [intent, aliases] of Object.entries(TEXT_ALIASES)) {
    if (aliases.some((a) => normalized === a.replace(/\s+/g, ""))) {
      return intent as CoachingIntent;
    }
  }
  return null;
}

export function handleCoachingIntent(
  db: Db,
  intent: CoachingIntent,
  now: Date = new Date(),
): CoachingResult {
  const target = pickCoachingTarget(db, localDate(now));
  recordEvent(
    db,
    "coaching_intent",
    `AIへの相談: ${INTENT_LABEL[intent]}`,
    {
      intent,
      label: INTENT_LABEL[intent],
      ...(target ? { taskId: target.id, taskName: target.name } : {}),
    },
    now,
  );

  return renderCoaching(intent, target);
}

function pickCoachingTarget(db: Db, today: string): WorkObject | null {
  const tasks = listActiveTasks(db);
  const candidates = tasks.filter((t) => t.status !== "deferred");
  const byDue = [...candidates].sort((a, b) => {
    const ad = a.due ?? "9999-12-31";
    const bd = b.due ?? "9999-12-31";
    return ad.localeCompare(bd) || a.createdAt.localeCompare(b.createdAt);
  });
  return (
    byDue.find((t) => t.status === "doing") ??
    byDue.find((t) => t.due !== null && t.due <= today) ??
    byDue.find((t) => t.status === "todo") ??
    byDue[0] ??
    null
  );
}

function renderCoaching(intent: CoachingIntent, target: WorkObject | null): CoachingResult {
  const taskName = target?.name ?? "今のタスク";
  const quoted = target ? `「${target.name}」` : "今のタスク";

  switch (intent) {
    case "reluctant":
      return {
        reply: [
          "やりたくない前提で進めます。",
          `${quoted}は完了を狙わず、5分だけ触るか、理由をつけて延期にします。`,
          "今はどちらに寄せますか？",
        ].join("\n"),
        quickReplies: [
          { label: "5分だけ触る", value: `${taskName}を5分だけ触ります` },
          { label: "延期する", value: `${taskName}を延期します。理由: 今は着手しづらい` },
          { label: "詰まりを書く", value: `${taskName}の詰まりを書きます` },
        ],
      };
    case "annoying":
      return {
        reply: [
          "めんどくささを減らします。",
          `${quoted}を「開く」「1か所だけ進める」「詰まりを書く」まで切ります。`,
          "一番摩擦が低いものを選んでください。",
        ].join("\n"),
        quickReplies: [
          { label: "開くだけ", value: `${taskName}を開くだけやります` },
          { label: "半分に切る", value: `${taskName}を半分に切ります` },
          { label: "詰まりを書く", value: `${taskName}の詰まりを書きます` },
        ],
      };
    case "breakdown":
      return {
        reply: [
          `${quoted}を小さくします。`,
          "まず「入口」「作業」「確認」の3つに分けます。",
          "細かい手順にするなら、今の状態を一言で送ってください。",
        ].join("\n"),
        quickReplies: [
          { label: "入口だけ決める", value: `${taskName}の入口だけ決めます` },
          { label: "3つに分ける", value: `${taskName}を3つの作業に分けます` },
          { label: "別タスクを選ぶ", value: "別のタスクを選びます" },
        ],
      };
    case "blockers":
      return {
        reply: [
          "詰まりだけ拾います。",
          `${quoted}で止めているものを、事実・必要な相手・次の確認に分けます。`,
          "まず一言で書いてください。",
        ].join("\n"),
        quickReplies: [
          { label: "事実を書く", value: `${taskName}の詰まりの事実を書きます` },
          { label: "相手を書く", value: `${taskName}で確認が必要な相手を書きます` },
          { label: "後で整理", value: `${taskName}の詰まりを後で整理します` },
        ],
      };
    case "defer":
      return {
        reply: [
          "今やらなくていい判断にできます。",
          `${quoted}を延期にするなら、理由と次に見る時刻だけ決めます。`,
          "延期として記録しますか？",
        ].join("\n"),
        quickReplies: [
          { label: "延期として記録", value: `${taskName}を延期として記録します` },
          { label: "今日5分だけ", value: `${taskName}を今日5分だけ触ります` },
          { label: "理由を書く", value: `${taskName}を今やらない理由を書きます` },
        ],
      };
  }
}
