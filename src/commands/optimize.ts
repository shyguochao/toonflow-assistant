import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliOptions } from "../cli.ts";
import { isTextNode, scanWorkspace } from "../workspace/scan.ts";
import { addChange, formatCanvas, newPlan } from "../workspace/write.ts";
import { baseNodeName, newTextNode, nodeGapX, textPathFor } from "../workspace/templates.ts";
import { assistantHome } from "../workspace/snapshots.ts";
import { optimizeKinds, systemPrompt, type OptimizeKind } from "../standards/index.ts";
import { arkChat, arkConfig, type Chat } from "../llm/ark.ts";
import { charCount } from "../output.ts";
import { previewOrApply } from "./common.ts";
import type { CanvasFile, CanvasNode, Workspace } from "../workspace/model.ts";

const generationTypes = new Set(["imageGenerationNode", "videoGenerationNode"]);

export function findNode(ws: Workspace, query: string) {
  const all = ws.canvases.flatMap(file => (file.canvas?.nodes ?? []).map(node => ({ file, node })));
  const exact = all.filter(({ node }) => node.id === query);
  if (exact.length) return exact[0]!;
  const sameLabel = all.filter(({ node }) => (node.data?.label ?? "").trim() === query.trim());
  if (sameLabel.length === 1) return sameLabel[0]!;
  const matches = sameLabel.length ? sameLabel : all.filter(({ node }) => (node.data?.label ?? "").includes(query));
  if (!matches.length) throw new Error(`没有找到节点：${query}（可用 tfa inspect 查看 ID 与标签）`);
  if (matches.length > 1) throw new Error(`"${query}" 匹配到多个节点，请改用 ID：\n${matches.map(m => `  ${m.node.id}  ${m.node.data?.label ?? ""}（${m.file.path}）`).join("\n")}`);
  return matches[0]!;
}

/** Other text nodes on the same canvas give the model project context (brief, outline, script). */
function contextOf(ws: Workspace, file: CanvasFile, target: CanvasNode, limit = 40_000) {
  let budget = limit;
  const parts: string[] = [];
  for (const node of file.canvas?.nodes ?? []) {
    if (node.id === target.id || !isTextNode(node)) continue;
    const text = ws.texts.get(node.id)?.text;
    if (!text?.trim() || budget <= 0) continue;
    const piece = text.slice(0, budget);
    budget -= piece.length;
    parts.push(`### ${node.data?.label ?? node.id}\n${piece}`);
  }
  return parts.join("\n\n");
}

// ---- prompt (generation node) helpers: Custom reference tags become [[REF:k]] placeholders ----

type Tag = { type: string; text?: string; html?: string; [key: string]: unknown };

export function flattenPromptModel(model: Tag[][]) {
  const refs: Tag[] = [];
  const text = model.map(line => line.map(tag => {
    if (tag.type === "Write") return tag.text ?? "";
    refs.push(tag);
    return `[[REF:${refs.length}]]`;
  }).join("")).join("\n");
  return { text, refs };
}

export function rebuildPromptModel(text: string, refs: Tag[]): Tag[][] {
  return text.split("\n").map(line => {
    const tags: Tag[] = [];
    let last = 0;
    for (const match of line.matchAll(/\[\[REF:(\d+)\]\]/g)) {
      if (match.index! > last) tags.push({ type: "Write", text: line.slice(last, match.index) });
      tags.push(structuredClone(refs[Number(match[1]) - 1]!));
      last = match.index! + match[0].length;
    }
    if (last < line.length || !tags.length) tags.push({ type: "Write", text: line.slice(last) });
    return tags;
  });
}

const placeholders = (text: string) => [...text.matchAll(/\[\[REF:(\d+)\]\]|\{\{ref (\d+)\}\}/g)].map(m => m[0]).sort();

/** Same rendering Toonflow uses for data.prompt: Custom tags contribute their data-value (e.g. "{{ref 1}}"). */
function renderPrompt(model: Tag[][]) {
  return model.map(line => line.map(tag => {
    if (tag.type === "Write") return tag.text ?? "";
    const value = /data-value="([^"]*)"/.exec(String(tag.html ?? ""))?.[1];
    return value ? value.replace(/&quot;/g, '"').replace(/&amp;/g, "&") : "";
  }).join("")).join("\n");
}

export function validateOutput(kind: OptimizeKind, before: string, after: string) {
  if (!after.trim()) return "模型返回为空";
  if (before.trim() && charCount(after) < charCount(before) * 0.3 && kind !== "prompt") return `输出过短（${charCount(after)} 字，原文 ${charCount(before)} 字），疑似截断或摘要`;
  if (kind === "prompt" && placeholders(before).join() !== placeholders(after).join()) return `参考占位符不一致：原 ${placeholders(before).join(" ") || "无"}，新 ${placeholders(after).join(" ") || "无"}`;
  return undefined;
}

