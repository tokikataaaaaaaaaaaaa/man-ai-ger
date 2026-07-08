/**
 * タスク候補のライフサイクル (requirements.md §4, architecture.md §4.1)。
 *
 * 候補は専用テーブルを持たず events で管理する (event-sourced):
 *   task_candidate_detected  → 検出 (同じ candidateId の再 emit = 修正)
 *   task_candidate_approved  → 承認 (このときだけ Task を作る)
 *   task_candidate_rejected  → 却下
 * pending = 最後に detected されていて approved/rejected が無いもの。
 */
import { randomUUID } from "node:crypto";
import type { Db } from "./../db/client.js";
import type { LlmClient } from "../llm/types.js";
import { recordEvent } from "../db/events.js";
import { upsertObject } from "../db/objects.js";
import { upsertLink } from "../db/links.js";
import { ensureInbox } from "./actions.js";
import {
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_OUTPUT_SCHEMA,
  buildTriagePrompt,
  parseTriage,
  type ObservedMessage,
} from "../llm/triage.js";
import type { ProjectTree } from "../llm/prompts.js";

export interface Candidate {
  id: string;
  name: string;
  project: string | null;
  due: string | null;
  sourceChannel: string;
  sourceAuthor: string;
  sourceText: string;
  detectedAt: string;
}

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  payload: string;
}

/** 未処理 (承認も却下もされていない) 候補を新しい順で返す。 */
export function listPendingCandidates(db: Db, limit = 20): Candidate[] {
  const rows = db
    .prepare<[], EventRow>(
      `SELECT id, ts, kind, payload FROM events
       WHERE kind IN ('task_candidate_detected','task_candidate_approved','task_candidate_rejected')
       ORDER BY id DESC LIMIT 500`,
    )
    .all();
  const closed = new Set<string>();
  const seen = new Set<string>();
  const pending: Candidate[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cid = typeof payload.candidateId === "string" ? payload.candidateId : null;
    if (!cid) continue;
    if (r.kind !== "task_candidate_detected") {
      closed.add(cid);
      continue;
    }
    if (closed.has(cid) || seen.has(cid)) continue; // 最新の detected だけ採用
    seen.add(cid);
    pending.push({
      id: cid,
      name: String(payload.name ?? ""),
      project: (payload.project as string | null) ?? null,
      due: (payload.due as string | null) ?? null,
      sourceChannel: String(payload.sourceChannel ?? ""),
      sourceAuthor: String(payload.sourceAuthor ?? ""),
      sourceText: String(payload.sourceText ?? ""),
      detectedAt: r.ts,
    });
    if (pending.length >= limit) break;
  }
  return pending;
}

export function getCandidate(db: Db, candidateId: string): Candidate | null {
  return listPendingCandidates(db, 100).find((c) => c.id === candidateId) ?? null;
}

/**
 * 観測したメッセージを triage し、タスク候補なら detected event を記録して返す。
 * 候補でない・triage 失敗なら null (観測痕跡 slack_message_observed は常に残す)。
 */
export async function detectCandidate(
  db: Db,
  llm: LlmClient,
  msg: ObservedMessage,
  tree: ProjectTree[],
  now: Date = new Date(),
): Promise<Candidate | null> {
  recordEvent(
    db,
    "slack_message_observed",
    `${msg.channel} / ${msg.author}: ${msg.text.slice(0, 80)}`,
    { channel: msg.channel, author: msg.author, text: msg.text.slice(0, 500) },
    now,
  );

  let triage;
  try {
    const raw = await llm.complete(TRIAGE_SYSTEM_PROMPT, buildTriagePrompt(msg, tree, now), {
      schema: TRIAGE_OUTPUT_SCHEMA,
    });
    triage = parseTriage(raw);
  } catch {
    return null; // triage 失敗は安全側 (候補化しない)。観測痕跡は残っている
  }
  if (!triage || !triage.task || !triage.name) return null;

  const candidate: Candidate = {
    id: randomUUID(),
    name: triage.name,
    project: triage.project,
    due: triage.due,
    sourceChannel: msg.channel,
    sourceAuthor: msg.author,
    sourceText: msg.text.slice(0, 500),
    detectedAt: "",
  };
  recordEvent(
    db,
    "task_candidate_detected",
    `タスク候補: 「${candidate.name}」 (${msg.channel} / ${msg.author})`,
    {
      candidateId: candidate.id,
      name: candidate.name,
      project: candidate.project,
      due: candidate.due,
      sourceChannel: candidate.sourceChannel,
      sourceAuthor: candidate.sourceAuthor,
      sourceText: candidate.sourceText,
    },
    now,
  );
  return candidate;
}

/** 候補の内容を修正して再提案する (同じ candidateId で detected を再 emit)。 */
export function reviseCandidate(
  db: Db,
  candidate: Candidate,
  patch: { name?: string | null; project?: string | null; due?: string | null },
  now: Date = new Date(),
): Candidate {
  const revised: Candidate = {
    ...candidate,
    name: patch.name ?? candidate.name,
    project: patch.project !== undefined ? patch.project : candidate.project,
    due: patch.due !== undefined ? patch.due : candidate.due,
  };
  recordEvent(
    db,
    "task_candidate_detected",
    `タスク候補を修正: 「${revised.name}」`,
    {
      candidateId: revised.id,
      name: revised.name,
      project: revised.project,
      due: revised.due,
      sourceChannel: revised.sourceChannel,
      sourceAuthor: revised.sourceAuthor,
      sourceText: revised.sourceText,
    },
    now,
  );
  return revised;
}

/** 候補を承認して Task を作成する。戻り値はユーザーに見せる脚注。 */
export function approveCandidate(db: Db, candidate: Candidate, now: Date = new Date()): string {
  const task = upsertObject(db, {
    type: "Task",
    name: candidate.name,
    due: candidate.due,
    now,
  });
  const projectId = candidate.project
    ? upsertObject(db, { type: "Project", name: candidate.project, now }).object.id
    : ensureInbox(db, now);
  upsertLink(db, task.object.id, "belongs_to", projectId, now);
  recordEvent(
    db,
    "task_created",
    `タスク「${task.object.name}」を追加 (Slack 候補から承認)`,
    { id: task.object.id, candidateId: candidate.id, due: candidate.due },
    now,
  );
  recordEvent(
    db,
    "task_candidate_approved",
    `タスク候補「${candidate.name}」を承認`,
    { candidateId: candidate.id, taskId: task.object.id },
    now,
  );
  const due = candidate.due ? ` (締切: ${candidate.due})` : "";
  return `📋 タスク「${task.object.name}」を追加しました${due}`;
}

/** 候補を却下する。 */
export function rejectCandidate(db: Db, candidate: Candidate, now: Date = new Date()): void {
  recordEvent(
    db,
    "task_candidate_rejected",
    `タスク候補「${candidate.name}」を見送り`,
    { candidateId: candidate.id },
    now,
  );
}
