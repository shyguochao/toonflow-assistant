import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../workspace/lint.ts";
import type { Workspace } from "../workspace/model.ts";
import { detectKind, ensureVendor, nodeVersion, renderMarkdown, runNode, validateFile, type NodeRunner } from "./vendor.ts";
import { linkState, linksPath, readLinks, shuohaoDir } from "./links.ts";
import { nodeHash } from "./bundle.ts";
import { sha256 } from "../workspace/write.ts";

/** Extra lint rules that only apply when the workspace has a shuohao/ data directory. */
export async function lintShuohao(ws: Workspace, run: NodeRunner = runNode): Promise<Finding[]> {
  const dir = join(ws.root, shuohaoDir);
  if (!existsSync(dir)) return [];
  const findings: Finding[] = [];
  const files = (await readdir(dir)).filter(name => detectKind(name)).sort();
  if (!files.length) return findings;

  try {
    ensureVendor();
    const major = await nodeVersion();
    if (major === undefined || major < 18) throw new Error(major === undefined ? "找不到 node" : `node v${major} 低于 18`);
  } catch (error) {
    findings.push({ severity: "warn", rule: "shuohao-vendor", file: shuohaoDir, message: `无法执行 shuohao 校验：${error instanceof Error ? error.message : String(error)}（运行 tfa doctor 检查）` });
    return findings;
  }

  const rendered = new Map<string, string>();
  for (const name of files) {
    const path = `${shuohaoDir}/${name}`;
    try {
      const result = await validateFile(join(ws.root, path), run);
      if (!result.ok) findings.push({ severity: "error", rule: "shuohao-validate", file: path, message: result.output.split("\n").slice(0, 20).join(" ⏎ ") });
      else if (result.kind !== "toonflow") rendered.set(path, await renderMarkdown(join(ws.root, path), run));
    } catch (error) {
      findings.push({ severity: "error", rule: "shuohao-validate", file: path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const { links, error } = await readLinks(ws.root);
  if (error) findings.push({ severity: "error", rule: "shuohao-link-missing", file: linksPath, message: error });
  for (const record of links.links) {
    const node = ws.canvases.find(c => c.path === record.canvas)?.canvas?.nodes.find(n => n.id === record.nodeId);
    const body = node ? ws.texts.get(record.nodeId)?.text : undefined;
    const state = linkState(record, rendered.get(record.file), body);
    if (state.linkMissing) findings.push({ severity: "error", rule: "shuohao-link-missing", file: record.file, nodeId: record.nodeId, message: `关联的节点不在 ${record.canvas} 中（可能在 APP 里被删除），重新 tfa import 会新建节点` });
    else {
      if (state.stale) findings.push({ severity: "warn", rule: "shuohao-stale", file: record.file, nodeId: record.nodeId, message: "JSON 改过但还没重新 tfa import" });
      if (state.nodeEdited) findings.push({ severity: "warn", rule: "shuohao-node-edited", file: record.file, nodeId: record.nodeId, message: "节点正文在导入后被手动修改；再次 import 会覆盖，请先把改动合回 JSON" });
    }
  }
  for (const record of links.bundles ?? []) {
    const raw = await readFile(join(ws.root, record.file), "utf8").catch(() => undefined);
    if (raw !== undefined && sha256(raw) !== record.bundleHash) findings.push({ severity: "warn", rule: "shuohao-stale", file: record.file, message: "bundle 比上次导入新，还没重新 tfa import" });
    let parsed: any;
    try { parsed = raw === undefined ? undefined : JSON.parse(raw); } catch { /* reported by shuohao-validate */ }
    const inBundle = new Set(Object.values(parsed?.canvases ?? {}).flatMap((c: any) => (c.nodes ?? []).map((n: any) => n.id)));
    for (const [id, managed] of Object.entries(record.nodes)) {
      const node = ws.canvases.find(c => c.path === managed.canvas)?.canvas?.nodes.find(n => n.id === id);
      if (!node) { findings.push({ severity: "warn", rule: "shuohao-link-missing", file: record.file, nodeId: id, message: `托管节点不在 ${managed.canvas} 中（可能在 APP 里被删除），重新 tfa import 会补回` }); continue; }
      const label = node.data?.label ?? id;
      if (nodeHash(node, ws.texts.get(id)?.text) !== managed.hash) findings.push({ severity: "warn", rule: "shuohao-node-edited", file: record.file, nodeId: id, message: `「${label}」在导入后被手动修改；再次 import 会覆盖，请先把改动合回上游 JSON` });
      if (parsed && !inBundle.has(id)) findings.push({ severity: "info", rule: "shuohao-bundle-dropped", file: record.file, nodeId: id, message: `「${label}」已不在 bundle 中，tfa 不会自动删除` });
    }
  }
  return findings;
}
