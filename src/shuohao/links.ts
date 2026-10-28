import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const shuohaoDir = "shuohao";
export const linksPath = `${shuohaoDir}/links.json`;

export type LinkRecord = {
  /** e.g. "shuohao/灯塔来信-outline.json" */
  file: string;
  nodeId: string;
  canvas: string;
  /** Hash of the rendered Markdown we wrote last time. */
  renderedHash: string;
  /** Hash of the node body right after we wrote it (detects edits made in the app). */
  bodyHash: string;
  importedAt: string;
};
/** One imported toonflow-canvas bundle: which nodes/edges tfa manages and their state right after the import. */
export type BundleRecord = {
  file: string;
  /** Hash of the bundle file we imported (detects a newer bundle not yet imported). */
  bundleHash: string;
  /** Managed node id → canvas path and hash of its body (text nodes) or prompt (generation nodes). */
  nodes: Record<string, { canvas: string; hash: string }>;
  /** Managed edge id → canvas path. */
  edges: Record<string, string>;
  importedAt: string;
};
export type Links = { version: 1; links: LinkRecord[]; bundles?: BundleRecord[] };

export const textHash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd()).digest("hex");

export async function readLinks(root: string): Promise<{ links: Links; error?: string }> {
  const raw = await readFile(join(root, linksPath), "utf8").catch(() => undefined);
  if (raw === undefined) return { links: { version: 1, links: [] } };
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.links) || (value.bundles !== undefined && !Array.isArray(value.bundles))) throw new Error("结构不正确");
    return { links: value as Links };
  } catch (error) {
    return { links: { version: 1, links: [] }, error: `${linksPath} 无法解析：${error instanceof Error ? error.message : String(error)}` };
  }
}

export const findLink = (links: Links, file: string) => links.links.find(l => l.file === file);

export function upsertLink(links: Links, record: LinkRecord): Links {
  return { ...links, links: [...links.links.filter(l => l.file !== record.file), record].sort((a, b) => a.file.localeCompare(b.file)) };
}

export const findBundle = (links: Links, file: string) => links.bundles?.find(b => b.file === file);

export function upsertBundle(links: Links, record: BundleRecord): Links {
  return { ...links, bundles: [...(links.bundles ?? []).filter(b => b.file !== record.file), record].sort((a, b) => a.file.localeCompare(b.file)) };
}

export const formatLinks = (links: Links) => `${JSON.stringify(links, null, 2)}\n`;

export type LinkState = { stale: boolean; nodeEdited: boolean; linkMissing: boolean };

/** Compare a link with the current rendered Markdown and node body (undefined body = node gone). */
export function linkState(record: LinkRecord, rendered: string | undefined, body: string | undefined): LinkState {
  return {
    linkMissing: body === undefined,
    nodeEdited: body !== undefined && textHash(body) !== record.bodyHash,
    stale: rendered !== undefined && textHash(rendered) !== record.renderedHash,
  };
}
