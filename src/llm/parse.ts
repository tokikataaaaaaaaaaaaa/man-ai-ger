/**
 * LLM 応答のパースと検証 (architecture.md §3.3)。
 *
 * 方針: 絶対にターンを落とさない。
 * - code fence / 前後の散文があっても最初の JSON オブジェクトを抽出する
 * - actions は 1 件ずつ独立に検証し、壊れたものだけ捨てる (全滅させない)
 * - reply が取れなければ null を返し、呼び出し側が定型フォールバックを使う
 */
import { z } from "zod";
import { TASK_STATUSES } from "../db/types.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_project"), name: z.string().trim().min(1).max(120) }),
  z.object({
    type: z.literal("create_task"),
    name: z.string().trim().min(1).max(200),
    project: z.string().trim().min(1).max(120).nullish(),
    due: z.string().regex(ISO_DATE).nullish(),
    /** 締切の時刻 (HH:MM)。due が無いなら無視する (actions.ts 側で握りつぶす)。 */
    dueTime: z.string().regex(HHMM).nullish(),
  }),
  z.object({
    type: z.literal("set_status"),
    task: z.string().trim().min(1).max(200),
    status: z.enum(TASK_STATUSES),
  }),
  z.object({
    type: z.literal("set_plan"),
    task: z.string().trim().min(1).max(200).nullish(),
    summary: z.string().trim().min(1).max(500),
  }),
  z.object({
    type: z.literal("record_blocker"),
    task: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(1000),
  }),
  z.object({
    type: z.literal("defer_task"),
    task: z.string().trim().min(1).max(200),
    until: z.string().regex(ISO_DATE).nullish(),
    reason: z.string().trim().max(500).nullish(),
  }),
  z.object({ type: z.literal("note"), text: z.string().trim().min(1).max(1000) }),
]);

export type LlmAction = z.infer<typeof actionSchema>;

export interface ParsedReply {
  reply: string;
  actions: LlmAction[];
  /** 捨てた action の数 (ログ用)。 */
  droppedActions: number;
}

/** テキストから最初のバランスした JSON オブジェクトを取り出す。 */
export function extractJsonObject(text: string): string | null {
  // code fence を剥がす (```json ... ``` / ``` ... ```)
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const start = unfenced.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return unfenced.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * LLM の生テキストを ParsedReply に変換する。
 * reply が取れない (JSON でない/空) 場合は null。
 */
export function parseLlmReply(raw: string): ParsedReply | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;

  const record = obj as Record<string, unknown>;
  const reply = typeof record.reply === "string" ? record.reply.trim() : "";
  if (!reply) return null;

  const rawActions = Array.isArray(record.actions) ? record.actions : [];
  const actions: LlmAction[] = [];
  let dropped = 0;
  for (const a of rawActions) {
    const result = actionSchema.safeParse(a);
    if (result.success) actions.push(result.data);
    else dropped++;
  }
  return { reply, actions, droppedActions: dropped };
}
