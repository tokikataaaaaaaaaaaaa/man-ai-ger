/**
 * 1 ターン処理のオーケストレーション (architecture.md §3.2)。
 *
 * 順序の保証 (二重送信・欠落防止):
 *   user turn 記録 → LLM → actions 適用 → send() 成功 → assistant turn 記録 → checkpoint event
 * send が失敗したら assistant turn と checkpoint event は記録しない (次回に自然に再送される)。
 * LLM が失敗してもターンは落とさず、決定論的なフォールバック文を送る。
 */
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/types.js";
import {
  buildTurnPrompt,
  SYSTEM_PROMPT,
  TURN_OUTPUT_SCHEMA,
  type TurnContext,
  type TurnInput,
  type ProjectTree,
} from "../llm/prompts.js";
import { parseLlmReply } from "../llm/parse.js";
import { applyActions, INBOX_PROJECT } from "./actions.js";
import { listByType } from "../db/objects.js";
import { taskProjectId } from "../db/links.js";
import { eventsOnDate, recordEvent } from "../db/events.js";
import { appendTurn, turnsOnDate } from "../db/turns.js";
import { getSetting, setSetting } from "../db/settings.js";
import { localDate } from "../util/dates.js";

export interface AgentDeps {
  db: Db;
  llm: LlmClient;
  now?: () => Date;
}

/** DB から LLM 用の文脈を組み立てる。 */
export function buildContext(db: Db, now: Date): TurnContext {
  const projects = listByType(db, "Project");
  const tasks = listByType(db, "Task");
  const byProject = new Map<string, typeof tasks>();
  const orphans: typeof tasks = [];
  for (const t of tasks) {
    const pid = taskProjectId(db, t.id);
    if (pid) {
      const list = byProject.get(pid) ?? [];
      list.push(t);
      byProject.set(pid, list);
    } else {
      orphans.push(t);
    }
  }
  const tree: ProjectTree[] = [];
  for (const p of projects) {
    const pTasks = byProject.get(p.id) ?? [];
    // 空の Inbox はノイズなので出さない
    if (p.name === INBOX_PROJECT && pTasks.length === 0 && orphans.length === 0) continue;
    tree.push({ project: p, tasks: p.name === INBOX_PROJECT ? [...pTasks, ...orphans] : pTasks });
  }
  // Inbox プロジェクト自体が無いのに orphan がいる場合の防御
  if (orphans.length > 0 && !projects.some((p) => p.name === INBOX_PROJECT)) {
    tree.push({
      project: {
        id: "inbox-virtual",
        type: "Project",
        name: INBOX_PROJECT,
        aliases: [],
        properties: {},
        status: null,
        due: null,
        createdAt: "",
        updatedAt: "",
      },
      tasks: orphans,
    });
  }
  const today = localDate(now);
  return {
    now,
    tree,
    todayTurns: turnsOnDate(db, today, 20),
    recentEvents: eventsOnDate(db, today).slice(-15),
  };
}

// --- フォールバック文 (LLM 不通でも製品として動く) ---------------------------

const FALLBACK_REPLY = "すみません、うまく処理できませんでした。もう一度お願いできますか？";
const DOCTOR_HINT =
  "\n(AI 呼び出しが連続で失敗しています。Codex App Server の状態を `manaiger doctor` で確認してください)";
const FAIL_COUNT_KEY = "llm_fail_count";

export function fallbackCheck(input: TurnInput): string {
  switch (input.kind) {
    case "user":
      return FALLBACK_REPLY;
    case "start_check":
      return `「${input.taskName}」の開始予定の時刻です。\n最初に触るのはどこにしますか？小さくて大丈夫です。`;
    case "mid_check":
      return `「${input.taskName}」の途中確認です。\nいまの状態に近いのはどれですか？ 進んだ / 詰まった / 後でやる`;
    case "end_check":
      return `「${input.taskName}」の締め時間です。\n今日はどう閉じますか？ 完了 / 続ける / 延期する / ブロッカーあり`;
    case "recheck":
      return `「${input.taskName}」について、もう一度だけ確認します。\nいまの状態に近いものを選んでください。進んだ / 詰まった / 後でやる`;
  }
}

// --- 本体 --------------------------------------------------------------------

export interface TurnResult {
  text: string;
  usedFallback: boolean;
}

/**
 * 1 ターンを処理して送信する。
 * @param send 実際の送信 (Slack 等)。throw したら「送れなかった」として記録を残さない。
 */
export async function processTurn(
  deps: AgentDeps,
  input: TurnInput,
  send: (text: string) => Promise<void>,
): Promise<TurnResult> {
  const db = deps.db;
  const now = deps.now?.() ?? new Date();

  if (input.kind === "user") {
    appendTurn(db, "user", input.text, now);
  }

  const ctx = buildContext(db, now);

  let text: string;
  let usedFallback = false;
  try {
    const raw = await deps.llm.complete(SYSTEM_PROMPT, buildTurnPrompt(ctx, input), {
      schema: TURN_OUTPUT_SCHEMA,
    });
    const parsed = parseLlmReply(raw);
    if (parsed) {
      const footnotes = applyActions(db, parsed.actions, now);
      text = footnotes.length > 0 ? `${parsed.reply}\n\n${footnotes.join("\n")}` : parsed.reply;
      setSetting(db, FAIL_COUNT_KEY, "0");
    } else {
      usedFallback = true;
      text = fallbackCheck(input);
      bumpFailCount(db);
    }
  } catch {
    usedFallback = true;
    text = fallbackCheck(input);
    const fails = bumpFailCount(db);
    if (fails >= 3) text += DOCTOR_HINT;
  }

  await send(text); // 失敗したらここで throw → 以降の記録はしない

  appendTurn(db, "assistant", text, now);
  if (input.kind !== "user") {
    const checkpointKind = input.kind;
    const label =
      input.kind === "start_check"
        ? "開始"
        : input.kind === "mid_check"
          ? "途中"
          : input.kind === "end_check"
            ? "終了"
            : "再";
    recordEvent(
      db,
      "checkpoint_sent",
      `「${input.taskName}」の${label}確認を送信`,
      {
        taskId: input.taskId,
        kind: checkpointKind,
        date: localDate(now),
        ...(input.kind === "recheck" ? { originalKind: input.originalKind } : {}),
      },
      now,
    );
  }
  return { text, usedFallback };
}

function bumpFailCount(db: Db): number {
  const cur = Number(getSetting(db, FAIL_COUNT_KEY) ?? "0") || 0;
  const next = cur + 1;
  setSetting(db, FAIL_COUNT_KEY, String(next));
  return next;
}
