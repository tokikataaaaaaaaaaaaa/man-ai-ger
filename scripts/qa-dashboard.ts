/**
 * Visual QA 用: seed データで Dashboard を起動する (実 Slack/Codex 不要)。
 * 実行: pnpm exec tsx scripts/qa-dashboard.ts
 */
import { openDb } from "../src/db/client.js";
import { upsertObject } from "../src/db/objects.js";
import { upsertLink } from "../src/db/links.js";
import { recordEvent } from "../src/db/events.js";
import { setOwnerSlackId, setSetting } from "../src/db/settings.js";
import { startDashboardServer } from "../src/dashboard/server.js";
import { localDate } from "../src/util/dates.js";
import { appendTurn } from "../src/db/turns.js";

const db = openDb(":memory:");
setOwnerSlackId(db, "U_QA");
setSetting(db, "work_start", "09:00");
setSetting(db, "work_end", "18:00");
const today = localDate();
const yesterday = localDate(new Date(Date.now() - 86400000));
const nextWeek = localDate(new Date(Date.now() + 5 * 86400000));

// プロジェクトとタスク (全分類を埋める)
const p = upsertObject(db, { type: "Project", name: "請求書システム改修" }).object;
const doing = upsertObject(db, { type: "Task", name: "API 設計", status: "doing", due: today }).object;
upsertLink(db, doing.id, "belongs_to", p.id);
const overdue = upsertObject(db, { type: "Task", name: "レビュー指摘の反映", status: "todo", due: yesterday }).object;
upsertLink(db, overdue.id, "belongs_to", p.id);
const todo1 = upsertObject(db, { type: "Task", name: "画面実装", status: "todo", due: nextWeek }).object;
upsertLink(db, todo1.id, "belongs_to", p.id);
upsertObject(db, { type: "Task", name: "社内wikiの目次整理", status: "todo" });
upsertObject(db, { type: "Task", name: "リリースノート下書き", status: "doing" });

// 進捗イベント + checkpoint (現在マネジメント中の文脈)
recordEvent(db, "plan_set", "10時に API 設計 (エンドポイント一覧) から着手", { task: "API 設計" });
recordEvent(db, "checkpoint_sent", "「API 設計」の開始確認を送信", { taskId: doing.id, kind: "start_check", date: today });

// Slack mention → タスク候補 (承認待ち)
recordEvent(db, "slack_message_observed", "#backend / Tanaka: 請求APIの認証方式、今日中に決めたいです。レビューできますか？", {
  channel: "#backend", author: "Tanaka", text: "請求APIの認証方式、今日中に決めたいです。レビューできますか？",
});
recordEvent(db, "task_candidate_detected", "タスク候補: 「請求APIの認証方式を決める」 (#backend / Tanaka)", {
  candidateId: "qa-cand-1", name: "請求APIの認証方式を決める", project: "請求書システム改修", due: today,
  sourceChannel: "#backend", sourceAuthor: "Tanaka",
  sourceText: "請求APIの認証方式、今日中に決めたいです。レビューできますか？",
});

// 会話ログページ用の seed
appendTurn(db, "assistant", "「API 設計」の開始予定の時刻です。最初に触るのはどこにしますか？");
appendTurn(db, "user", "エンドポイント一覧から始めます。10時から");
appendTurn(db, "assistant", "では10時にエンドポイント一覧からですね。13:30ごろに様子を伺います。");

const handle = await startDashboardServer({
  db,
  port: Number(process.env.QA_PORT ?? 7891),
  slackConfigured: true,
  codexAvailable: true,
  settingsInfo: { home: "~/.manaiger", codexModel: null, dashboardPort: Number(process.env.QA_PORT ?? 7891) },
  sendToOwner: async (text) => console.log("[to owner]", text.slice(0, 60)),
});
console.log(`QA dashboard: ${handle.url}`);
