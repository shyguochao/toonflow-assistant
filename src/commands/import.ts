import { isAbsolute, join, relative } from "node:path";
import type { CliOptions } from "../cli.ts";
import { scanWorkspace, toPosix } from "../workspace/scan.ts";
import { addChange, formatCanvas, newPlan, type ChangePlan } from "../workspace/write.ts";
import { newTextNode, nodeGapX, textPathFor } from "../workspace/templates.ts";
import { renderMarkdown, shuohaoKinds, validateFile, type NodeRunner, runNode } from "../shuohao/vendor.ts";
import { findLink, formatLinks, linkState, linksPath, readLinks, textHash, upsertLink } from "../shuohao/links.ts";
import { planBundleImport } from "../shuohao/bundle.ts";
import { findNode } from "./optimize.ts";
import { previewOrApply } from "./common.ts";
import type { CanvasNode, Workspace } from "../workspace/model.ts";

type ImportOptions = Pick<CliOptions, "from" | "node" | "label" | "force">;

function freePosition(nodes: CanvasNode[]) {
  const taken = (x: number, y: number) => nodes.some(n => Math.abs((n.position?.x ?? 0) - x) < 200 && Math.abs((n.position?.y ?? 0) - y) < 200);
  const maxX = Math.max(0, ...nodes.map(n => n.position?.x ?? 0));
  let position = { x: nodes.length ? maxX + nodeGapX : 0, y: 0 };
  while (taken(position.x, position.y)) position = { x: position.x, y: position.y + 395 };
  return position;
}

export async function planImport(ws: Workspace, options: ImportOptions, run: NodeRunner = runNode): Promise<ChangePlan> {
  if (!options.from) throw new Error("请用 --from 指定 shuohao JSON，例如 --from shuohao/收容回廊-outline.json");
  const full = isAbsolute(options.from) ? options.from : join(ws.root, options.from);
  const file = toPosix(relative(ws.root, full));
  if (file.startsWith("..")) throw new Error(`--from 必须位于工作目录内（建议放在 ${ws.root}/shuohao/）`);

  const check = await validateFile(full, run);
  if (!check.ok) throw new Error(`${file} 未通过 ${shuohaoKinds[check.kind].skill} validate，已拒绝导入：\n${check.output}`);
  if (check.kind === "toonflow") {
    if (options.node || options.label) throw new Error("toonflow bundle 按自带的节点 id 合并，不支持 --node / --label");
    return planBundleImport(ws, file, options);
  }
  const markdown = await renderMarkdown(full, run);
  if (!markdown) throw new Error("渲染结果为空，已拒绝导入");
  const body = `${markdown}\n`;

  const { links, error } = await readLinks(ws.root);
  if (error) throw new Error(`${error}。请修复或删除该文件后重试`);
  const record = findLink(links, file);

  let target: { canvasPath: string; node?: CanvasNode } | undefined;
  if (options.node) {
    const found = findNode(ws, options.node);
    target = { canvasPath: found.file.path, node: found.node };
  } else if (record && !options.label) {
    const canvas = ws.canvases.find(c => c.path === record.canvas)?.canvas;
    const node = canvas?.nodes.find(n => n.id === record.nodeId);
    if (node) target = { canvasPath: record.canvas, node };
  }

  const plan = newPlan(ws.root, `导入 ${file}`);
  let nodeId: string;
  let canvasPath: string;
  if (target?.node) {
    if (target.node.type !== "remote-textNode") throw new Error(`目标节点类型为 ${target.node.type}，只能导入到文本节点`);
    nodeId = target.node.id;
    canvasPath = target.canvasPath;
    const current = ws.texts.get(nodeId)?.text;
    if (record?.nodeId === nodeId && current !== undefined && linkState(record, undefined, current).nodeEdited && !options.force) {
      throw new Error(`节点「${target.node.data.label ?? nodeId}」在上次导入后被手动修改过，覆盖会丢失这些改动。请先把改动合回 ${file}，或确认后加 --force`);
    }
    await addChange(plan, textPathFor(nodeId), body);
    plan.notes.push(`更新已有节点「${target.node.data.label ?? nodeId}」的正文，不改画布 JSON。`);
  } else {
    const canvasFile = ws.canvases.find(c => c.canvas);
    if (!canvasFile?.canvas) throw new Error("工作目录中没有可用的画布，请先在 Toonflow 中创建画布");
    nodeId = crypto.randomUUID();
    canvasPath = canvasFile.path;
    const canvas = structuredClone(canvasFile.canvas);
    const position = freePosition(canvas.nodes);
    const label = options.label ?? `${shuohaoKinds[check.kind].label}｜${check.title}（shuohao）`;
    const model = canvas.nodes.find(n => typeof n.data?.model === "string" && n.data.model)?.data.model as string | undefined;
    canvas.nodes.push(newTextNode(nodeId, label, position, model) as CanvasNode);
    await addChange(plan, textPathFor(nodeId), body);
    await addChange(plan, canvasPath, formatCanvas(canvas, canvasFile.raw), true);
    plan.notes.push(`在 ${canvasPath} 新建文本节点「${label}」，位置 (${position.x}, ${position.y})。`);
  }

  const next = upsertLink(links, { file, nodeId, canvas: canvasPath, renderedHash: textHash(markdown), bodyHash: textHash(body), importedAt: new Date().toISOString() });
  await addChange(plan, linksPath, formatLinks(next));
  return plan;
}

export async function run(root: string, options: CliOptions) {
  const plan = await planImport(await scanWorkspace(root), options);
  return previewOrApply(plan, options);
}
