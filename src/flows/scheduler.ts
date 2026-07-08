/**
 * タスク単位の interaction スケジューラ (architecture.md §5, behavior-design.md §5)。
 *
 * 朝夕固定ではなく、タスクの開始・途中・終了で interaction を起こす:
 *   start_check : planned_start (既定 = working hours の開始)
 *   mid_check   : start と end の中間 (doing のタスクのみ)
 *   end_check   : planned_end (既定 = working hours の終了。締切当日はこれが締切前確認)
 *   recheck     : 未応答の確認に対して 1 回だけ再確認
 *
 * 発火の設計:
 * - 「時刻一致」でなく「予定時刻を過ぎて未送信なら発火」
 *   → スリープ復帰・再起動でも取りこぼさず、DB の checkpoint_sent event で二重送信しない
 * - 1 tick で送るのは 1 件まで。直近の送信から 20 分は次を送らない (追い詰めない)
 * - day_off を記録した日は以後の interaction を止める
 * - オーナー Slack ID 未確定の間は送信しない
 */
import type { Db } from "../db/client.js";
import { eventsOnDate } from "../db/events.js";
import {
  getOwnerSlackId,
  getWorkStart,
  getWorkEnd,
  heartbeatDaemonLock,
} from "../db/settings.js";
import { listActiveTasks } from "../db/objects.js";
import { hhmmToMinutes, localDate, localTime } from "../util/dates.js";
import type { TurnInput } from "../llm/prompts.js";
import type { CheckKind } from "../db/types.js";
import type { WorkObject } from "../db/types.js";

export interface PlannedCheck {
  taskId: string;
  taskName: string;
  kind: Exclude<CheckKind, "recheck">;
  /** 発火予定 (分, 0:00 起点)。 */
  atMinutes: number;
}

/** Task の properties/working hours から今日の interaction 予定を組み立てる (純関数)。 */
export function plannedChecksForTask(
  task: WorkObject,
  workStart: string,
  workEnd: string,
  today: string,
): PlannedCheck[] {
  if (task.status === "done" || task.status === "deferred" || task.status === "blocked") return [];

  const isDueToday = task.due !== null && task.due <= today;
  const isDoing = task.status === "doing";
  // 対象: 進行中のタスク、または今日が締切 (以前) の未着手タスク
  if (!isDoing && !isDueToday) return [];

  const props = task.properties as { planned_start?: string; planned_end?: string };
  const startHHMM = isHHMMLike(props.planned_start) ? props.planned_start! : workStart;
  const endHHMM = isHHMMLike(props.planned_end) ? props.planned_end! : workEnd;
  const start = hhmmToMinutes(startHHMM);
  const end = Math.max(hhmmToMinutes(endHHMM), start + 30); // end は最低 start+30min
  const mid = Math.floor((start + end) / 2);

  const checks: PlannedCheck[] = [
    { taskId: task.id, taskName: task.name, kind: "start_check", atMinutes: start },
  ];
  if (isDoing) {
    checks.push({ taskId: task.id, taskName: task.name, kind: "mid_check", atMinutes: mid });
  }
  checks.push({ taskId: task.id, taskName: task.name, kind: "end_check", atMinutes: end });
  return checks;
}

