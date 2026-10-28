/** Volcengine Ark (pay-as-you-go) chat completions client. The API key is read from the environment only. */

export type ArkConfig = { apiKey: string; model: string; reasoning: string; baseUrl: string; timeoutMs: number };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { content: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
export type Chat = (messages: ChatMessage[]) => Promise<ChatResult>;

export function arkConfig(env: Record<string, string | undefined> = process.env): ArkConfig {
  const apiKey = env.ARK_API_KEY?.trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new Error("未设置环境变量 ARK_API_KEY（火山方舟控制台 → API Key 管理）。示例：export ARK_API_KEY=ark-xxxx");
  const baseUrl = (env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl)) throw new Error("ARK_BASE_URL 必须以 https:// 开头");
  if (/\/api\/plan(\/|$)/.test(baseUrl)) throw new Error("ARK_BASE_URL 指向 Agent Plan（/api/plan），其文本模型不允许在非指定工具中调用，请改用 /api/v3 按量付费地址");
  const reasoning = env.ARK_REASONING?.trim() || "high";
  if (!["low", "high", "max"].includes(reasoning)) throw new Error("ARK_REASONING 只能是 low、high 或 max");
  return { apiKey, model: env.ARK_MODEL?.trim() || "glm-5-3-flash-260828", reasoning, baseUrl, timeoutMs: 30 * 60_000 };
}

/** Remove the key and anything that looks like one from text we print. */
export function redact(text: string, apiKey?: string) {
  let out = text.replace(/ark-[A-Za-z0-9_-]{8,}/g, "ark-***").replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***");
  if (apiKey) out = out.split(apiKey).join("***");
  return out;
}

export function arkChat(config: ArkConfig, fetchImpl: typeof fetch = fetch): Chat {
  return async messages => {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages,
        // GLM-5.3-Flash keeps thinking on; effort is controlled by reasoning_effort (low/high/max).
        thinking: { type: "enabled" },
        reasoning_effort: config.reasoning,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    }).catch(error => { throw new Error(`火山方舟请求失败：${redact(error instanceof Error ? error.message : String(error), config.apiKey)}`); });
    const text = await response.text();
    if (!response.ok) {
      let reason = text.slice(0, 500);
      try { const body = JSON.parse(text); reason = body?.error?.message ?? body?.message ?? reason; } catch { /* keep raw */ }
      throw new Error(`火山方舟返回 HTTP ${response.status}：${redact(String(reason), config.apiKey)}`);
    }
    let body: any;
    try { body = JSON.parse(text); } catch { throw new Error("火山方舟返回的不是 JSON"); }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("火山方舟未返回内容");
    return { content: stripFence(content), usage: body.usage };
  };
}

/** Models sometimes wrap Markdown in a code fence despite instructions. */
export function stripFence(text: string) {
  const match = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return (match ? match[1]! : text).trim();
}
