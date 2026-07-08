/**
 * Dashboard read model。
 * UI はこの snapshot だけを見る。Dashboard から直接 Task を更新しない。
 */
import type { Db } from "../db/client.js";
import { eventsOnDate, recentEvents } from "../db/events.js";
import { taskProjectId } from "../db/links.js";
import { listByType } from "../db/objects.js";
import { getSetting, getWorkEnd, getWorkStart } from "../db/settings.js";
import type { TaskStatus, WorkEvent, WorkObject } from "../db/types.js";
import { listPendingCandidates, type Candidate } from "../agent/candidates.js";
import { plannedChecksForTask } from "../flows/scheduler.js";
import { hhmmToMinutes, localDate, localTime } from "../util/dates.js";

export interface DashboardAction {
  label: string;
  style: "primary" | "secondary" | "accent" | "warn" | "danger" | "neutral";
  action: string;
  disabled?: boolean;
}

export interface DashboardMetric {
  key: "candidates" | "dueToday" | "overdue" | "doing" | "todo";
  label: string;
  count: number;
  note: string;
  actions: DashboardAction[];
}

export interface DashboardCurrent {
  projectName: string;
  taskName: string;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  progressPercent: number;
  context: string;
  nextCheck: { time: string; label: string; detail: string } | null;
}

export interface DashboardContextItem {
  source: string;
  time: string;
  text: string;
  chips: { label: string; tone: "candidate" | "approval" | "plan" | "doing" | "todo" }[];
  actions: DashboardAction[];
}

export interface DashboardService {
  name: "Slack連携" | "Codex App Server" | "最終同期";
  detail: string;
  tone: "ok" | "warn" | "off";
}

export interface DashboardSnapshot {
  generatedAt: string;
  current: DashboardCurrent | null;
  metrics: DashboardMetric[];
  slackContext: DashboardContextItem[];
  services: DashboardService[];
}

export interface DashboardSnapshotOptions {
  now?: Date;
  slackConfigured?: boolean;
  codexAvailable?: boolean | null;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  blocked: "ブロック中",
  done: "完了",
  deferred: "延期中",
};

export function buildDashboardSnapshot(
  db: Db,
  opts: DashboardSnapshotOptions = {},
): DashboardSnapshot {
  const now = opts.now ?? new Date();
  const today = localDate(now);
  const projects = listByType(db, "Project");
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const tasks = listByType(db, "Task");
  const visibleTasks = tasks.filter((t) => t.status !== "done" && t.status !== "deferred");
  const pendingCandidates = listPendingCandidates(db, 20);
  const currentTask = pickCurrentTask(visibleTasks, today);

  return {
    generatedAt: now.toISOString(),
    current: currentTask ? currentFromTask(db, currentTask, projectById, now) : null,
    metrics: buildMetrics(visibleTasks, pendingCandidates, today),
    slackContext: buildSlackContext(db, pendingCandidates),
    services: buildServices(db, opts, now),
  };
}

function pickCurrentTask(tasks: WorkObject[], today: string): WorkObject | null {
  const ordered = [...tasks].sort((a, b) => {
    const ad = a.due ?? "9999-12-31";
    const bd = b.due ?? "9999-12-31";
    return ad.localeCompare(bd) || a.createdAt.localeCompare(b.createdAt);
  });
  return (
    ordered.find((t) => t.status === "doing") ??
    ordered.find((t) => t.due !== null && t.due <= today) ??
    ordered.find((t) => t.status === "todo") ??
    ordered[0] ??
    null
  );
}

function currentFromTask(
  db: Db,
  task: WorkObject,
  projectById: Map<string, WorkObject>,
  now: Date,
): DashboardCurrent {
  const projectName = projectById.get(taskProjectId(db, task.id) ?? "")?.name ?? "Inbox";
  const status = task.status ?? "todo";
  const nextCheck = nextCheckForTask(db, task, now);
  return {
    projectName,
    taskName: task.name,
    title: `${projectName} / ${task.name}`,
    status,
    statusLabel: STATUS_LABEL[status],
    progressPercent: progressPercent(task),
    context: buildCurrentContext(task, nextCheck),
    nextCheck,
  };
}

