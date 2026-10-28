import type { Severity, Workspace } from "./model.ts";
import { isTextNode, outputPaths } from "./scan.ts";
import { textPathFor } from "./templates.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Finding = { severity: Severity; rule: string; file: string; nodeId?: string; message: string };

export function decodeReferenceKey(key: string): [string, string] | undefined {
  try {
    const value = JSON.parse(decodeURIComponent(key));
    return Array.isArray(value) && value.length === 2 && value.every(v => typeof v === "string") ? value as [string, string] : undefined;
  } catch { return undefined; }
}

/** Plain prompt text of a generation node: data.prompt, or the Write/Custom segments of promptModel. */
export function promptOf(data: Record<string, any>): string {
  if (typeof data.prompt === "string" && data.prompt.trim()) return data.prompt;
  if (!Array.isArray(data.promptModel)) return "";
  return data.promptModel.map((line: any[]) => (Array.isArray(line) ? line : []).map(tag => tag?.text ?? tag?.html ?? "").join("")).join("\n");
}

export function lintWorkspace(ws: Workspace): Finding[] {
  const findings: Finding[] = [];
  const push = (severity: Severity, rule: string, file: string, message: string, nodeId?: string) =>
    findings.push({ severity, rule, file, message, nodeId });

  const seenIds = new Map<string, string>();
  for (const file of ws.canvases) {
    if (!file.canvas) { push("error", "canvas-parse", file.path, file.parseError ?? "无法解析"); continue; }
    const { canvas } = file;
    const vp = canvas.viewport;
    if (!vp || ![vp.x, vp.y, vp.zoom].every(Number.isFinite) || vp.zoom <= 0) push("error", "canvas-viewport", file.path, "viewport 缺失或数值无效");

    const nodes = new Map(canvas.nodes.map(node => [node.id, node]));
    for (const node of canvas.nodes) {
      if (typeof node.id !== "string" || !node.id) { push("error", "node-id", file.path, "节点缺少 id"); continue; }
      const other = seenIds.get(node.id);
      if (other) push("error", "node-duplicate-id", file.path, `节点 id 与 ${other} 中的节点重复`, node.id);
      seenIds.set(node.id, file.path);
      if (typeof node.type !== "string" || !node.type) push("error", "node-type", file.path, "节点缺少 type", node.id);
      if (!node.data || typeof node.data !== "object") { push("error", "node-data", file.path, "节点缺少 data", node.id); continue; }

      if (node.data.model !== undefined && node.data.model !== "") {
        let ok = false;
        try { const parsed = JSON.parse(node.data.model); ok = Array.isArray(parsed) && parsed.length === 2 && parsed.every(v => typeof v === "string"); } catch { /* invalid */ }
        if (!ok) push("error", "node-model", file.path, `data.model 不是 ["提供方","模型"] 的 JSON 字符串：${String(node.data.model).slice(0, 60)}`, node.id);
      }

      if (isTextNode(node)) {
        const textPath = node.data.textPath;
        if (textPath !== undefined && textPath !== textPathFor(node.id)) push("error", "text-path", file.path, `textPath 必须为 ${textPathFor(node.id)}，当前为 ${textPath}`, node.id);
        const text = ws.texts.get(node.id);
        if (textPath && text && !text.exists) push("error", "text-missing", file.path, `正文文件缺失：${textPath}`, node.id);
        if (text?.exists && !text.text.trim()) push("info", "text-empty", file.path, "正文为空", node.id);
      }

      for (const path of outputPaths(node)) {
        if (!existsSync(join(ws.root, path))) push("error", "output-missing", file.path, `输出文件缺失：${path}`, node.id);
      }

      const incoming = canvas.edges.filter(edge => edge.target === node.id);
      const order = node.data.referenceOrder;
      if (order && typeof order === "object") {
        for (const [handle, keys] of Object.entries(order as Record<string, unknown>)) {
          if (!Array.isArray(keys)) { push("warn", "reference-order", file.path, `referenceOrder.${handle} 不是数组`, node.id); continue; }
          for (const key of keys) {
            const decoded = typeof key === "string" ? decodeReferenceKey(key) : undefined;
            if (!decoded) { push("warn", "reference-order", file.path, `referenceOrder.${handle} 含无法解码的项`, node.id); continue; }
            const [source, sourceHandle] = decoded;
            if (!incoming.some(edge => edge.source === source && (edge.sourceHandle ?? "") === sourceHandle && (edge.targetHandle ?? "") === handle)) {
              push("warn", "reference-order", file.path, `referenceOrder.${handle} 指向不存在的连线 ${source}:${sourceHandle}`, node.id);
            }
          }
        }
      }

      const refs = [...promptOf(node.data).matchAll(/\{\{ref (\d+)\}\}/g)].map(m => Number(m[1]));
      const max = Math.max(0, ...refs);
      if (max > incoming.length) push("warn", "prompt-ref", file.path, `提示词引用了 {{ref ${max}}}，但只有 ${incoming.length} 条入边`, node.id);
    }

    for (const edge of canvas.edges) {
      const source = nodes.get(edge.source);
      const target = nodes.get(edge.target);
      if (!source || !target) { push("error", "edge-dangling", file.path, `连线 ${edge.id} 指向不存在的节点`); continue; }
      const sourceHandles = source.data?.handles;
      const targetHandles = target.data?.handles;
      if (Array.isArray(sourceHandles) && edge.sourceHandle && !sourceHandles.some(h => h.id === edge.sourceHandle && h.type === "source")) {
        push("error", "edge-handle", file.path, `连线 ${edge.id} 的源端口 ${edge.sourceHandle} 不存在`, source.id);
      }
      if (Array.isArray(targetHandles) && edge.targetHandle && !targetHandles.some(h => h.id === edge.targetHandle && h.type === "target")) {
        push("error", "edge-handle", file.path, `连线 ${edge.id} 的目标端口 ${edge.targetHandle} 不存在`, target.id);
      }
    }
  }

  for (const dir of ws.assets) {
    if (dir.kind === "orphan") push("warn", "asset-orphan", dir.path, `孤儿素材目录（${dir.files.length} 个文件），没有节点引用`);
  }
  return findings;
}

export const hasErrors = (findings: Finding[]) => findings.some(f => f.severity === "error");
