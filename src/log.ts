/**
 * 構造化ログ (architecture.md §8)。
 * プライバシー: 会話本文はログに書かない (本文は DB のみ)。ここに渡すのはメタ情報だけ。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(logPath: string | null): Logger {
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
    } catch {
      logPath = null;
    }
  }
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
    // eslint-disable-next-line no-console
    console.log(line);
    if (logPath) {
      try {
        appendFileSync(logPath, line + "\n");
      } catch {
        /* ログ書き込み失敗で本体を止めない */
      }
    }
  };
  return {
    info: (msg, meta) => write("info", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
  };
}
