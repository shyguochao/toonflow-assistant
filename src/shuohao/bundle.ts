import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasEdge, CanvasJson, CanvasNode, Workspace } from "../workspace/model.ts";
import { addChange, formatCanvas, newPlan, sha256, type ChangePlan } from "../workspace/write.ts";
import { textPathFor } from "../workspace/templates.ts";
import { isTextNode } from "../workspace/scan.ts";
import { findBundle, formatLinks, linksPath, readLinks, textHash, upsertBundle, type BundleRecord } from "./links.ts";

/** toonflow-canvas bundle (skills/toonflow-canvas/references/schema.md). */
export type Bundle = {
  kind: "toonflow-bundle";
  version: 1;
  title: string;
  canvases: Record<string, { nodes: CanvasNode[]; edges: CanvasEdge[] }>;
  texts: Record<string, string>;
  keys: Record<string, string>;
  refs: Record<string, string>;
  warnings: { level: string; message: string }[];
};

/** data keys the bundle owns; everything else (outputs, model, size, mode, user tweaks) stays as the app left it. */
export const managedKeys = ["label", "prompt", "promptModel", "referenceOrder", "textPath", "duration", "ratio"];

/** What "edited in the app" is measured against: the body for text nodes, the prompt for generation nodes. */
export function nodeHash(node: CanvasNode, body: string | undefined) {
  return textHash(isTextNode(node) ? body ?? "" : String(node.data?.prompt ?? ""));
}

const emptyCanvas = (): CanvasJson => ({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });

function defaultModel(ws: Workspace, type: string) {
  for (const file of ws.canvases) {
    const model = file.canvas?.nodes.find(n => n.type === type && typeof n.data?.model === "string" && n.data.model)?.data.model;
    if (model) return model as string;
  }
}

function imageOutput(node: CanvasNode | undefined) {
  const output = node?.data?.outputs?.image;
  return output?.dataType === "IMAGE" && typeof output.value?.url === "string" && output.value.url ? output : undefined;
}

