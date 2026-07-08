/**
 * Slack (Bolt + Socket Mode) の配線 (architecture.md §6)。
 *
 * - DM のみ購読。オーナー (最初に DM してきた人) 以外は丁重に断る
 * - ボタン押下 = value をユーザー発話として同一パイプラインに流す
 * - ユーザー入力はキューで直列化 (連投しても DB/文脈が競合しない)
 */
import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../log.js";
import { buildContext, processTurn } from "../agent/run-turn.js";
import { listActiveTasks } from "../db/objects.js";
import { deleteSetting, getOwnerSlackId, getSetting, setOwnerSlackId, setSetting } from "../db/settings.js";
import {
  approveCandidate,
  detectCandidate,
  getCandidate,
  parseCandidateRevisionText,
  rejectCandidate,
  reviseCandidate,
  type Candidate,
} from "../agent/candidates.js";
import {
  candidateDecisionQuickReplies,
  textBlocks,
  quickReplyBlock,
  parseCandidateCommand,
  pressedBlocks,
  followUpQuickReplies,
  validateBlocks,
  type CandidateCommand,
  type SlackBlock,
  type QuickReply,
} from "./blocks.js";

export interface SlackAppDeps {
  db: Db;
  llm: LlmClient;
  logger: Logger;
  botToken: string;
  appToken: string;
}

export interface SlackRuntime {
  app: InstanceType<typeof App>;
  /** オーナーに DM を送る (scheduler のキックが使う)。 */
  sendToOwner: (text: string, quickReplies?: QuickReply[]) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const PENDING_CANDIDATE_REVISION_KEY = "pending_candidate_revision";

export function isOwnerMention(text: string, ownerSlackId: string): boolean {
  return text.includes(`<@${ownerSlackId}>`);
}

function renderCandidateProposal(candidate: Candidate): string {
  return [
    "このmentionをタスク化しますか？",
    `提案: 「${candidate.name}」`,
    `Project: ${candidate.project ?? "未設定"}`,
    `Due: ${candidate.due ?? "未設定"}`,
  ].join("\n");
}

function renderRevisionRequest(candidate: Candidate): string {
  return [
    `「${candidate.name}」の内容を修正します。`,
    "修正後のタスク名を送ってください。",
    "Project / Due も変える場合は `Project: ... / Due: YYYY-MM-DD` の形式で追記できます。",
  ].join("\n");
}

export function createSlackApp(deps: SlackAppDeps): SlackRuntime {
  const { db, llm, logger } = deps;
  const app = new App({
    token: deps.botToken,
    appToken: deps.appToken,
    socketMode: true,
    // Bolt 既定の verbose ログを抑制
    logLevel: LogLevel.ERROR,
  });

  // ユーザー入力の直列化キュー (架空の同時押し・連投対策)
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    queue = queue.then(job, job);
    return queue;
  };

  const declinedUsers = new Set<string>();

  /** テキストを blocks 付きで DM チャンネルへ送る。 */
  async function post(channel: string, text: string, quickReplies?: QuickReply[]): Promise<void> {
    const blocks: SlackBlock[] = [...textBlocks(text)];
    const qr = quickReplies ? quickReplyBlock(quickReplies) : null;
    if (qr) blocks.push(qr);
    const problems = validateBlocks(blocks);
    if (problems.length > 0) {
      // 制約違反ブロックは捨ててプレーンテキストで送る (絶対に沈黙しない)
      logger.error("block validation failed", { problems });
      await app.client.chat.postMessage({ channel, text });
      return;
    }
    await app.client.chat.postMessage({ channel, text, blocks });
  }

  /** ユーザー発話 1 件をパイプラインに流す。 */
  async function handleUserText(channel: string, text: string): Promise<void> {
    await enqueue(async () => {
      try {
        const candidateCommand = parseCandidateCommand(text);
        if (candidateCommand) {
          await handleCandidateCommand(channel, candidateCommand);
          return;
        }

        if (await handlePendingCandidateRevision(channel, text)) return;

        await processTurn({ db, llm }, { kind: "user", text }, async (reply) => {
          const replies = followUpQuickReplies(reply, listActiveTasks(db).map((t) => t.name));
          await post(channel, reply, replies);
        });
      } catch (err) {
        logger.error("turn failed", { err: String(err) });
      }
    });
  }

  async function handleCandidateCommand(
    channel: string,
    command: CandidateCommand,
  ): Promise<void> {
    const candidate = getCandidate(db, command.candidateId);
    if (!candidate) {
      await post(channel, "このタスク候補は処理済みです。");
      return;
    }

    if (command.decision === "approve") {
      deleteSetting(db, PENDING_CANDIDATE_REVISION_KEY);
      const footnote = approveCandidate(db, candidate);
      await post(channel, `タスク化しました。\n\n${footnote}`);
      return;
    }

    if (command.decision === "reject") {
      deleteSetting(db, PENDING_CANDIDATE_REVISION_KEY);
      rejectCandidate(db, candidate);
      await post(channel, "タスク化しませんでした。必要ならまた拾います。");
      return;
    }

    setSetting(db, PENDING_CANDIDATE_REVISION_KEY, candidate.id);
    await post(channel, renderRevisionRequest(candidate));
  }