function isHHMMLike(v: unknown): v is string {
  return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

const SPACING_MIN = 20; // 連続通知の最小間隔 (分)
const RECHECK_AFTER_MIN = 30; // 未応答の再確認までの時間 (分)

interface SentCheck {
  taskId: string;
  kind: string;
  atMinutes: number;
}

/** この時刻に発火すべき interaction を返す (無ければ null)。純関数的でテスト可能。 */
export function decideInteraction(db: Db, now: Date): TurnInput | null {
  if (!getOwnerSlackId(db)) return null; // 初回 DM 前は誰にも送れない

  const today = localDate(now);
  const nowMin = hhmmToMinutes(localTime(now));
  const todayEvents = eventsOnDate(db, today);

  // day_off の日は以後の interaction を止める
  if (todayEvents.some((e) => e.kind === "day_off")) return null;

  // 直近の送信から SPACING_MIN 分は空ける
  const sent: SentCheck[] = todayEvents
    .filter((e) => e.kind === "checkpoint_sent")
    .map((e) => ({
      taskId: String(e.payload.taskId ?? ""),
      kind: String(e.payload.kind ?? ""),
      atMinutes: hhmmToMinutes(e.ts.slice(11, 16)),
    }));
  const lastSentMin = sent.length > 0 ? Math.max(...sent.map((s) => s.atMinutes)) : -Infinity;
  if (nowMin - lastSentMin < SPACING_MIN) return null;

  const workStart = getWorkStart(db);
  const workEnd = getWorkEnd(db);
  const tasks = listActiveTasks(db);

  // 期限が近い順 → 予定時刻が早い順で候補を集める
  const due: PlannedCheck[] = [];
  for (const t of tasks) {
    for (const c of plannedChecksForTask(t, workStart, workEnd, today)) {
      if (c.atMinutes > nowMin) continue; // まだ予定前
      const already = sent.some((s) => s.taskId === c.taskId && s.kind === c.kind);
      if (already) continue;
      // mid_check は start_check を送った後にだけ意味がある
      if (c.kind === "mid_check" && !sent.some((s) => s.taskId === c.taskId && s.kind === "start_check")) {
        continue;
      }
      due.push(c);
    }
  }
  if (due.length > 0) {
    due.sort((a, b) => a.atMinutes - b.atMinutes);
    const c = due[0]!;
    return { kind: c.kind, taskId: c.taskId, taskName: c.taskName };
  }

  // 未応答の再確認 (1 回だけ): 最後の checkpoint から RECHECK_AFTER_MIN 経過して
  // ユーザーの返信が無い場合、同じ確認をもう一度だけ送る
  const recheck = decideRecheck(db, todayEvents, sent, nowMin, today);
  if (recheck) return recheck;

  return null;
}

function decideRecheck(
  db: Db,
  todayEvents: ReturnType<typeof eventsOnDate>,
  sent: SentCheck[],
  nowMin: number,
  today: string,
): TurnInput | null {
  const checkpoints = todayEvents.filter((e) => e.kind === "checkpoint_sent");
  if (checkpoints.length === 0) return null;
  const last = checkpoints[checkpoints.length - 1]!;
  if (String(last.payload.kind) === "recheck") return null; // 再確認は 1 回まで
  const lastMin = hhmmToMinutes(last.ts.slice(11, 16));
  if (nowMin - lastMin < RECHECK_AFTER_MIN) return null;

  // その checkpoint 以後にユーザー発話があれば応答済み
  const replied = db
    .prepare<[string, string], { c: number }>(
      "SELECT COUNT(*) c FROM turns WHERE date = ? AND role = 'user' AND at > ?",
    )
    .get(today, last.ts);
  if ((replied?.c ?? 0) > 0) return null;

  // 同じタスクへの recheck は 1 日 1 回
  const taskId = String(last.payload.taskId ?? "");
  if (sent.some((s) => s.taskId === taskId && s.kind === "recheck")) return null;

  const kind = String(last.payload.kind ?? "");
  if (kind !== "start_check" && kind !== "mid_check" && kind !== "end_check") return null;
  const taskName = extractTaskName(last.summary);
  return { kind: kind as "start_check" | "mid_check" | "end_check", taskId, taskName };
}

function extractTaskName(summary: string): string {
  const m = /「(.+?)」/.exec(summary);
  return m?.[1] ?? "対象のタスク";
}

export interface SchedulerDeps {
  db: Db;
  /** interaction を 1 回実行する (processTurn を包む)。 */
  runKick: (input: TurnInput) => Promise<void>;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * 30 秒ごとに decideInteraction を評価して実行する。
 * 実行中の再入は防ぐ (LLM 応答中に次 tick が重ならない)。
 * 戻り値の stop() で停止。
 */
export function startScheduler(deps: SchedulerDeps): { stop: () => void } {
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      heartbeatDaemonLock(deps.db, process.pid);
      const input = decideInteraction(deps.db, new Date());
      if (input) await deps.runKick(input);
    } catch (err) {
      deps.onError?.(err);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000);
  // 起動直後にも 1 回評価 (再起動での取りこぼし回復を早く)
  void tick();
  return {
    stop: () => clearInterval(timer),
  };
}
