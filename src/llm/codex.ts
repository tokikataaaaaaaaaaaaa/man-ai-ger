/**
 * Codex App Server クライアント (architecture.md §3)。
 *
 * `codex app-server` を長寿命の子プロセスとして保持し、JSON-RPC (行区切り JSON)
 * over stdio で会話する。会社契約の Codex シートをそのまま使う = raw API key を
 * 扱わない (requirements.md §2.3 / §2.4)。
 *
 * 1 回の complete() = ephemeral thread を新規作成して 1 turn 実行。
 *   initialize (プロセス起動時に1回)
 *   → thread/start { ephemeral, cwd, sandbox: read-only, baseInstructions: system }
 *   → turn/start { threadId, input: [text], outputSchema? }
 *   → notification item/completed (item.type === "agentMessage") を収集
 *   → notification turn/completed で確定
 *
 * プロトコルは `codex app-server generate-ts` の生成物 (v0.142) で検証済み。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CompleteOptions, LlmClient } from "./types.js";

export interface CodexClientOptions {
  /** thread/start に渡すモデル。省略時は Codex 側のユーザー設定に従う。 */
  model?: string | undefined;
  timeoutMs?: number;
  codexPath?: string;
  /** thread の作業ディレクトリ (デフォルト: MANAIGER_HOME)。 */
  cwd?: string;
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  lastAgentMessage: string | null;
  timer: NodeJS.Timeout;
}

export class CodexAppServerClient implements LlmClient {
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly codexPath: string;
  private readonly cwd: string;

  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private buf = "";
  private readonly pendingRpc = new Map<number, (msg: RpcResponse) => void>();
  private readonly pendingTurns = new Map<string, PendingTurn>();

  constructor(opts: CodexClientOptions = {}) {
    this.model = opts.model ?? process.env.MANAIGER_CODEX_MODEL ?? undefined;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.codexPath = opts.codexPath ?? process.env.MANAIGER_CODEX_PATH ?? "codex";
    this.cwd = opts.cwd ?? process.env.MANAIGER_HOME ?? process.cwd();
  }

  /** doctor 用: App Server が起動・応答するか (initialize 完了まで)。 */
  async checkAvailable(timeoutMs = 15_000): Promise<boolean> {
    try {
      await Promise.race([
        this.ensureStarted(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), timeoutMs).unref(),
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: CompleteOptions,
  ): Promise<string> {
    await this.ensureStarted();

    const threadRes = await this.rpc("thread/start", {
      ephemeral: true,
      cwd: this.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: systemPrompt,
      ...(this.model ? { model: this.model } : {}),
    });
    const threadId = (threadRes as { thread?: { id?: string } })?.thread?.id;
    if (!threadId) throw new Error("Codex App Server: thread/start が id を返しませんでした");

    const turnDone = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurns.delete(threadId);
        reject(new Error(`Codex App Server: turn がタイムアウトしました (${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      timer.unref();
      this.pendingTurns.set(threadId, { resolve, reject, lastAgentMessage: null, timer });
    });

    await this.rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: userPrompt, text_elements: [] }],
      ...(opts?.schema ? { outputSchema: opts.schema } : {}),
    });

    return turnDone;
  }

  /** プロセスを終了する (daemon shutdown 用)。 */
  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.initialized = null;
  }

  // --- 内部 -------------------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (this.initialized && this.proc && this.proc.exitCode === null) return this.initialized;
    this.initialized = this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const proc = spawn(this.codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
    });
    this.proc = proc;
    this.buf = "";

    proc.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    proc.on("error", (err) => this.failAll(new Error(`codex の起動に失敗しました: ${err.message}`)));
    proc.on("exit", (code) =>
      this.failAll(new Error(`Codex App Server が終了しました (code=${code})`)),
    );

    await this.rpc("initialize", {
      clientInfo: { name: "manaiger", title: "Man.Ai.ger", version: "0.1.0" },
    });
  }

  private failAll(err: Error): void {
    for (const [, cb] of this.pendingRpc) cb({ error: { message: err.message } });
    this.pendingRpc.clear();
    for (const [, turn] of this.pendingTurns) {
      clearTimeout(turn.timer);
      turn.reject(err);
    }
    this.pendingTurns.clear();
    this.proc = null;
    this.initialized = null;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        continue; // JSON でない行 (ログ等) は無視
      }
      if (typeof msg.id === "number" && this.pendingRpc.has(msg.id)) {
        this.pendingRpc.get(msg.id)!(msg);
        this.pendingRpc.delete(msg.id);
        continue;
      }
      if (msg.method) this.onNotification(msg.method, msg.params);
    }
  }

  private onNotification(method: string, params: unknown): void {
    const p = params as {
      threadId?: string;
      item?: { type?: string; text?: string };
      error?: { message?: string };
      message?: string;
    };
    const threadId = p?.threadId;
    if (!threadId || !this.pendingTurns.has(threadId)) return;
    const turn = this.pendingTurns.get(threadId)!;

    if (method === "item/completed" && p.item?.type === "agentMessage") {
      turn.lastAgentMessage = p.item.text ?? null;
    } else if (method === "turn/completed") {
      clearTimeout(turn.timer);
      this.pendingTurns.delete(threadId);
      if (turn.lastAgentMessage !== null) turn.resolve(turn.lastAgentMessage);
      else turn.reject(new Error("Codex App Server: turn は完了しましたが応答がありません"));
    } else if (method === "turn/failed" || method === "error") {
      clearTimeout(turn.timer);
      this.pendingTurns.delete(threadId);
      turn.reject(
        new Error(`Codex App Server: turn が失敗しました (${p.error?.message ?? p.message ?? method})`),
      );
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("Codex App Server が起動していません"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Codex App Server: ${method} がタイムアウトしました`));
      }, this.timeoutMs);
      timer.unref();
      this.pendingRpc.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`Codex App Server: ${method} エラー: ${msg.error.message}`));
        else resolve(msg.result);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
}
