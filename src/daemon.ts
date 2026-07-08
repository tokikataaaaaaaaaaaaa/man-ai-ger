/**
 * daemon = Slack 接続 + スケジューラ + エージェントの合成 (architecture.md §1)。
 * `manaiger start` から起動される。launchd はこれを常駐させる。
 */
import { openDb } from "./db/client.js";
import { acquireDaemonLock } from "./db/settings.js";
import { CodexAppServerClient } from "./llm/codex.js";
import { createLogger } from "./log.js";
import { loadConfig } from "./config.js";
import { createSlackApp } from "./slack/app.js";
import { startScheduler } from "./flows/scheduler.js";
import { processTurn } from "./agent/run-turn.js";
import { followUpQuickReplies } from "./slack/blocks.js";
import { mkdirSync } from "node:fs";

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.home, { recursive: true });
  const logger = createLogger(config.logPath);

  if (!config.slackBotToken || !config.slackAppToken) {
    logger.error(
      "SLACK_BOT_TOKEN / SLACK_APP_TOKEN が未設定です。README のセットアップ手順をご確認ください (`manaiger doctor` で状態確認できます)",
    );
    process.exitCode = 1;
    return;
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
  const slack = createSlackApp({
    db,
    llm,
    logger,
    botToken: config.slackBotToken,
    appToken: config.slackAppToken,
  });

  const scheduler = startScheduler({
    db,
    onError: (err) => logger.error("scheduler kick failed", { err: String(err) }),
    runKick: async (input) => {
      logger.info("kick", { kind: input.kind });
      await processTurn({ db, llm }, input, async (text) => {
        const quickReplies = followUpQuickReplies(text);
        await slack.sendToOwner(text, quickReplies);
      });
    },
  });

  const shutdown = async (): Promise<void> => {
    logger.info("shutting down");
    scheduler.stop();
    llm.stop();
    await slack.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await slack.start();
  logger.info("manaiger daemon started", { codexPath: config.codexPath, home: config.home });
  // オーナー未登録の案内 (初回のみの体験を明確に)
  // eslint-disable-next-line no-console
  console.log(
    "\nMan.Ai.ger が起動しました。Slack で Bot に DM を送ると、その人がオーナーとして登録されます。\n",
  );
}
