/**
 * turns = 会話の生ログ (日別)。Di.Ai.ry の daily_logs に相当。
 * LLM への文脈注入と、将来の「日別の全履歴」表示の一次資料。
 */
import type { Db } from "./client.js";
import { isoNow, localDate } from "../util/dates.js";
import type { Turn } from "./types.js";

interface Row {
  id: number;
  date: string;
  role: string;
  content: string;
  at: string;
}

function toTurn(r: Row): Turn {
  return {
    id: r.id,
    date: r.date,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    at: r.at,
  };
}

export function appendTurn(
  db: Db,
  role: "user" | "assistant",
  content: string,
  now?: Date,
): Turn {
  const d = now ?? new Date();
  if (!content.trim()) {
    // 空メッセージは記録しない (呼び出し側のバグでも DB を汚さない)
    return { id: -1, date: localDate(d), role, content: "", at: isoNow(d) };
  }
  const info = db
    .prepare("INSERT INTO turns (date, role, content, at) VALUES (?, ?, ?, ?)")
    .run(localDate(d), role, content, isoNow(d));
  return { id: Number(info.lastInsertRowid), date: localDate(d), role, content, at: isoNow(d) };
}

/** 指定日の会話 (昇順)。limit を与えると末尾 limit 件。 */
export function turnsOnDate(db: Db, date: string, limit?: number): Turn[] {
  const all = db
    .prepare<[string], Row>("SELECT * FROM turns WHERE date = ? ORDER BY id")
    .all(date)
    .map(toTurn);
  if (limit !== undefined && all.length > limit) return all.slice(all.length - limit);
  return all;
}

/** 会話がある日付を新しい順で返す (会話ログページ用)。 */
export function recentTurnDates(db: Db, limit = 14): string[] {
  return db
    .prepare<[number], { date: string }>(
      "SELECT DISTINCT date FROM turns ORDER BY date DESC LIMIT ?",
    )
    .all(limit)
    .map((r) => r.date);
}
