import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/types.js";
import { listByType } from "../db/objects.js";
import { listPendingCandidates, type Candidate } from "../agent/candidates.js";
import { handleCoachingIntent, parseCoachingIntent } from "../agent/coaching.js";
import { processTurn } from "../agent/run-turn.js";
import { followUpQuickReplies, candidateDecisionQuickReplies, type QuickReply } from "../slack/blocks.js";
import { localDate } from "../util/dates.js";
import type { WorkObject } from "../db/types.js";
import {
  buildDashboardSnapshot,
  buildLogView,
  buildSettingsView,
  buildTasksView,
  type DashboardSnapshotOptions,
  type SettingsViewInfo,
} from "./snapshot.js";
import {
  renderDashboardPage,
  renderLogPage,
  renderSettingsPage,
  renderTasksPage,
} from "./render.js";

export interface DashboardServerOptions extends DashboardSnapshotOptions {
  db: Db;
  host?: string;
  port: number;
  sendToOwner?: (text: string, quickReplies?: QuickReply[]) => Promise<void>;
  /** flow:add_task の LLM 呼び出しに使う (任意。無ければ 409)。 */
  llm?: LlmClient;
  /** 設定ページに表示する環境情報 (任意)。 */
  settingsInfo?: SettingsViewInfo;
}

export interface DashboardServerHandle {
  url: string;
  stop: () => Promise<void>;
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void handleRequest(opts, req, res);
  });
  await listen(server, opts.port, host);
  return {
    url: `http://${host}:${opts.port}/`,
    stop: () => close(server),
  };
}

