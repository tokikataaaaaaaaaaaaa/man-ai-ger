/**
 * Dashboard サブページ (タスク / 会話ログ / 設定) のテスト。
 * read model の内容と、HTTP ルートが有効な HTML を返すことを検証する。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, type Db } from "../db/client.js";
import { upsertObject } from "../db/objects.js";
import { upsertLink } from "../db/links.js";
import { appendTurn } from "../db/turns.js";
import { getSetting, setSetting } from "../db/settings.js";
import { buildTasksView, buildLogView, buildSettingsView } from "./snapshot.js";
import { startDashboardServer, type DashboardServerHandle } from "./server.js";
import { localDate } from "../util/dates.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("buildTasksView", () => {
  it("プロジェクト別にアクティブタスクを並べ、完了は別枠", () => {
    const p = upsertObject(db, { type: "Project", name: "改修" }).object;
    const t1 = upsertObject(db, { type: "Task", name: "API 設計", status: "doing", due: "2026-07-10" }).object;
    upsertLink(db, t1.id, "belongs_to", p.id);
    const t2 = upsertObject(db, { type: "Task", name: "済んだ作業", status: "done" }).object;
    upsertLink(db, t2.id, "belongs_to", p.id);
    upsertObject(db, { type: "Task", name: "無所属の作業" }); // Inbox 扱い

    const view = buildTasksView(db);
    const kaishu = view.active.find((g) => g.projectName === "改修");
    expect(kaishu?.tasks.map((t) => t.name)).toEqual(["API 設計"]);
    expect(kaishu?.tasks[0]?.statusLabel).toBe("進行中");
    expect(view.active.find((g) => g.projectName === "Inbox")?.tasks).toHaveLength(1);
    expect(view.doneRecent.map((t) => t.name)).toEqual(["済んだ作業"]);
  });

  it("延期タスクは deferred_until を表示用に持つ", () => {
    upsertObject(db, {
      type: "Task",
      name: "延期中の作業",
      status: "deferred",
      properties: { deferred_until: "2026-07-15" },
    });
    const view = buildTasksView(db);
    const item = view.active[0]?.tasks[0];
    expect(item?.statusLabel).toBe("延期中");
    expect(item?.deferredUntil).toBe("2026-07-15");
  });

  it("締切に時刻指定があれば dueTime を表示用に持つ", () => {
    upsertObject(db, { type: "Task", name: "資料提出", due: "2026-07-10", dueTime: "17:00" });
    const view = buildTasksView(db);
    const item = view.active[0]?.tasks[0];
    expect(item?.due).toBe("2026-07-10");
    expect(item?.dueTime).toBe("17:00");
  });
});

describe("buildLogView", () => {
  it("会話を日別・新しい日付順で返す", () => {
    appendTurn(db, "user", "おはよう");
    appendTurn(db, "assistant", "おはようございます");
    const days = buildLogView(db);
    expect(days).toHaveLength(1);
    expect(days[0]?.date).toBe(localDate());
    expect(days[0]?.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });
});

describe("buildSettingsView", () => {
  it("日常変更する設定は編集可能、起動時設定は read-only で表示する", () => {
    setSetting(db, "work_start", "10:00");
    const rows = buildSettingsView(db, { home: "/tmp/x", dashboardPort: 7799 });
    const start = rows.find((r) => r.label === "作業開始時刻");
    expect(start?.value).toBe("10:00");
    expect(start?.input?.name).toBe("workStart");
    expect(rows.find((r) => r.label === "連続確認の最小間隔")?.input?.type).toBe("number");
    expect(rows.find((r) => r.label === "データの保存先")?.value).toBe("/tmp/x");
    expect(rows.find((r) => r.label === "データの保存先")?.input).toBeUndefined();
  });
});

describe("HTTP ルート", () => {
  let handle: DashboardServerHandle;
  afterEach(async () => {
    await handle?.stop();
  });

  it("/tasks /log /settings が 200 で、ナビの active が切り替わる", async () => {
    upsertObject(db, { type: "Task", name: "画面実装", status: "todo" });
    upsertObject(db, { type: "Task", name: "資料提出", due: "2026-07-10", dueTime: "17:00" });
    appendTurn(db, "user", "テスト発話");
    handle = await startDashboardServer({
      db,
      port: 7955,
      slackConfigured: false,
      codexAvailable: true,
      settingsInfo: { home: "/tmp/qa", dashboardPort: 7955 },
    });

    const tasks = await get(`${handle.url}tasks`);
    expect(tasks).toContain("画面実装");
    expect(tasks).toContain('class="nav-item active" href="/tasks"');
    expect(tasks).toContain("締切 2026-07-10 17:00"); // due_time は日付に併記する

    const log = await get(`${handle.url}log`);
    expect(log).toContain("テスト発話");
    expect(log).toContain('class="nav-item active" href="/log"');

    const settings = await get(`${handle.url}settings`);
    expect(settings).toContain("作業開始時刻");
    expect(settings).toContain('id="settings-form"');
    expect(settings).toContain('name="workStart"');
    expect(settings).toContain("/tmp/qa");
    // 内部名を出さない
    for (const html of [tasks, log, settings]) {
      expect(html).not.toContain("task_candidate");
      expect(html).not.toContain("approval_required");
    }
  });

  it("POST /api/settings で運用設定を SQLite settings に保存する", async () => {
    handle = await startDashboardServer({
      db,
      port: 7956,
      slackConfigured: false,
      codexAvailable: true,
    });

    const res = await postJson(`${handle.url}api/settings`, {
      workStart: "08:45",
      workEnd: "17:30",
      interactionSpacingMin: "35",
      recheckAfterMin: "50",
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("設定を保存しました。");
    expect(getSetting(db, "work_start")).toBe("08:45");
    expect(getSetting(db, "work_end")).toBe("17:30");
    expect(getSetting(db, "interaction_spacing_min")).toBe("35");
    expect(getSetting(db, "recheck_after_min")).toBe("50");
  });

  it("POST /api/settings は不正値を拒否し、既存設定を保持する", async () => {
    setSetting(db, "work_start", "09:00");
    handle = await startDashboardServer({
      db,
      port: 7957,
      slackConfigured: false,
      codexAvailable: true,
    });

    const res = await postJson(`${handle.url}api/settings`, {
      workStart: "25:00",
      workEnd: "17:30",
      interactionSpacingMin: "0",
      recheckAfterMin: "50",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("作業開始時刻");
    expect(res.body.message).toContain("連続確認の最小間隔");
    expect(getSetting(db, "work_start")).toBe("09:00");
    expect(getSetting(db, "work_end")).toBeNull();
  });
});

/** localhost への GET (テスト専用。製品コードの外部通信ではない)。 */
function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ get: httpGet }) => {
      httpGet(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
  });
}

function postJson(url: string, payload: unknown): Promise<{ status: number; body: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const target = new URL(url);
      const body = JSON.stringify(payload);
      const req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text || "{}") as Record<string, string>,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  });
}
