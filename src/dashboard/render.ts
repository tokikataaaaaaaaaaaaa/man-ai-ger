import { COACHING_OPTIONS } from "../agent/coaching.js";
import type {
  DashboardAction,
  DashboardContextItem,
  DashboardCurrent,
  DashboardMetric,
  DashboardService,
  DashboardSnapshot,
  LogDay,
  SettingsRow,
  TasksView,
  TaskPageItem,
} from "./snapshot.js";

export type PageKey = "dashboard" | "tasks" | "log" | "settings";

const NAV_ITEMS: { key: PageKey; href: string; icon: string; label: string }[] = [
  { key: "dashboard", href: "/", icon: "■", label: "ダッシュボード" },
  { key: "tasks", href: "/tasks", icon: "●", label: "タスク" },
  { key: "log", href: "/log", icon: "◇", label: "会話ログ" },
  { key: "settings", href: "/settings", icon: "□", label: "設定" },
];

/** 全ページ共通のシェル (サイドバー + サービス + 30 秒自動同期)。 */
function renderShell(page: PageKey, title: string, services: DashboardService[], content: string): string {
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a class="nav-item${item.key === page ? " active" : ""}" href="${item.href}"><span class="nav-icon">${item.icon}</span>${item.label}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="app">
    <aside class="sidebar" aria-label="Navigation">
      <div class="brand">
        <div class="mark" aria-hidden="true">MA</div>
        <div>
          <div class="brand-title">Man.Ai.ger</div>
          <div class="brand-sub">Local work coach</div>
        </div>
      </div>
      <nav class="nav">${nav}</nav>
      <div class="status-rail">
        <div class="sidebar-label">サービス</div>
        <div class="service-list">${services.map(renderService).join("")}</div>
      </div>
    </aside>
    <main class="main">${content}</main>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script>${JS}</script>
</body>
</html>`;
}

export function renderDashboardPage(snapshot: DashboardSnapshot): string {
  const content = `<section class="content-grid">
    <div class="left-stack">
      ${renderCurrent(snapshot.current)}
      <section class="summary-grid" aria-label="Task overview">
        ${snapshot.metrics.map(renderMetric).join("")}
      </section>
    </div>
    <aside class="right-stack" aria-label="Slack context">
      <section class="panel" aria-labelledby="conversation">
        <div class="panel-head">
          <div>
            <div id="conversation" class="panel-title">Slack Context</div>
            <div class="panel-meta">確認専用 / 入力と承認はSlack</div>
          </div>
        </div>
        <div class="conversation">${snapshot.slackContext.map(renderContextItem).join("")}</div>
      </section>
    </aside>
  </section>`;
  return renderShell("dashboard", "Man.Ai.ger Dashboard", snapshot.services, content);
}

// --- タスクページ -------------------------------------------------------------

export function renderTasksPage(view: TasksView, services: DashboardService[]): string {
  const groups =
    view.active.length === 0
      ? `<div class="empty-state"><h2>タスクはまだありません</h2><p>SlackでBotに仕事を話すと、ここに一覧が育ちます。</p></div>`
      : view.active
          .map(
            (g) => `<section class="panel task-group">
      <div class="panel-head"><div><div class="panel-title">${escapeHtml(g.projectName)}</div><div class="panel-meta">${g.tasks.length} 件</div></div></div>
      <div class="task-list">${g.tasks.map(renderTaskRow).join("")}</div>
    </section>`,
          )
          .join("");
  const done =
    view.doneRecent.length === 0
      ? ""
      : `<section class="panel task-group">
      <div class="panel-head"><div><div class="panel-title">最近の完了</div><div class="panel-meta">直近 ${view.doneRecent.length} 件</div></div></div>
      <div class="task-list">${view.doneRecent.map(renderTaskRow).join("")}</div>
    </section>`;
  return renderShell("tasks", "タスク — Man.Ai.ger", services, `<div class="page-stack">${groups}${done}</div>`);
}

function renderTaskRow(t: TaskPageItem): string {
  const due = t.due ? `<span class="task-due">締切 ${escapeHtml(t.due)}</span>` : "";
  const deferred = t.deferredUntil
    ? `<span class="task-due">再開 ${escapeHtml(t.deferredUntil)}</span>`
    : "";
  return `<div class="task-row">
    <span class="pill ${t.statusTone}">${escapeHtml(t.statusLabel)}</span>
    <span class="task-name">${escapeHtml(t.name)}</span>
    ${due}${deferred}
  </div>`;
}

// --- 会話ログページ -----------------------------------------------------------

export function renderLogPage(days: LogDay[], services: DashboardService[]): string {
  const content =
    days.length === 0
      ? `<div class="empty-state"><h2>会話ログはまだありません</h2><p>SlackでBotと話すと、日別の全往復がここに残ります。</p></div>`
      : days
          .map(
            (d) => `<section class="panel task-group">
      <div class="panel-head"><div><div class="panel-title">${escapeHtml(d.date)}</div><div class="panel-meta">${d.turns.length} メッセージ</div></div></div>
      <div class="conversation">${d.turns
        .map(
          (t) => `<div class="message">
        <div class="message-meta"><span>${t.role === "user" ? "あなた" : "Man.Ai.ger"}</span><span>${escapeHtml(t.time)}</span></div>
        <div class="bubble${t.role === "user" ? " user" : ""}">${escapeHtml(t.content)}</div>
      </div>`,
        )
        .join("")}</div>
    </section>`,
          )
          .join("");
  return renderShell("log", "会話ログ — Man.Ai.ger", services, `<div class="page-stack">${content}</div>`);
}

// --- 設定ページ ---------------------------------------------------------------

export function renderSettingsPage(rows: SettingsRow[], services: DashboardService[]): string {
  const list = rows
    .map(
      (r) => `<div class="settings-row">
    <div class="settings-label">${escapeHtml(r.label)}</div>
    <div class="settings-value">${escapeHtml(r.value)}</div>
    ${r.hint ? `<div class="settings-hint">${escapeHtml(r.hint)}</div>` : ""}
  </div>`,
    )
    .join("");
  const content = `<div class="page-stack"><section class="panel task-group">
    <div class="panel-head"><div><div class="panel-title">設定</div><div class="panel-meta">変更はターミナル (manaiger config) か .env で行います</div></div></div>
    <div class="settings-list">${list}</div>
  </section></div>`;
  return renderShell("settings", "設定 — Man.Ai.ger", services, content);
}

function renderCurrent(current: DashboardCurrent | null): string {
  if (!current) {
    return `<section class="panel" aria-labelledby="active-management">
      <div class="panel-head"><div><div id="active-management" class="panel-title">現在マネジメント中</div></div></div>
      <div class="empty-state">
        <h2>管理中のタスクはありません</h2>
        <p>SlackでBotに仕事を話すか、mentionからタスク候補が作られるとここに表示されます。</p>
        ${renderCoachButtons()}
      </div>
    </section>`;
  }
  return `<section class="panel" aria-labelledby="active-management">
    <div class="panel-head">
      <div><div id="active-management" class="panel-title">現在マネジメント中</div></div>
      <span class="pill ${pillClass(current.status)}">${escapeHtml(current.statusLabel)}</span>
    </div>
    <div class="management-grid">
      <div class="focus">
        <div class="focus-top">
          <div>
            <h2>${escapeHtml(current.title)}</h2>
            <div class="focus-context">${escapeHtml(current.context)}</div>
          </div>
          <span class="pill doing">${current.progressPercent}%</span>
        </div>
        <div class="progress-wrap">
          <div class="panel-meta">進捗 ${current.progressPercent}%</div>
          <div class="bar" aria-label="Progress"><span style="width:${current.progressPercent}%"></span></div>
        </div>
        ${renderCoachButtons()}
      </div>
      <div class="coach-box">
        <div>
          <div class="label">次の確認</div>
          <div class="time">${escapeHtml(current.nextCheck?.time ?? "--:--")}</div>
        </div>
        <p>${escapeHtml(current.nextCheck?.detail ?? "Slackで相談すると再計画できます。")}</p>
      </div>
    </div>
  </section>`;
}

function renderCoachButtons(): string {
  const buttons = COACHING_OPTIONS.map((o, i) => {
    const styles = ["danger", "warn", "secondary", "accent", "neutral"] as const;
    return `<button type="button" class="action-button ${styles[i] ?? "neutral"}" data-action="coach:${o.intent}">${escapeHtml(o.label)}</button>`;
  }).join("");
  return `<div class="consult">
    <div class="consult-title">AIへの相談 <span>Slack bot</span></div>
    <div class="consult-grid">${buttons}</div>
  </div>`;
}

function renderMetric(metric: DashboardMetric): string {
  return `<article class="metric">
    <div class="metric-label">${escapeHtml(metric.label)}</div>
    <div class="metric-value">${metric.count}</div>
    <div class="metric-note">${escapeHtml(metric.note)}</div>
    <div class="metric-actions">${metric.actions.map(renderAction).join("")}</div>
  </article>`;
}

function renderContextItem(item: DashboardContextItem): string {
  const chips = item.chips.length > 0
    ? `<div class="action-strip">${item.chips.map((c) => `<span class="pill ${c.tone}">${escapeHtml(c.label)}</span>`).join("")}</div>`
    : "";
  const actions = item.actions.length > 0
    ? `<div class="action-strip">${item.actions.map(renderAction).join("")}</div>`
    : "";
  return `<div class="message">
    <div class="message-meta"><span>${escapeHtml(item.source)}</span><span>${escapeHtml(item.time)}</span></div>
    <div class="bubble">${escapeHtml(item.text)}</div>
    ${chips}
    ${actions}
  </div>`;
}

function renderAction(action: DashboardAction): string {
  const disabled = action.disabled ? " disabled aria-disabled=\"true\" title=\"Slackで操作してください\"" : "";
  const data = action.disabled ? "" : ` data-action="${escapeHtml(action.action)}"`;
  return `<button type="button" class="action-button ${action.style}"${data}${disabled}>${escapeHtml(action.label)}</button>`;
}

function renderService(service: DashboardService): string {
  return `<div class="service-row"><span class="dot ${service.tone}"></span><strong>${escapeHtml(service.name)}</strong><span>${escapeHtml(service.detail)}</span></div>`;
}

function pillClass(status: string): string {
  return status === "doing" ? "doing" : status === "blocked" ? "blocked" : status === "done" ? "done" : "todo";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --surface: #fff;
  --surface-soft: #f1f4ef;
  --ink: #1f2522;
  --muted: #65716b;
  --line: #d9ded7;
  --green: #2f7d62;
  --green-soft: #e6f1ec;
  --amber: #a86618;
  --amber-soft: #fff1dc;
  --red: #aa3f3a;
  --red-soft: #fbe8e5;
  --blue: #386fb1;
  --blue-soft: #e7effb;
  --violet: #7657a8;
  --violet-soft: #eee8f8;
  --shadow: 0 1px 2px rgba(31, 37, 34, .08);
  --radius: 8px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  letter-spacing: 0;
  overflow-x: hidden;
}
button { font: inherit; }
.app { min-height: 100vh; display: grid; grid-template-columns: 232px minmax(0, 1fr); }
.sidebar { border-right: 1px solid var(--line); background: #fbfcfa; padding: 18px 14px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 4px 20px; }
.mark { width: 34px; height: 34px; border-radius: 7px; background: linear-gradient(135deg, #2f7d62, #386fb1); display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 14px; }
.brand-title { font-size: 15px; font-weight: 750; line-height: 1.2; }
.brand-sub { color: var(--muted); font-size: 11px; margin-top: 2px; }
.nav { display: grid; gap: 4px; margin-bottom: 18px; }
.nav-item { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 0 10px; border-radius: 7px; color: #3a433e; font-size: 13px; text-decoration: none; }
.nav-item:hover { background: #f0f3ee; }
.nav-item.active { background: var(--green-soft); color: #1f5d49; font-weight: 700; }
.nav-icon { width: 18px; height: 18px; display: grid; place-items: center; color: inherit; font-size: 13px; flex: none; }
.status-rail { border-top: 1px solid var(--line); padding: 14px 4px 0; margin-top: 12px; display: grid; gap: 10px; }
.sidebar-label { color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; }
.service-list { display: grid; gap: 7px; }
.service-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 26px; color: #3a433e; font-size: 12px; }
.service-row strong { overflow-wrap: anywhere; }
.service-row span:last-child { color: var(--muted); font-size: 11px; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); }
.dot.warn { background: var(--amber); }
.dot.off { background: var(--red); }
.main { min-width: 0; padding: 18px 22px 28px; }
.content-grid { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(320px, .9fr); gap: 16px; align-items: start; min-width: 0; }
.left-stack, .right-stack { display: grid; gap: 16px; min-width: 0; }
.panel, .metric { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.panel-head { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.panel-head > div { min-width: 0; }
.panel-title { font-size: 14px; font-weight: 760; }
.panel-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.management-grid { padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 14px; min-width: 0; }
.focus { display: grid; gap: 12px; min-width: 0; }
.focus-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.focus-top > div { min-width: 0; }
.focus h2, .empty-state h2 { margin: 0; font-size: 20px; line-height: 1.28; overflow-wrap: anywhere; }
.focus-context, .empty-state p { color: var(--muted); font-size: 13px; margin: 4px 0 0; line-height: 1.5; overflow-wrap: anywhere; }
.progress-wrap { display: grid; gap: 6px; }
.bar { width: 100%; height: 10px; background: #edf0eb; border-radius: 999px; overflow: hidden; }
.bar > span { display: block; height: 100%; background: linear-gradient(90deg, var(--green), var(--blue)); border-radius: inherit; }
.consult { border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 10px; }
.consult-title { display: flex; justify-content: space-between; gap: 10px; align-items: center; font-size: 13px; font-weight: 750; }
.consult-title span { color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.consult-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.consult-grid .action-button { width: 100%; justify-content: center; min-height: 34px; white-space: normal; line-height: 1.2; text-align: center; }
.coach-box { background: #24352d; color: #fff; border-radius: 8px; padding: 13px; display: grid; align-content: space-between; gap: 16px; }
.coach-box .label { color: #c8d6ce; font-size: 12px; font-weight: 700; }
.coach-box .time { font-size: 28px; font-weight: 780; line-height: 1; margin-top: 6px; }
.coach-box p { margin: 0; font-size: 13px; line-height: 1.55; color: #edf5f0; overflow-wrap: anywhere; }
.summary-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.metric { padding: 12px; min-height: 90px; }
.metric-label { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
.metric-value { font-size: 26px; font-weight: 780; line-height: 1; }
.metric-note { margin-top: 8px; color: var(--muted); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
.metric-actions, .action-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.conversation { padding: 14px; display: grid; gap: 12px; }
.message { display: grid; gap: 6px; }
.message-meta { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
.bubble { border: 1px solid var(--line); background: #fbfcfa; border-radius: 8px; padding: 10px 11px; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.empty-state { padding: 18px 14px; display: grid; gap: 14px; }
.pill { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.pill.doing { background: var(--green-soft); color: #23634e; }
.pill.todo { background: var(--blue-soft); color: #2c5b94; }
.pill.blocked { background: var(--red-soft); color: #9a342f; }
.pill.done { background: #e8ece7; color: #59635d; }
.pill.plan, .pill.candidate { background: var(--violet-soft); color: #634693; }
.pill.approval { background: var(--amber-soft); color: #8a580f; }
.action-button { border: 1px solid var(--line); background: #fff; min-height: 30px; padding: 0 10px; border-radius: 6px; display: inline-flex; align-items: center; font-size: 12px; font-weight: 700; color: var(--ink); box-shadow: var(--shadow); cursor: pointer; white-space: nowrap; }
.action-button.primary { background: var(--green-soft); border-color: #c7e1d6; color: #1f5d49; }
.action-button.secondary { background: var(--blue-soft); border-color: #cddcf0; color: #2c5b94; }
.action-button.accent { background: var(--violet-soft); border-color: #ddd1ef; color: #634693; }
.action-button.warn { background: var(--amber-soft); border-color: #f1d7b0; color: #8a580f; }
.action-button.danger { background: var(--red-soft); border-color: #efcec9; color: #9a342f; }
.action-button.neutral { background: #fff; border-color: var(--line); color: #3a433e; }
.action-button:disabled { cursor: not-allowed; opacity: .72; }
.page-stack { display: grid; gap: 16px; max-width: 860px; }
.task-list, .settings-list { padding: 6px 14px 14px; display: grid; }
.task-row { display: flex; align-items: center; gap: 10px; min-height: 44px; border-bottom: 1px solid var(--surface-soft); flex-wrap: wrap; padding: 6px 0; }
.task-row:last-child { border-bottom: 0; }
.task-name { font-size: 13.5px; overflow-wrap: anywhere; min-width: 0; flex: 1; }
.task-due { color: var(--muted); font-size: 12px; white-space: nowrap; }
.settings-row { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 2px 14px; padding: 12px 0; border-bottom: 1px solid var(--surface-soft); align-items: baseline; }
.settings-row:last-child { border-bottom: 0; }
.settings-label { color: var(--muted); font-size: 12.5px; font-weight: 700; }
.settings-value { font-size: 13.5px; overflow-wrap: anywhere; }
.settings-hint { grid-column: 2; color: var(--muted); font-size: 12px; }
@media (max-width: 560px) { .settings-row { grid-template-columns: 1fr; } .settings-hint { grid-column: 1; } }
.toast { position: fixed; right: 18px; bottom: 18px; max-width: min(420px, calc(100vw - 36px)); background: #1f2522; color: #fff; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.45; box-shadow: 0 8px 28px rgba(31, 37, 34, .18); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .16s ease, transform .16s ease; }
.toast.show { opacity: 1; transform: translateY(0); }
@media (max-width: 1180px) { .content-grid { grid-template-columns: 1fr; } }
@media (max-width: 860px) {
  .app { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .status-rail { display: none; }
  .management-grid { grid-template-columns: 1fr; }
  .summary-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .main { padding: 14px 12px 22px; }
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .consult-grid { grid-template-columns: 1fr; }
  .focus-top { display: grid; gap: 8px; }
  .focus-top > .pill { justify-self: start; }
  .focus h2, .empty-state h2 { font-size: 18px; }
  .action-button { white-space: normal; text-align: center; }
}
`;

const JS = `
(function () {
  function toast(message) {
    var el = document.getElementById("toast");
    el.textContent = message;
    el.className = "toast show";
    window.clearTimeout(window.__manaigerToastTimer);
    window.__manaigerToastTimer = window.setTimeout(function () {
      el.className = "toast";
    }, 2600);
  }
  function postAction(action) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/intent", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function () {
      var message = "Slack DMへ送りました。";
      try {
        var body = JSON.parse(xhr.responseText || "{}");
        if (body.message) message = body.message;
      } catch (_) {}
      toast(message);
      if (xhr.status >= 200 && xhr.status < 300) {
        window.setTimeout(function () { window.location.reload(); }, 900);
      }
    };
    xhr.onerror = function () { toast("Slack DMへ送れませんでした。"); };
    xhr.send(JSON.stringify({ action: action }));
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var action = target.getAttribute("data-action");
    if (!action) return;
    postAction(action);
  });
  window.setTimeout(function () { window.location.reload(); }, 30000);
})();
`;
