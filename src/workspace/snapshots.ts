import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { sha256 } from "./write.ts";
import { toPosix } from "./scan.ts";

/** Snapshots live outside the workspace so Toonflow never scans or copies them. */
export const assistantHome = () => process.env.TFA_HOME ?? join(import.meta.dir, "..", "..");
export const snapshotRoot = (workspace: string) => join(assistantHome(), ".snapshots", basename(workspace));

export type SnapshotManifest = {
  id: string;
  workspace: string;
  createdAt: string;
  message: string;
  withSessions: boolean;
  files: { path: string; size: number; sha256: string }[];
};

async function listFiles(root: string, withSessions: boolean, dir = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    const rel = toPosix(relative(root, full));
    if (entry.isDirectory()) {
      if (rel === ".agent" && !withSessions) continue;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      result.push(...await listFiles(root, withSessions, full));
    } else if (entry.isFile() && !entry.name.includes(".tfa-")) result.push(rel);
  }
  return result.sort();
}

function stamp(date = new Date()) {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

export async function createSnapshot(workspace: string, message = "", withSessions = false): Promise<SnapshotManifest> {
  const id = stamp();
  const target = join(snapshotRoot(workspace), id);
  const files: SnapshotManifest["files"] = [];
  for (const path of await listFiles(workspace, withSessions)) {
    const content = await readFile(join(workspace, path));
    await mkdir(dirname(join(target, "files", path)), { recursive: true });
    await cp(join(workspace, path), join(target, "files", path), { preserveTimestamps: true });
    files.push({ path, size: content.byteLength, sha256: sha256(content) });
  }
  const manifest: SnapshotManifest = { id, workspace, createdAt: new Date().toISOString(), message, withSessions, files };
  await writeFile(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export async function listSnapshots(workspace: string): Promise<SnapshotManifest[]> {
  const root = snapshotRoot(workspace);
  const manifests: SnapshotManifest[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(join(root, entry.name, "manifest.json"), "utf8").catch(() => undefined);
    if (text) manifests.push(JSON.parse(text));
  }
  return manifests.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readSnapshot(workspace: string, id: string) {
  const dir = join(snapshotRoot(workspace), id);
  const text = await readFile(join(dir, "manifest.json"), "utf8").catch(() => undefined);
  if (!text) throw new Error(`快照不存在：${id}`);
  return { dir, manifest: JSON.parse(text) as SnapshotManifest };
}

export type RestorePlan = { overwrite: string[]; create: string[]; remove: string[] };

/** What restoring would change; sessions are only touched when the snapshot includes them. */
export async function planRestore(workspace: string, id: string): Promise<RestorePlan> {
  const { manifest } = await readSnapshot(workspace, id);
  const current = await listFiles(workspace, manifest.withSessions);
  const wanted = new Map(manifest.files.map(f => [f.path, f.sha256]));
  const plan: RestorePlan = { overwrite: [], create: [], remove: [] };
  for (const path of current) {
    if (!wanted.has(path)) plan.remove.push(path);
    else if (sha256(await readFile(join(workspace, path))) !== wanted.get(path)) plan.overwrite.push(path);
  }
  for (const path of wanted.keys()) if (!current.includes(path)) plan.create.push(path);
  return plan;
}

export async function restoreSnapshot(workspace: string, id: string) {
  const { dir, manifest } = await readSnapshot(workspace, id);
  const plan = await planRestore(workspace, id);
  for (const path of plan.remove) await rm(join(workspace, path), { force: true });
  for (const path of [...plan.overwrite, ...plan.create]) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await cp(join(dir, "files", path), join(workspace, path), { preserveTimestamps: true });
  }
  await removeEmptyDirs(join(workspace, "assets"));
  for (const file of manifest.files) {
    const info = await stat(join(workspace, file.path)).catch(() => undefined);
    if (!info) throw new Error(`回滚后文件缺失：${file.path}`);
  }
  return plan;
}

async function removeEmptyDirs(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return false;
  let empty = true;
  for (const entry of entries) {
    if (entry.isDirectory() && await removeEmptyDirs(join(dir, entry.name))) continue;
    empty = false;
  }
  if (empty && basename(dir) !== "assets") await rm(dir, { recursive: true, force: true });
  return empty;
}
