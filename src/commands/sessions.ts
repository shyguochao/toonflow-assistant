import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliOptions } from "../cli.ts";
import { scanWorkspace } from "../workspace/scan.ts";
import { printJson, table } from "../output.ts";

export type SessionStats = {
  path: string;
  userTurns: number;
  assistantTurns: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  models: string[];
  tokens: { input: number; output: number; cacheRead: number; total: number };
  firstAt?: string;
  lastAt?: string;
};

/** Parse a Pi Agent SDK session (.jsonl): one JSON entry per line; malformed lines are skipped. */
export function sessionStats(path: string, content: string): SessionStats {
  const stats: SessionStats = { path, userTurns: 0, assistantTurns: 0, toolCalls: {}, toolErrors: 0, models: [], tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } };
  const models = new Set<string>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.timestamp === "string") { stats.firstAt ??= entry.timestamp; stats.lastAt = entry.timestamp; }
    if (entry.type === "model_change" && entry.modelId) models.add([entry.provider, entry.modelId].filter(Boolean).join("/"));
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") stats.userTurns++;
    if (message.role === "assistant") {
      stats.assistantTurns++;
      if (message.model) models.add([message.provider, message.model].filter(Boolean).join("/"));
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        stats.tokens.input += Number(usage.input ?? 0) || 0;
        stats.tokens.output += Number(usage.output ?? 0) || 0;
        stats.tokens.cacheRead += Number(usage.cacheRead ?? 0) || 0;
        stats.tokens.total += Number(usage.totalTokens ?? 0) || 0;
      }
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && typeof part.name === "string") stats.toolCalls[part.name] = (stats.toolCalls[part.name] ?? 0) + 1;
      }
    }
    if (message.role === "toolResult" && message.isError) stats.toolErrors++;
  }
  stats.models = [...models];
  return stats;
}

export async function run(root: string, options: CliOptions) {
  const ws = await scanWorkspace(root);
  const all = await Promise.all(ws.sessions.map(async s => sessionStats(s.path, await readFile(join(ws.root, s.path), "utf8"))));
  if (options.json) { printJson(all); return 0; }
  if (!all.length) { console.log("没有 Agent 会话记录。"); return 0; }
  console.log(`# 会话统计：${ws.name}\n`);
  console.log(table(["会话", "用户轮次", "助手轮次", "工具调用", "工具报错", "模型", "输入 token", "输出 token", "时间"], all.map(s => [
    s.path.split("/").pop(), s.userTurns, s.assistantTurns, Object.values(s.toolCalls).reduce((a, b) => a + b, 0), s.toolErrors,
    s.models.join(", "), s.tokens.input, s.tokens.output, `${s.firstAt?.slice(0, 16) ?? ""} → ${s.lastAt?.slice(0, 16) ?? ""}`,
  ])));
  const tools = new Map<string, number>();
  for (const s of all) for (const [name, n] of Object.entries(s.toolCalls)) tools.set(name, (tools.get(name) ?? 0) + n);
  if (tools.size) console.log(`\n## 工具调用\n\n${table(["工具", "次数"], [...tools].sort((a, b) => b[1] - a[1]))}`);
  return 0;
}
