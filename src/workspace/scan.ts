import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { AssetDir, CanvasFile, CanvasJson, CanvasNode, NodeText, SessionFile, Workspace } from "./model.ts";
import { baseNodeName } from "./templates.ts";

const skipDirs = new Set(["assets", ".agent", "node_modules", ".git"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const toPosix = (path: string) => path.split(sep).join("/");
export const isUuid = (value: string) => uuidPattern.test(value);

async function exists(path: string) {
  return stat(path).then(() => true, () => false);
}

async function walkFiles(root: string, dir = root, skipTop = true): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipTop && dir === root && skipDirs.has(entry.name)) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      files.push(...await walkFiles(root, full, skipTop));
    } else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Same rule as Toonflow canvasFile.ts: the marker must appear in the first 4 KB. */
export function looksLikeCanvas(raw: string) {
  return /"toonflowCanvas"\s*:\s*true/.test(raw.slice(0, 4096));
}

export function parseCanvas(raw: string): { canvas?: CanvasJson; parseError?: string } {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || value.toonflowCanvas !== true) return { parseError: "缺少 toonflowCanvas: true" };
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return { parseError: "缺少 nodes 或 edges 数组" };
    return { canvas: value as CanvasJson };
  } catch (error) {
    return { parseError: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function allNodes(ws: Workspace) {
  return ws.canvases.flatMap(file => (file.canvas?.nodes ?? []).map(node => ({ file, node })));
}

export const isTextNode = (node: CanvasNode) => baseNodeName(node.type) === "textNode";

/** Media paths referenced by a node's persisted outputs, e.g. outputs.image.value.url. */
export function outputPaths(node: CanvasNode): string[] {
  const outputs = node.data?.outputs;
  if (!outputs || typeof outputs !== "object") return [];
  return Object.values(outputs as Record<string, any>)
    .map(output => output?.value?.url)
    .filter((url): url is string => typeof url === "string" && !/^[a-z]+:/i.test(url));
}

export async function scanWorkspace(root: string): Promise<Workspace> {
  if (!await exists(root)) throw new Error(`工作目录不存在：${root}`);
  const canvases: CanvasFile[] = [];
  for (const file of await walkFiles(root)) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(file, "utf8");
    if (!looksLikeCanvas(raw)) continue;
    canvases.push({ path: toPosix(relative(root, file)), raw, ...parseCanvas(raw) });
  }
  canvases.sort((a, b) => a.path.localeCompare(b.path, "zh"));

  const nodeOwner = new Map<string, string>();
  for (const file of canvases) for (const node of file.canvas?.nodes ?? []) nodeOwner.set(node.id, file.path);

  const texts = new Map<string, NodeText>();
  for (const file of canvases) {
    for (const node of file.canvas?.nodes ?? []) {
      if (!isTextNode(node) || typeof node.data?.textPath !== "string") continue;
      const path = node.data.textPath;
      const full = join(root, path);
      const present = await exists(full);
      texts.set(node.id, { nodeId: node.id, path, exists: present, text: present ? await readFile(full, "utf8") : "" });
    }
  }

  const assets: AssetDir[] = [];
  const sharedFiles: string[] = [];
  const assetsRoot = join(root, "assets");
  for (const entry of await readdir(assetsRoot, { withFileTypes: true }).catch(() => [])) {
    const full = join(assetsRoot, entry.name);
    if (entry.isFile()) { sharedFiles.push(`assets/${entry.name}`); continue; }
    if (!entry.isDirectory()) continue;
    const files = (await walkFiles(full, full, false)).map(file => toPosix(relative(root, file))).sort();
    const owner = nodeOwner.get(entry.name);
    if (isUuid(entry.name)) assets.push({ path: `assets/${entry.name}`, files, kind: owner ? "node" : "orphan", ownerCanvas: owner });
    else { assets.push({ path: `assets/${entry.name}`, files, kind: "shared" }); sharedFiles.push(...files); }
  }
  assets.sort((a, b) => a.path.localeCompare(b.path));

  const sessions: SessionFile[] = [];
  const sessionDir = join(root, ".agent", "sessions");
  for (const entry of await readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = join(sessionDir, entry.name);
    sessions.push({ path: toPosix(relative(root, full)), size: (await stat(full)).size });
  }
  sessions.sort((a, b) => a.path.localeCompare(b.path));

  return { root, name: basename(root), canvases, texts, assets, sharedFiles, sessions };
}
