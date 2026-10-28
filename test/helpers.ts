import { cp, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./scan.test.ts";

/** Copy the read-only fixture into a temp dir so tests can mutate it. */
export async function tempWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "tfa-"));
  const root = join(dir, "sample-workspace");
  await cp(fixture, root, { recursive: true });
  return { root, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export async function editCanvas(root: string, edit: (canvas: any) => void, file = "画布1.json") {
  const path = join(root, file);
  const canvas = JSON.parse(await readFile(path, "utf8"));
  edit(canvas);
  await writeFile(path, JSON.stringify(canvas, null, 2));
}

export async function addOrphan(root: string, id = "00000000-0000-4000-8000-000000000000") {
  await mkdir(join(root, "assets", id), { recursive: true });
  await writeFile(join(root, "assets", id, "content.md"), "orphan");
  return id;
}
