/**
 * LLM の actions を DB に適用し、ユーザーに見せる脚注を決定論的に生成する
 * (architecture.md §3.3: 何が起きたか常に見える = 信頼)。
 *
 * 各 action は独立に try/catch し、1 件の失敗が他を巻き込まない。
 */
import type { Db } from "../db/client.js";
import { upsertObject, setTaskStatus, getByName } from "../db/objects.js";
import { upsertLink } from "../db/links.js";
import { recordEvent } from "../db/events.js";
import type { LlmAction } from "../llm/parse.js";
import type { TaskStatus } from "../db/types.js";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  blocked: "ブロック中",
  done: "完了",
  deferred: "延期中",
};

export const INBOX_PROJECT = "Inbox";

/** Inbox 擬似プロジェクトを保証して id を返す。 */
export function ensureInbox(db: Db, now?: Date): string {
  return upsertObject(db, { type: "Project", name: INBOX_PROJECT, now: now ?? new Date() })
    .object.id;
}

function applyOne(db: Db, action: LlmAction, now: Date): string | null {
  switch (action.type) {
    case "create_project": {
      const r = upsertObject(db, { type: "Project", name: action.name, now });
      if (!r.created) return null; // 既存なら黙る (ノイズ回避)
      recordEvent(db, "project_created", `プロジェクト「${r.object.name}」を追加`, { id: r.object.id }, now);
      return `📋 プロジェクト「${r.object.name}」を追加しました`;
    }

    case "create_task": {
      const r = upsertObject(db, {
        type: "Task",
        name: action.name,
        due: action.due ?? null,
        now,
      });
      // 所属プロジェクト: 指定があればそれを保証、無ければ Inbox
      const projectId = action.project
        ? upsertObject(db, { type: "Project", name: action.project, now }).object.id
        : ensureInbox(db, now);
      upsertLink(db, r.object.id, "belongs_to", projectId, now);
      if (!r.created) {
        // 既存タスクへの due 更新のみ通知
        if (action.due) return `📋 タスク「${r.object.name}」の締切を ${action.due} にしました`;
        return null;
      }
      recordEvent(
        db,
        "task_created",
        `タスク「${r.object.name}」を追加`,
        { id: r.object.id, project: action.project ?? INBOX_PROJECT, due: action.due ?? null },
        now,
      );
      const due = action.due ? ` (締切: ${action.due})` : "";
      return `📋 タスク「${r.object.name}」を追加しました${due}`;
    }

    case "set_status": {
      const result = setTaskStatus(db, action.task, action.status, now);
      if (!result) {
        // 未登録タスクへの status 変更 → 自己修復: タスクを作って適用 (zero-input 原則)
        const created = upsertObject(db, {
          type: "Task",
          name: action.task,
          status: action.status,
          now,
        });
        upsertLink(db, created.object.id, "belongs_to", ensureInbox(db, now), now);
        recordEvent(
          db,
          "task_created",
          `タスク「${created.object.name}」を追加 (${STATUS_LABEL[action.status]})`,
          { id: created.object.id, status: action.status },
          now,
        );
        return `📋 タスク「${created.object.name}」を記録しました (${STATUS_LABEL[action.status]})`;
      }
      if (result.before === action.status) return null; // 変化なしは黙る
      recordEvent(
        db,
        "task_status",
        `タスク「${result.task.name}」: ${result.before ? STATUS_LABEL[result.before] : "-"} → ${STATUS_LABEL[action.status]}`,
        { id: result.task.id, before: result.before, after: action.status },
        now,
      );
      return `📋 タスク「${result.task.name}」: ${result.before ? STATUS_LABEL[result.before] : "-"} → ${STATUS_LABEL[action.status]}`;
    }

    case "set_plan": {
      recordEvent(
        db,
        "plan_set",
        action.summary,
        action.task ? { task: action.task } : {},
        now,
      );
      return `📋 計画を記録しました`;
    }

    case "record_blocker": {
      const task = getByName(db, action.task, "Task");
      if (task && task.status !== "blocked") {
        setTaskStatus(db, action.task, "blocked", now);
      }
      recordEvent(
        db,
        "task_updated",
        `タスク「${action.task}」のブロッカー: ${action.text}`,
        { task: action.task, blocker: action.text, ...(task ? { id: task.id } : {}) },
        now,
      );
      return `📋 タスク「${action.task}」のブロッカーを記録しました`;
    }

    case "defer_task": {
      const result = setTaskStatus(db, action.task, "deferred", now);
      const untilNote = action.until ? ` (${action.until} まで)` : "";
      recordEvent(
        db,
        "task_status",
        `タスク「${action.task}」を延期${untilNote}`,
        {
          task: action.task,
          before: result?.before ?? null,
          after: "deferred",
          until: action.until ?? null,
          reason: action.reason ?? null,
          ...(result ? { id: result.task.id } : {}),
        },
        now,
      );
      if (result && action.until) {
        // 再開日を due 側でなく properties に持つ (due は本来の締切のまま)
        upsertObject(db, {
          type: "Task",
          name: action.task,
          properties: { deferred_until: action.until },
          now,
        });
      }
      return `📋 タスク「${action.task}」を延期として記録しました${untilNote}`;
    }

    case "note": {
      recordEvent(db, "note", action.text, {}, now);
      return null; // メモは会話の一部なので脚注は出さない
    }
  }
}

/** actions を順に適用し、表示する脚注の配列を返す。失敗は握って痕跡を残す。 */
export function applyActions(db: Db, actions: LlmAction[], now: Date = new Date()): string[] {
  const footnotes: string[] = [];
  for (const action of actions) {
    try {
      const note = applyOne(db, action, now);
      if (note) footnotes.push(note);
    } catch (err) {
      recordEvent(
        db,
        "note",
        `action 適用に失敗: ${action.type} (${err instanceof Error ? err.message : String(err)})`,
        { action: action as unknown as Record<string, unknown> },
        now,
      );
    }
  }
  return footnotes;
}
