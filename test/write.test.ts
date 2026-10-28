import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot, listSnapshots, planRestore, restoreSnapshot } from "../src/workspace/snapshots.ts";
import { addChange, applyPlan, formatCanvas, newPlan, sha256, unifiedDiff } from "../src/workspace/write.ts";
import { tempWorkspace } from "./helpers.ts";

const textPath = "assets/47fe9ad5-a03b-4c6e-ba73-37c1be9ccd3d/content.md";
let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let home: string;

beforeEach(async () => {
  ws = await tempWorkspace();
  home = await mkdtemp(join(tmpdir(), "tfa-home-"));
  process.env.TFA_HOME = home;
  process.env.TFA_TOONFLOW_PORT = "1"; // nothing listens there
});
afterEach(async () => { await ws.dispose(); await rm(home, { recursive: true, force: true }); });

const hooks = (root: string) => ({
  snapshot: async (reason: string) => (await createSnapshot(root, reason)).id,
  restore: (id: string) => restoreSnapshot(root, id).then(() => undefined),
  log: () => {},
});

test("snapshot → modify → restore round-trip", async () => {
  const original = await readFile(join(ws.root, textPath), "utf8");
  const snap = await createSnapshot(ws.root, "test");
  expect(snap.files.map(f => f.path)).toContain(textPath);
  expect(snap.files.some(f => f.path.startsWith(".agent/"))).toBe(false);
  await writeFile(join(ws.root, textPath), "changed");
  await writeFile(join(ws.root, "assets", "extra.txt"), "new");
  const plan = await planRestore(ws.root, snap.id);
  expect(plan.overwrite).toEqual([textPath]);
  expect(plan.remove).toEqual(["assets/extra.txt"]);
  await restoreSnapshot(ws.root, snap.id);
  expect(await readFile(join(ws.root, textPath), "utf8")).toBe(original);
  expect((await planRestore(ws.root, snap.id)).overwrite).toHaveLength(0);
  expect(await listSnapshots(ws.root)).toHaveLength(1);
});

test("applyPlan writes atomically and keeps file mode", async () => {
  // Toonflow writes 0600 files; the tool must keep whatever mode the file already has.
  await chmod(join(ws.root, textPath), 0o600);
  const plan = newPlan(ws.root, "edit");
  await addChange(plan, textPath, "# 新内容\n");
  const { snapshotId } = await applyPlan(plan, hooks(ws.root));
  expect(snapshotId).toBeDefined();
  expect(await readFile(join(ws.root, textPath), "utf8")).toBe("# 新内容\n");
  const { mode } = await Bun.file(join(ws.root, textPath)).stat();
  expect(mode & 0o777).toBe(0o600);
});

test("applyPlan aborts when the file changed after planning", async () => {
  const plan = newPlan(ws.root, "edit");
  await addChange(plan, textPath, "mine");
  await writeFile(join(ws.root, textPath), "app autosave");
  await expect(applyPlan(plan, hooks(ws.root))).rejects.toThrow("被修改过");
  expect(await readFile(join(ws.root, textPath), "utf8")).toBe("app autosave");
});

test("applyPlan rolls back when the write introduces a lint error", async () => {
  const canvasPath = join(ws.root, "画布1.json");
  const raw = await readFile(canvasPath, "utf8");
  const canvas = JSON.parse(raw);
  canvas.nodes[0].data.model = "broken";
  const plan = newPlan(ws.root, "bad");
  await addChange(plan, "画布1.json", formatCanvas(canvas, raw), true);
  await expect(applyPlan(plan, hooks(ws.root))).rejects.toThrow("已从快照");
  expect(sha256(await readFile(canvasPath, "utf8"))).toBe(sha256(raw));
});

test("canvas writes are refused while Toonflow is listening, unless forced", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  process.env.TFA_TOONFLOW_PORT = String(server.port);
  try {
    const raw = await readFile(join(ws.root, "画布1.json"), "utf8");
    const plan = newPlan(ws.root, "canvas");
    await addChange(plan, "画布1.json", raw.replace("制作简报", "制作简报v2"), true);
    await expect(applyPlan(plan, hooks(ws.root))).rejects.toThrow("Toonflow 服务正在运行");
    await applyPlan(plan, { ...hooks(ws.root), force: true });
    expect(await readFile(join(ws.root, "画布1.json"), "utf8")).toContain("制作简报v2");
  } finally {
    server.stop(true);
  }
});

test("formatCanvas matches the app's formatting and diff shows changes", async () => {
  const raw = await readFile(join(ws.root, "画布1.json"), "utf8");
  expect(formatCanvas(JSON.parse(raw), raw)).toBe(raw);
  const diff = unifiedDiff("a.md", "a\nb\nc", "a\nB\nc");
  expect(diff).toContain("-b");
  expect(diff).toContain("+B");
});