async function handleRequest(
  opts: DashboardServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const snapshot = buildDashboardSnapshot(opts.db, opts);
      sendHtml(res, renderDashboardPage(snapshot));
      return;
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      const snapshot = buildDashboardSnapshot(opts.db, opts);
      sendHtml(res, renderTasksPage(buildTasksView(opts.db), snapshot.services));
      return;
    }
    if (req.method === "GET" && url.pathname === "/log") {
      const snapshot = buildDashboardSnapshot(opts.db, opts);
      sendHtml(res, renderLogPage(buildLogView(opts.db), snapshot.services));
      return;
    }
    if (req.method === "GET" && url.pathname === "/settings") {
      const snapshot = buildDashboardSnapshot(opts.db, opts);
      sendHtml(
        res,
        renderSettingsPage(buildSettingsView(opts.db, opts.settingsInfo ?? {}), snapshot.services),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(res, 200, buildDashboardSnapshot(opts.db, opts));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/intent") {
      const body = await readJsonBody(req);
      const action = typeof body.action === "string" ? body.action : "";
      const result = await handleDashboardIntent(opts, action);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    const status = err instanceof DashboardIntentError ? err.status : 500;
    sendJson(res, status, {
      error: "dashboard_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function handleDashboardIntent(
  opts: Pick<DashboardServerOptions, "db" | "sendToOwner" | "llm">,
  action: string,
): Promise<{ message: string }> {
  if (!opts.sendToOwner) {
    throw new DashboardIntentError(409, "Slack連携が未設定です。Slack Bot DMで操作してください。");
  }

  if (action === "flow:add_task") {
    if (!opts.llm) {
      throw new DashboardIntentError(409, "Codex App Serverが未設定です。`manaiger doctor` で確認してください。");
    }
    const sendToOwner = opts.sendToOwner;
    await processTurn({ db: opts.db, llm: opts.llm }, { kind: "add_task" }, async (text) => {
      await sendToOwner(text, followUpQuickReplies(text));
    });
    return { message: "Slack DMでタスク追加のヒアリングを始めました。" };
  }

  const coaching = parseCoachingIntent(action.replace(/^coach:/, "manaiger:coach:"));
  if (coaching) {
    const result = handleCoachingIntent(opts.db, coaching);
    await opts.sendToOwner(result.reply, result.quickReplies);
    return { message: "Slack DMで相談を開始しました。" };
  }

  if (action === "candidate:judge") {
    const candidate = listPendingCandidates(opts.db, 1)[0];
    if (!candidate) {
      await opts.sendToOwner("現在、承認待ちのタスク候補はありません。");
      return { message: "承認待ちのタスク候補はありません。" };
    }
    await opts.sendToOwner(renderCandidateProposal(candidate), candidateDecisionQuickReplies(candidate.id));
    return { message: "Slack DMへタスク候補を送りました。" };
  }

  const taskAction = /^task:(progress|defer|start):(dueToday|overdue|doing|todo)$/.exec(action);
  if (taskAction) {
    const mode = taskAction[1] as "progress" | "defer" | "start";
    const bucket = taskAction[2] as "dueToday" | "overdue" | "doing" | "todo";
    const task = pickTaskForBucket(opts.db, bucket);
    if (!task) {
      await opts.sendToOwner("この分類に該当するタスクはありません。");
      return { message: "該当するタスクはありません。" };
    }
    const prompt = renderTaskPrompt(task, mode);
    await opts.sendToOwner(prompt.text, prompt.quickReplies);
    return { message: "Slack DMでタスク相談を開始しました。" };
  }

  throw new DashboardIntentError(400, "未対応の操作です。");
}

function renderCandidateProposal(candidate: Candidate): string {
  return [
    "このmentionをタスク化しますか？",
    `提案: 「${candidate.name}」`,
    `Project: ${candidate.project ?? "未設定"}`,
    `Due: ${candidate.due ?? "未設定"}`,
  ].join("\n");
}

function pickTaskForBucket(
  db: Db,
  bucket: "dueToday" | "overdue" | "doing" | "todo",
): WorkObject | null {
  const today = localDate();
  const tasks = listByType(db, "Task")
    .filter((t) => t.status !== "done" && t.status !== "deferred")
    .sort((a, b) => {
      const ad = a.due ?? "9999-12-31";
      const bd = b.due ?? "9999-12-31";
      return ad.localeCompare(bd) || a.createdAt.localeCompare(b.createdAt);
    });
  if (bucket === "dueToday") return tasks.find((t) => t.due === today) ?? null;
  if (bucket === "overdue") return tasks.find((t) => t.due !== null && t.due < today) ?? null;
  if (bucket === "doing") return tasks.find((t) => t.status === "doing") ?? null;
  return tasks.find((t) => (t.status ?? "todo") === "todo") ?? null;
}

function renderTaskPrompt(
  task: WorkObject,
  mode: "progress" | "defer" | "start",
): { text: string; quickReplies: QuickReply[] } {
  if (mode === "progress") {
    return {
      text: `「${task.name}」の進捗を確認します。\n今の状態に近いものを選んでください。`,
      quickReplies: [
        { label: "進んだ", value: `${task.name}は進みました` },
        { label: "詰まった", value: `${task.name}で詰まっています` },
        { label: "後でやる", value: `${task.name}は後でやります` },
      ],
    };
  }
  if (mode === "defer") {
    return {
      text: `「${task.name}」を延期する相談を始めます。\n理由と次に見る時刻だけ決めましょう。`,
      quickReplies: [
        { label: "延期として記録", value: `${task.name}を延期として記録します` },
        { label: "今日5分だけ", value: `${task.name}を今日5分だけ触ります` },
        { label: "理由を書く", value: `${task.name}を今やらない理由を書きます` },
      ],
    };
  }
  return {
    text: `「${task.name}」の開始をSlackで確認します。\n最初の5分で触る場所を1つだけ決めましょう。`,
    quickReplies: [
      { label: "開始しました", value: `${task.name}を開始しました` },
      { label: "5分だけ触る", value: `${task.name}を5分だけ触ります` },
      { label: "詰まりを書く", value: `${task.name}の詰まりを書きます` },
    ],
  };
}

class DashboardIntentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 8_192) reject(new DashboardIntentError(413, "request too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new DashboardIntentError(400, "invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