  async function handlePendingCandidateRevision(channel: string, text: string): Promise<boolean> {
    const candidateId = getSetting(db, PENDING_CANDIDATE_REVISION_KEY);
    if (!candidateId) return false;
    const candidate = getCandidate(db, candidateId);
    if (!candidate) {
      deleteSetting(db, PENDING_CANDIDATE_REVISION_KEY);
      await post(channel, "このタスク候補は処理済みです。");
      return true;
    }
    const patch = parseCandidateRevisionText(text);
    if (!patch.name && patch.project === undefined && patch.due === undefined) {
      await post(channel, "修正内容を読み取れませんでした。修正後のタスク名を1行で送ってください。");
      return true;
    }
    const revised = reviseCandidate(db, candidate, patch);
    deleteSetting(db, PENDING_CANDIDATE_REVISION_KEY);
    await post(channel, renderCandidateProposal(revised), candidateDecisionQuickReplies(revised.id));
    return true;
  }

  async function handleObservedSlackMessage(
    channel: string,
    author: string,
    text: string,
  ): Promise<void> {
    await enqueue(async () => {
      try {
        const now = new Date();
        const candidate = await detectCandidate(
          db,
          llm,
          { channel, author, text },
          buildContext(db, now).tree,
          now,
        );
        if (!candidate) return;
        logger.info("task candidate detected", { candidateId: candidate.id, channel, author });
        await sendToOwner(renderCandidateProposal(candidate), candidateDecisionQuickReplies(candidate.id));
      } catch (err) {
        logger.error("candidate detection failed", { err: String(err), channel, author });
      }
    });
  }

  // --- DM 受信 ---------------------------------------------------------------
  app.message(async ({ message, say }) => {
    const m = message as {
      channel_type?: string;
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel?: string;
    };
    if (m.subtype || m.bot_id || !m.user || !m.channel) return; // bot/編集/システムは無視
    const text = (m.text ?? "").trim();
    if (!text) return;

    if (m.channel_type !== "im") {
      const owner = getOwnerSlackId(db);
      if (!owner) return;
      if (m.user === owner) return; // 自分の発話は候補化しない
      if (!isOwnerMention(text, owner)) return;
      await handleObservedSlackMessage(m.channel, m.user, text);
      return;
    }

    const owner = getOwnerSlackId(db);
    if (!owner) {
      setOwnerSlackId(db, m.user);
      logger.info("owner registered", { user: m.user });
    } else if (owner !== m.user) {
      if (!declinedUsers.has(m.user)) {
        declinedUsers.add(m.user);
        await say(
          "申し訳ありません、このアシスタントは所有者専用です (シングルユーザー製品です)。",
        );
      }
      return;
    }

    await handleUserText(m.channel, text);
  });

  // --- ボタン押下 = 定型ユーザー入力 ------------------------------------------
  app.action(/^quick_reply_\d+$/, async ({ ack, body, action, respond }) => {
    await ack();
    const value = (action as { value?: string }).value ?? "";
    const label =
      (action as { text?: { text?: string } }).text?.text ?? value;
    const b = body as {
      user?: { id?: string };
      channel?: { id?: string };
      container?: { channel_id?: string };
      message?: { blocks?: SlackBlock[] };
    };
    const user = b.user?.id;
    const channel = b.channel?.id ?? b.container?.channel_id;
    if (!user || !channel || !value) return;
    const owner = getOwnerSlackId(db);
    if (owner && owner !== user) return;

    // 元メッセージのボタンを畳んで選択を可視化 (二度押し防止)
    try {
      const original = b.message?.blocks ?? [];
      await respond({
        blocks: pressedBlocks(original, label) as never,
        replace_original: true,
      });
    } catch (err) {
      logger.error("button collapse failed", { err: String(err) });
    }

    await handleUserText(channel, value);
  });

  // --- オーナーへの送信 (scheduler 用) ----------------------------------------
  async function sendToOwner(text: string, quickReplies?: QuickReply[]): Promise<void> {
    const owner = getOwnerSlackId(db);
    if (!owner) throw new Error("オーナーが未登録です (先に Bot へ DM してください)");
    const open = await app.client.conversations.open({ users: owner });
    const channel = open.channel?.id;
    if (!channel) throw new Error("DM チャンネルを開けませんでした");
    await post(channel, text, quickReplies);
  }

  return {
    app,
    sendToOwner,
    start: async () => {
      await app.start();
      logger.info("slack connected (socket mode)");
    },
    stop: async () => {
      await app.stop();
    },
  };
}
