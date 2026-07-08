/**
 * daemon = Slack 接続 + スケジューラ + Dashboard の合成 (architecture.md §1)。
 * `manaiger start` から起動される。launchd はこれを常駐させる。
 *
 * Slack トークン未設定でも Dashboard だけは起動する (縮退起動)。
 * Service 表示が「Slack連携: 未設定」を示し、ユーザーが次の一手を判断できる。
 */
import { openDb } from "./db/client.js";
import { acquireDaemonLock } from "./db/settings.js";
import { CodexAppServerClient } from "./llm/codex.js";
import { createLogger } from "./log.js";
import { loadConfig } from "./config.js";
import { createSlackApp, type SlackRuntime } from "./slack/app.js";
import { startScheduler } from "./flows/scheduler.js";
import { processTurn } from "./agent/run-turn.js";
import { followUpQuickReplies } from "./slack/blocks.js";
import { startDashboardServer, type DashboardServerHandle } from "./dashboard/server.js";
import { mkdirSync } from "node:fs";

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.home, { recursive: true });
  const logger = createLogger(config.logPath);

  const slackConfigured = Boolean(config.slackBotToken && config.slackAppToken);
  if (!slackConfigured) {
    logger.error(
      "SLACK_BOT_TOKEN / SLACK_APP_TOKEN が未設定です。Dashboard のみで起動します (`manaiger doctor` で状態確認できます)",
    );
  }

  const db = openDb(config.dbPath);
  if (!acquireDaemonLock(db, process.pid)) {
    logger.error("別の manaiger daemon が稼働中のため終了します (二重送信防止)");
    process.exitCode = 1;
    return;
  }

  // daemon を絶対に落とさない (architecture.md §8)
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: String(reason) });
  });
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", { err: String(err) });
  });

  const llm = new CodexAppServerClient({
    codexPath: config.codexPath,
    model: config.codexModel ?? undefined,
    cwd: config.home,
  });

  let slack: SlackRuntime | null = null;
  let scheduler: { stop: () => void } | null = null;
  if (slackConfigured) {
    slack = createSlackApp({
      db,
      llm,
      logger,
      botToken: config.slackBotToken!,
      appToken: config.slackAppToken!,
    });
    const slackRef = slack;
    scheduler = startScheduler({
      db,
      onError: (err) => logger.error("scheduler kick failed", { err: String(err) }),
      runKick: async (input) => {
        logger.info("kick", { kind: input.kind });
        await processTurn({ db, llm }, input, async (text) => {
          const quickReplies = followUpQuickReplies(text);
          await slackRef.sendToOwner(text, quickReplies);
        });
      },
    });
  }

  // Dashboard (local web UI)。Codex の利用可否は起動時に 1 回検査してキャッシュし、
  // snapshot 生成のたびに App Server を叩かない。
  let codexAvailable: boolean | null = null;
  let dashboard: DashboardServerHandle | null = null;
  try {
    dashboard = await startDashboardServer({
      db,
      port: config.dashboardPort,
      slackConfigured,
      get codexAvailable() {
        return codexAvailable;
      },
      settingsInfo: {
        home: config.home,
        codexModel: config.codexModel,
        dashboardPort: config.dashboardPort,
      },
      ...(slack
        ? { sendToOwner: (text: string, quickReplies?: Parameters<SlackRuntime["sendToOwner"]>[1]) => slack.sendToOwner(text, quickReplies) }
        : {}),
    });
    logger.info("dashboard started", { url: dashboard.url });
  } catch (err) {
    // Dashboard が立たなくても Slack Bot は動かし続ける (ポート競合等)
    logger.error("dashboard start failed", { err: String(err), port: config.dashboardPort });
  }

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    scheduler?.stop();
    llm.stop();
    await dashboard?.stop().catch(() => undefined);
    await slack?.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (slack) await slack.start();
  logger.info("manaiger daemon started", {
    codexPath: config.codexPath,
    home: config.home,
    slackConfigured,
  });
  void llm.checkAvailable().then((ok) => {
    codexAvailable = ok;
    if (!ok) logger.error("Codex App Server が利用できません (`manaiger doctor` で確認してください)");
  });

  // 起動体験の案内 (状態に応じて次の一手を変える)
  const nextStep = slackConfigured
    ? "Slack で Bot に DM を送ると、その人がオーナーとして登録されます。"
    : "Slack 連携は未設定です。README の手順で Slack App を作成し .env にトークンを設定すると、Bot が動き始めます。";
  // eslint-disable-next-line no-console
  console.log(`\nMan.Ai.ger が起動しました。${nextStep}\nDashboard: ${dashboard?.url ?? "(起動失敗)"}\n`);
}