function progressPercent(task: WorkObject): number {
  const configured = task.properties.progress_percent;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return Math.max(0, Math.min(100, Math.round(configured)));
  }
  switch (task.status) {
    case "done":
      return 100;
    case "doing":
      return 55;
    case "blocked":
      return 35;
    case "deferred":
      return 15;
    case "todo":
    default:
      return 0;
  }
}

function buildCurrentContext(
  task: WorkObject,
  nextCheck: DashboardCurrent["nextCheck"],
): string {
  const due = task.due ? `締切 ${task.due}。` : "";
  if (!nextCheck) return `${due}次の確認予定はありません。Slackで相談すると再計画できます。`;
  return `${due}次は${nextCheck.time}に${nextCheck.label}。未応答なら1回だけ再確認します。`;
}

function nextCheckForTask(
  db: Db,
  task: WorkObject,
  now: Date,
): DashboardCurrent["nextCheck"] {
  const today = localDate(now);
  const nowMin = hhmmToMinutes(localTime(now));
  const sent = new Set(
    eventsOnDate(db, today)
      .filter((e) => e.kind === "checkpoint_sent" && e.payload.taskId === task.id)
      .map((e) => String(e.payload.kind ?? "")),
  );
  const checks = plannedChecksForTask(task, getWorkStart(db), getWorkEnd(db), today)
    .filter((c) => !sent.has(c.kind))
    .sort((a, b) => a.atMinutes - b.atMinutes);
  const next = checks.find((c) => c.atMinutes >= nowMin) ?? checks[0];
  if (!next) return null;
  const label =
    next.kind === "start_check" ? "開始確認" : next.kind === "mid_check" ? "途中確認" : "終了確認";
  return {
    time: minutesToHHMM(next.atMinutes),
    label,
    detail:
      next.kind === "start_check"
        ? "最初の一歩を決める"
        : next.kind === "mid_check"
          ? "進捗、詰まり、延期を確認する"
          : "完了、継続、延期を整理する",
  };
}

function minutesToHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, minutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function buildMetrics(
  tasks: WorkObject[],
  pendingCandidates: Candidate[],
  today: string,
): DashboardMetric[] {
  const dueToday = tasks.filter((t) => t.due === today);
  const overdue = tasks.filter((t) => t.due !== null && t.due < today);
  const doing = tasks.filter((t) => t.status === "doing");
  const todo = tasks.filter((t) => (t.status ?? "todo") === "todo");
  return [
    {
      key: "candidates",
      label: "タスク候補",
      count: pendingCandidates.length,
      note: pendingCandidates[0]?.sourceChannel ? "Slack mention 由来" : "承認待ち候補",
      actions: [{ label: "AIと判断", style: "accent", action: "candidate:judge" }],
    },
    {
      key: "dueToday",
      label: "本日締め切り",
      count: dueToday.length,
      note: dueToday[0]?.name ?? "今日中に判断",
      actions: progressAndDeferActions("dueToday"),
    },
    {
      key: "overdue",
      label: "期限すぎ",
      count: overdue.length,
      note: overdue[0]?.name ?? "昨日以前の未完了",
      actions: progressAndDeferActions("overdue"),
    },
    {
      key: "doing",
      label: "進行中",
      count: doing.length,
      note: doing[0]?.name ?? "今まさに動いている",
      actions: progressAndDeferActions("doing"),
    },
    {
      key: "todo",
      label: "未着手",
      count: todo.length,
      note: todo[0]?.name ?? "まだ始めていない",
      actions: [
        { label: "AIに進捗報告", style: "primary", action: "task:progress:todo" },
        { label: "AIに開始報告", style: "secondary", action: "task:start:todo" },
      ],
    },
  ];
}

