/**
 * オントロジーの型定義 (architecture.md §2)。
 * Di.Ai.ry の Object + Link 設計を踏襲し、Phase A1 は仕事に必要な最小集合に絞る。
 */

export type ObjectType = "Project" | "Task" | "Person" | "Org" | "Note";

export const TASK_STATUSES = ["todo", "doing", "blocked", "done", "deferred"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(v: string): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v);
}

export interface WorkObject {
  id: string;
  type: ObjectType;
  name: string;
  aliases: string[];
  properties: Record<string, unknown>;
  /** Task のみ意味を持つ。それ以外は null。 */
  status: TaskStatus | null;
  /** Task の締切 (ISO date)。無ければ null。 */
  due: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Predicate = "belongs_to" | "involves" | "blocked_by";

export interface Link {
  id: string;
  predicate: Predicate;
  fromId: string;
  toId: string;
  createdAt: string;
}

export type EventKind =
  | "project_created"
  | "task_created"
  | "task_status"
  | "task_updated"
  | "plan_set"
  | "day_off"
  | "note"
  // --- Slack mention → タスク候補 (requirements.md §4) ---
  | "slack_message_observed"
  | "task_candidate_detected"
  | "task_candidate_approved"
  | "task_candidate_rejected"
  // --- タスク単位の interaction (architecture.md §5) ---
  | "checkpoint_sent";

/** checkpoint_sent の payload.kind。 */
export const CHECK_KINDS = ["start_check", "mid_check", "end_check", "recheck"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface WorkEvent {
  id: number;
  ts: string;
  kind: EventKind;
  summary: string;
  payload: Record<string, unknown>;
}

export interface Turn {
  id: number;
  date: string; // ローカル YYYY-MM-DD
  role: "user" | "assistant";
  content: string;
  at: string;
}
