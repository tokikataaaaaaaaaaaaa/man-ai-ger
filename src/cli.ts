#!/usr/bin/env node
/**
 * manaiger CLI (architecture.md §9)。
 *   start  : daemon をフォアグラウンド起動
 *   status : プロジェクト/タスクの現在地
 *   doctor : セットアップ状態の検査
 *   config : working hours の表示・変更
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { openDb } from "./db/client.js";
import { listByType, listActiveTasks } from "./db/objects.js";
import { taskProjectId } from "./db/links.js";
import { recentEvents } from "./db/events.js";
import {
  getWorkStart,
  getWorkEnd,
  getOwnerSlackId,
  setSetting,
} from "./db/settings.js";
import { loadConfig } from "./config.js";
import { isHHMM } from "./util/dates.js";
import { startDaemon } from "./daemon.js";
import { CodexAppServerClient } from "./llm/codex.js";
import type { TaskStatus } from "./db/types.js";

const STATUS_ICON: Record<TaskStatus, string> = {
  todo: "◻︎",
  doing: "◉",
  blocked: "⛔",
  done: "✅",
  deferred: "↷",
};
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "未着手",
  doing: "進行中",
  blocked: "ブロック中",
  done: "完了",
  deferred: "延期中",
};

const program = new Command();
program.name("manaiger").description("Man.Ai.ger — 共感コーチ型マネジメント AI");

program
  .command("start")
  .description("daemon を起動する (Slack 接続 + タスク単位スケジューラ)")
  .action(async () => {
    await startDaemon();
  });

program
  .command("status")
  .description("プロジェクト/タスクの現在地を表示する")
  .option("--all", "完了タスクも表示する")
  .action((opts: { all?: boolean }) => {
    const config = loadConfig();
    if (!existsSync(config.dbPath)) {
      console.log("まだデータがありません。`manaiger start` で daemon を起動し、Slack で Bot に話しかけてください。");
      return;
    }
    const db = openDb(config.dbPath);
    const projects = listByType(db, "Project");
    const tasks = listByType(db, "Task").filter((t) => opts.all || t.status !== "done");
    if (projects.length === 0 && tasks.length === 0) {
      console.log("まだ記録がありません。Slack で Bot に今のお仕事を話してみてください。");
      return;
    }
    const byProject = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const pid = taskProjectId(db, t.id) ?? "?";
      byProject.set(pid, [...(byProject.get(pid) ?? []), t]);
    }
    console.log("");
    for (const p of projects) {
      const pt = byProject.get(p.id) ?? [];
      if (p.name === "Inbox" && pt.length === 0) continue;
      console.log(`■ ${p.name}`);
      if (pt.length === 0) console.log("   (アクティブなタスクなし)");
      for (const t of pt) {
        const s = (t.status ?? "todo") as TaskStatus;
        const due = t.due ? `  (締切 ${t.due})` : "";
        console.log(`   ${STATUS_ICON[s]} ${t.name} — ${STATUS_LABEL[s]}${due}`);
      }
      console.log("");
    }
    const recent = recentEvents(db, 5);
    if (recent.length > 0) {
      console.log("最近の動き:");
      for (const e of recent) console.log(`   ${e.ts.slice(5, 16)}  ${e.summary}`);
    }
  });

program
  .command("doctor")
  .description("セットアップ状態を検査する")
  .action(async () => {
    const config = loadConfig();
    const results: [string, boolean, string][] = [];

    const nodeMajor = Number(process.versions.node.split(".")[0]);
    results.push([
      "Node.js",
      nodeMajor === 22,
      `${process.version}${nodeMajor === 22 ? "" : " (Node.js 22 LTS で起動してください)"}`,
    ]);

    // 1. Codex App Server
    const codex = new CodexAppServerClient({
      codexPath: config.codexPath,
      model: config.codexModel ?? undefined,
      cwd: config.home,
      timeoutMs: 15_000,
    });
    const codexOk = await codex.checkAvailable(15_000);
    codex.stop();
    results.push([
      "Codex App Server",
      codexOk,
      codexOk ? "利用可" : "`codex app-server` が起動・応答できません",
    ]);

    // 2. Slack トークン
    results.push([
      "SLACK_BOT_TOKEN",
      Boolean(config.slackBotToken?.startsWith("xoxb-")),
      config.slackBotToken ? "設定済み" : ".env に xoxb- トークンを設定してください",
    ]);
    results.push([
      "SLACK_APP_TOKEN",
      Boolean(config.slackAppToken?.startsWith("xapp-")),
      config.slackAppToken ? "設定済み" : ".env に xapp- トークンを設定してください",
    ]);

    // 3. DB 書き込み
    let dbOk = true;
    let dbMsg = config.dbPath;
    try {
      const db = openDb(config.dbPath);
      db.prepare("SELECT 1").get();
    } catch (e) {
      dbOk = false;
      dbMsg = String(e);
    }
    results.push(["データベース", dbOk, dbMsg]);

    // 4. オーナー登録
    if (dbOk) {
      const db = openDb(config.dbPath);
      const owner = getOwnerSlackId(db);
      results.push([
        "オーナー登録",
        owner !== null,
        owner ?? "未登録 (daemon 起動後、Slack で Bot に DM すると登録されます)",
      ]);
      results.push([
        "working hours",
        true,
        `${getWorkStart(db)}-${getWorkEnd(db)}`,
      ]);
    }

    console.log("");
    let allOk = true;
    for (const [name, ok, detail] of results) {
      console.log(` ${ok ? "✅" : "❌"} ${name}: ${detail}`);
      if (!ok) allOk = false;
    }
    console.log("");
    console.log(allOk ? "すべて正常です。" : "❌ の項目を解消してから `manaiger start` してください。");
  });

program
  .command("config")
  .description("設定の表示・変更 (例: manaiger config --work-start 08:30)")
  .option("--work-start <HH:MM>", "勤務開始時刻")
  .option("--work-end <HH:MM>", "勤務終了時刻")
  .action((opts: { workStart?: string; workEnd?: string }) => {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    if (opts.workStart) {
      if (!isHHMM(opts.workStart)) {
        console.error(`時刻の形式が不正です: ${opts.workStart} (例: 08:30)`);
        process.exitCode = 1;
        return;
      }
      setSetting(db, "work_start", opts.workStart);
    }
    if (opts.workEnd) {
      if (!isHHMM(opts.workEnd)) {
        console.error(`時刻の形式が不正です: ${opts.workEnd} (例: 19:00)`);
        process.exitCode = 1;
        return;
      }
      setSetting(db, "work_end", opts.workEnd);
    }
    const model = config.codexModel ? ` / model: ${config.codexModel}` : "";
    console.log(`working hours ${getWorkStart(db)}-${getWorkEnd(db)}${model}`);
  });

program.parseAsync().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
