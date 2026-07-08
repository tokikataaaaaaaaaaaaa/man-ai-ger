/**
 * LLM クライアントの抽象。実装は CodexAppServerClient (本番) と FakeLlm (テスト)。
 * LLM / context management は Codex App Server 一択 (requirements.md §2.3)。
 */

export interface CompleteOptions {
  /** 最終応答を制約する JSON Schema (Codex App Server の outputSchema)。 */
  schema?: Record<string, unknown>;
}

export interface LlmClient {
  /** system + user prompt を渡し、生テキスト応答を返す。失敗時は throw。 */
  complete(systemPrompt: string, userPrompt: string, opts?: CompleteOptions): Promise<string>;
}

/** テスト用: あらかじめ積んだ応答を順に返す。 */
export class FakeLlm implements LlmClient {
  public readonly calls: { system: string; prompt: string; opts?: CompleteOptions }[] = [];
  private readonly queue: (string | Error)[];

  constructor(responses: (string | Error)[]) {
    this.queue = [...responses];
  }

  async complete(
    systemPrompt: string,
    userPrompt: string,
    opts?: CompleteOptions,
  ): Promise<string> {
    this.calls.push({ system: systemPrompt, prompt: userPrompt, ...(opts ? { opts } : {}) });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLlm: 応答キューが空です");
    if (next instanceof Error) throw next;
    return next;
  }
}