async function saveRejected(ws: Workspace, nodeId: string, content: string) {
  const dir = join(assistantHome(), "exports", ws.name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rejected-${nodeId}-${Date.now()}.md`);
  await writeFile(path, content);
  return path;
}

export async function planOptimize(ws: Workspace, options: CliOptions, chat: Chat) {
  if (!options.node) throw new Error("请用 --node 指定节点 ID 或标签关键字");
  const kind = options.as as OptimizeKind;
  if (!optimizeKinds.includes(kind)) throw new Error(`--as 必须是 ${optimizeKinds.join("、")} 之一`);
  const { file, node } = findNode(ws, options.node);
  if (!file.canvas) throw new Error(`画布 ${file.path} 无法解析，请先运行 tfa lint`);
  const type = baseNodeName(node.type);

  if (kind === "prompt") {
    if (!generationTypes.has(type)) throw new Error(`--as prompt 只适用于图片/视频生成节点，当前节点类型为 ${type}`);
    const model = Array.isArray(node.data.promptModel) && node.data.promptModel.length ? node.data.promptModel as Tag[][] : [[{ type: "Write", text: node.data.prompt ?? "" }]];
    const { text, refs } = flattenPromptModel(model);
    if (!text.trim()) throw new Error("该节点提示词为空，没有可优化的内容");
    const user = [`节点类型：${type === "videoGenerationNode" ? "视频生成" : "图片生成"}`, options.goal ? `补充要求：${options.goal}` : "", `项目上下文：\n${contextOf(ws, file, node, 20_000)}`, `原提示词：\n${text}`].filter(Boolean).join("\n\n");
    const result = await chat([{ role: "system", content: systemPrompt(kind) }, { role: "user", content: user }]);
    const problem = validateOutput(kind, text, result.content);
    if (problem) throw new Error(`${problem}。原始输出已保存：${await saveRejected(ws, node.id, result.content)}`);
    const rebuilt = rebuildPromptModel(result.content, refs);
    const canvas = structuredClone(file.canvas);
    const target = canvas.nodes.find(n => n.id === node.id)!;
    target.data.promptModel = rebuilt;
    target.data.prompt = renderPrompt(rebuilt);
    const plan = newPlan(ws.root, `优化提示词：${node.data.label ?? node.id}`);
    await addChange(plan, file.path, formatCanvas(canvas, file.raw), true);
    plan.notes.push("只改 data.prompt / data.promptModel，参考标签与 referenceOrder 保持不变。");
    return { plan, usage: result.usage };
  }

  if (!isTextNode(node)) throw new Error(`--as ${kind} 需要文本节点作为输入，当前节点类型为 ${type}`);
  const source = ws.texts.get(node.id)?.text ?? "";
  if (!source.trim()) throw new Error("该节点正文为空，没有可优化的内容");
  const user = [options.goal ? `补充要求：${options.goal}` : "", `项目上下文（同画布其他文本节点）：\n${contextOf(ws, file, node) || "无"}`, `待优化的「${node.data.label ?? node.id}」原文：\n${source}`].filter(Boolean).join("\n\n");
  const result = await chat([{ role: "system", content: systemPrompt(kind) }, { role: "user", content: user }]);
  const problem = validateOutput(kind, ["character", "scene", "storyboard"].includes(kind) ? "" : source, result.content);
  if (problem) throw new Error(`${problem}。原始输出已保存：${await saveRejected(ws, node.id, result.content)}`);

  const mode = options.mode ?? (["character", "scene", "storyboard"].includes(kind) ? "new-node" : "replace");
  const labels: Record<OptimizeKind, string> = { outline: "大纲", script: "剧本", character: "角色设定", scene: "场景设定", storyboard: "分镜稿", prompt: "提示词" };
  if (mode === "replace") {
    const plan = newPlan(ws.root, `优化${labels[kind]}（覆盖原节点正文）：${node.data.label ?? node.id}`);
    await addChange(plan, textPathFor(node.id), `${result.content}\n`);
    plan.notes.push("只改正文文件，不改画布 JSON；写入后在 Toonflow 中重新打开画布。");
    return { plan, usage: result.usage };
  }
  if (mode !== "new-node") throw new Error("--mode 只能是 replace 或 new-node");

  const id = crypto.randomUUID();
  const suffix = kind === "character" || kind === "scene" ? `${labels[kind]}${options.goal ? `｜${options.goal.slice(0, 20)}` : ""}` : `${labels[kind]}（优化版）`;
  const label = `${node.data.label ?? "文本"}｜${suffix}`;
  const canvas = structuredClone(file.canvas);
  const taken = (x: number, y: number) => canvas.nodes.some(n => Math.abs((n.position?.x ?? 0) - x) < 200 && Math.abs((n.position?.y ?? 0) - y) < 200);
  let position = { x: (node.position?.x ?? 0) + nodeGapX, y: node.position?.y ?? 0 };
  while (taken(position.x, position.y)) position = { x: position.x, y: position.y + 395 };
  canvas.nodes.push(newTextNode(id, label, position, typeof node.data.model === "string" && node.data.model ? node.data.model : undefined) as CanvasNode);
  const plan = newPlan(ws.root, `新建${labels[kind]}节点：${label}`);
  await addChange(plan, textPathFor(id), `${result.content}\n`);
  await addChange(plan, file.path, formatCanvas(canvas, file.raw), true);
  plan.notes.push(`新节点放在 (${position.x}, ${position.y})，原节点保持不变。`);
  return { plan, usage: result.usage };
}

export async function run(root: string, options: CliOptions, chat?: Chat) {
  const ws = await scanWorkspace(root);
  const client = chat ?? arkChat(arkConfig());
  console.error("正在调用火山方舟文本模型（深度思考模型可能需要数分钟）…");
  const { plan, usage } = await planOptimize(ws, options, client);
  if (usage?.total_tokens) plan.notes.push(`本次调用 token：输入 ${usage.prompt_tokens ?? "?"}，输出 ${usage.completion_tokens ?? "?"}，合计 ${usage.total_tokens}`);
  return previewOrApply(plan, options);
}
