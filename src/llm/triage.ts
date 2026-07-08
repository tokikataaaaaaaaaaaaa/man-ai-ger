/**
 * Slack mention / channel message のタスク候補判定 (requirements.md §4)。
 *
 * コーチ会話 (prompts.ts) とは別の小さな契約。1 メッセージを受け取り、
 * 「ユーザーが対応すべき依頼か」を判定してタスク名・Project・期限を提案する。
 */
import { z } from "zod";
import type { ProjectTree } from "./prompts.js";
import { renderCalendar } from "./prompts.js";
import { jaWeekday } from "../util/dates.js";

export const TRIAGE_SYSTEM_PROMPT = `あなたは Man.Ai.ger のタスク仕分け係です。
Slack でユーザー宛てに届いたメッセージを 1 件読み、ユーザー本人が対応すべき「依頼・確認・作業」ならタスク候補として提案します。

判定基準:
- ユーザーに行動を求めている (レビュー依頼、判断依頼、作業依頼、期限つきの相談) → task: true
- 単なる雑談、FYI、他の人宛て、既に完了した話 → task: false
- 迷ったら false (ノイズ提案はユーザーの信頼を削る)

task: true の場合:
- name: 「◯◯を決める」「◯◯をレビューする」のような動詞で終わる具体的なタスク名 (メッセージの言葉を使う)
- project: 既存プロジェクト一覧に合うものがあればその名前、なければ null
- due: メッセージに期限の手がかりがあれば日付参照表で YYYY-MM-DD に換算、なければ null

出力契約: 本文として次の JSON オブジェクトだけを出力してください。
{"task": true|false, "name": "... または null", "project": "... または null", "due": "YYYY-MM-DD または null"}`;

export const TRIAGE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    task: { type: "boolean" },
    name: { type: ["string", "null"] },
    project: { type: ["string", "null"] },
    due: { type: ["string", "null"] },
  },
  required: ["task"],
  additionalProperties: false,
};

export interface ObservedMessage {
  channel: string;
  author: string;
  text: string;
}

export function buildTriagePrompt(
  msg: ObservedMessage,
  tree: ProjectTree[],
  now: Date,
): string {
  const projects = tree.map((g) => `- ${g.project.name}`).join("\n") || "(まだありません)";
  const dateLine = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 (${jaWeekday(now)})`;
  return [
    `## 今日\n${dateLine}\n日付参照表: ${renderCalendar(now)}`,
    `## 既存プロジェクト一覧\n${projects}`,
    `## 届いたメッセージ\nチャンネル: ${msg.channel}\n送信者: ${msg.author}\n本文: ${msg.text}`,
  ].join("\n\n");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const triageSchema = z.object({
  task: z.boolean(),
  name: z.string().trim().min(1).max(200).nullish(),
  project: z.string().trim().min(1).max(120).nullish(),
  due: z.string().regex(ISO_DATE).nullish(),
});

export interface TriageResult {
  task: boolean;
  name: string | null;
  project: string | null;
  due: string | null;
}

/** triage 応答をパースする。壊れていたら null (= 候補化しない、安全側)。 */
export function parseTriage(raw: string): TriageResult | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const r = triageSchema.safeParse(obj);
  if (!r.success) return null;
  if (r.data.task && !r.data.name) return null; // タスクなのに名前が無い提案は使えない
  return {
    task: r.data.task,
    name: r.data.name ?? null,
    project: r.data.project ?? null,
    due: r.data.due ?? null,
  };
}