export async function planBundleImport(ws: Workspace, file: string, options: { force?: boolean }): Promise<ChangePlan> {
  const raw = await readFile(join(ws.root, file), "utf8");
  const bundle = JSON.parse(raw) as Bundle;
  const { links, error } = await readLinks(ws.root);
  if (error) throw new Error(`${error}。请修复或删除该文件后重试`);
  const record = findBundle(links, file);

  const located = new Map<string, string>();
  for (const c of ws.canvases) for (const n of c.canvas?.nodes ?? []) located.set(n.id, c.path);

  const canvases = new Map<string, { canvas: CanvasJson; raw?: string }>();
  const edited: string[] = [];
  let created = 0, updated = 0;
  for (const [path, part] of Object.entries(bundle.canvases)) {
    const existing = ws.canvases.find(c => c.path === path);
    if (existing && !existing.canvas) throw new Error(`${path} 无法解析（${existing.parseError}），已拒绝导入`);
    if (!existing && await readFile(join(ws.root, path)).then(() => true, () => false)) throw new Error(`${path} 已存在但不是 Toonflow 画布，已拒绝覆盖`);
    const canvas = existing?.canvas ? structuredClone(existing.canvas) : emptyCanvas();
    for (const incoming of part.nodes) {
      const where = located.get(incoming.id);
      const managed = record?.nodes[incoming.id];
      if (where && where !== path) throw new Error(`节点 ${incoming.data.label}（${incoming.id}）已在 ${where} 中，bundle 要放到 ${path}，已拒绝导入`);
      const current = canvas.nodes.find(n => n.id === incoming.id);
      if (current && !managed) throw new Error(`${path} 里已有 id 为 ${incoming.id} 的节点「${current.data?.label ?? ""}」，不是 tfa 导入的，已拒绝导入`);
      if (!current) {
        const node = structuredClone(incoming);
        const model = defaultModel(ws, node.type);
        if (model && !node.data.model) node.data.model = model;
        canvas.nodes.push(node);
        created++;
        continue;
      }
      if (managed && nodeHash(current, ws.texts.get(current.id)?.text) !== managed.hash) edited.push(`${path}「${current.data?.label ?? current.id}」`);
      for (const key of managedKeys) {
        if (key in incoming.data) current.data[key] = structuredClone(incoming.data[key]);
        else delete current.data[key];
      }
      current.data.handles ??= structuredClone(incoming.data.handles);
      current.data.outputs ??= {};
      if (!current.data.model) { const model = defaultModel(ws, current.type); if (model) current.data.model = model; }
      updated++;
    }
    const keep = new Set(part.edges.map(e => e.id));
    canvas.edges = canvas.edges.filter(e => keep.has(e.id) || record?.edges[e.id] !== path);
    for (const edge of part.edges) {
      const at = canvas.edges.findIndex(e => e.id === edge.id);
      if (at >= 0) canvas.edges[at] = structuredClone(edge);
      else canvas.edges.push(structuredClone(edge));
    }
    canvases.set(path, { canvas, raw: existing?.raw });
  }
  if (edited.length && !options.force) {
    throw new Error(`这些节点在上次导入后被手动修改过，覆盖会丢失改动：${edited.join("、")}。请先把改动合回上游 JSON，或确认后加 --force`);
  }

  // A reference node in an episode canvas shows the same file as its asset node once the asset has an image.
  const nodeById = new Map<string, CanvasNode>();
  for (const c of ws.canvases) for (const n of c.canvas?.nodes ?? []) nodeById.set(n.id, n);
  for (const { canvas } of canvases.values()) for (const n of canvas.nodes) nodeById.set(n.id, n);
  let filled = 0;
  for (const [refId, assetId] of Object.entries(bundle.refs ?? {})) {
    const ref = nodeById.get(refId);
    const output = imageOutput(nodeById.get(assetId));
    if (ref && output && imageOutput(ref)?.value.url !== output.value.url) {
      ref.data.outputs = { ...ref.data.outputs, image: structuredClone(output) };
      filled++;
    }
  }

  const plan = newPlan(ws.root, `导入 ${file}`);
  for (const [path, { canvas, raw: before }] of canvases) {
    const after = formatCanvas(canvas, before ?? "\n");
    if (after !== before) await addChange(plan, path, after, true);
  }
  for (const [id, body] of Object.entries(bundle.texts)) {
    if (ws.texts.get(id)?.text !== body) await addChange(plan, textPathFor(id), body);
  }

  const next: BundleRecord = { file, bundleHash: sha256(raw), nodes: {}, edges: {}, importedAt: new Date().toISOString() };
  for (const [path, part] of Object.entries(bundle.canvases)) {
    for (const n of canvases.get(path)!.canvas.nodes.filter(n => part.nodes.some(p => p.id === n.id))) next.nodes[n.id] = { canvas: path, hash: nodeHash(n, bundle.texts[n.id]) };
    for (const e of part.edges) next.edges[e.id] = path;
  }
  // Nodes dropped from the bundle stay managed (so a later bundle may bring them back) but are never deleted automatically.
  const dropped = Object.entries(record?.nodes ?? {}).filter(([id]) => !next.nodes[id]);
  for (const [id, value] of dropped) next.nodes[id] = value;
  await addChange(plan, linksPath, formatLinks(upsertBundle(links, next)));

  plan.notes.push(`新建 ${created} 个节点，更新 ${updated} 个节点（保留位置、模型与已生成结果）。`);
  if (filled) plan.notes.push(`${filled} 个引用节点回填了资产画布已生成的图片。`);
  if (dropped.length) plan.notes.push(`${dropped.length} 个上次导入的节点已不在 bundle 中，未删除，请在 APP 里确认后手动删除。`);
  for (const w of bundle.warnings ?? []) if (w.level === "warn") plan.notes.push(w.message);
  return plan;
}