function progressAndDeferActions(bucket: string): DashboardAction[] {
  return [
    { label: "AIに進捗報告", style: "primary", action: `task:progress:${bucket}` },
    { label: "AIに延期報告", style: "warn", action: `task:defer:${bucket}` },
  ];
}

function buildSlackContext(db: Db, pendingCandidates: Candidate[]): DashboardContextItem[] {
  const items: DashboardContextItem[] = [];
  for (const c of pendingCandidates.slice(0, 3)) {
    items.push({
      source: `${c.sourceChannel || "Slack"} / ${c.sourceAuthor || "unknown"}`,
      time: timeFromIso(c.detectedAt),
      text: c.sourceText,
      chips: [
        { label: "タスク候補", tone: "candidate" },
        { label: "承認待ち", tone: "approval" },
      ],
      actions: [],
    });
    items.push({
      source: "Man.Ai.ger DM",
      time: timeFromIso(c.detectedAt),
      text: `このmentionをタスク化しますか？ 提案: 「${c.name}」 / Project: ${c.project ?? "未設定"} / Due: ${c.due ?? "未設定"}`,
      chips: [],
      actions: [
        { label: "タスク化する", style: "primary", action: `candidate:approve:${c.id}`, disabled: true },
        { label: "内容を修正", style: "secondary", action: `candidate:revise:${c.id}`, disabled: true },
        { label: "タスク化しない", style: "danger", action: `candidate:reject:${c.id}`, disabled: true },
      ],
    });
  }

  if (items.length > 0) return items;

  const recent = recentEvents(db, 8)
    .filter((e) => e.kind === "slack_message_observed" || e.kind === "coaching_intent")
    .slice(-3);
  if (recent.length === 0) {
    return [
      {
        source: "Man.Ai.ger",
        time: "--:--",
        text: "Slackで拾った確認待ちはありません。",
        chips: [],
        actions: [],
      },
    ];
  }
  return recent.map(contextItemFromEvent);
}

function contextItemFromEvent(e: WorkEvent): DashboardContextItem {
  if (e.kind === "coaching_intent") {
    return {
      source: "Man.Ai.ger DM",
      time: timeFromIso(e.ts),
      text: e.summary,
      chips: [{ label: "相談中", tone: "plan" }],
      actions: [],
    };
  }
  return {
    source: `${String(e.payload.channel ?? "Slack")} / ${String(e.payload.author ?? "unknown")}`,
    time: timeFromIso(e.ts),
    text: String(e.payload.text ?? e.summary),
    chips: [],
    actions: [],
  };
}

function buildServices(
  db: Db,
  opts: DashboardSnapshotOptions,
  now: Date,
): DashboardService[] {
  const slackConfigured = opts.slackConfigured ?? false;
  const owner = getSetting(db, "owner_slack_id");
  const daemonFresh = isDaemonFresh(db, now);
  const newest = recentEvents(db, 1)[0]?.ts;
  const codex = opts.codexAvailable;
  return [
    {
      name: "Slack連携",
      detail: !slackConfigured ? "未設定" : owner && daemonFresh ? "接続中" : owner ? "daemon停止" : "DM待ち",
      tone: !slackConfigured ? "off" : owner && daemonFresh ? "ok" : "warn",
    },
    {
      name: "Codex App Server",
      detail: codex === true ? "利用可" : codex === false ? "未応答" : "未確認",
      tone: codex === true ? "ok" : codex === false ? "off" : "warn",
    },
    {
      name: "最終同期",
      detail: newest ? timeFromIso(newest) : localTime(now),
      tone: "ok",
    },
  ];
}

function isDaemonFresh(db: Db, now: Date): boolean {
  const raw = getSetting(db, "daemon_lock");
  if (!raw) return false;
  try {
    const lock = JSON.parse(raw) as { at?: number };
    return typeof lock.at === "number" && now.getTime() - lock.at < 90_000;
  } catch {
    return false;
  }
}

function timeFromIso(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(11, 16) : "--:--";
}
