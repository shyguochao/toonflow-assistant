import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorkspace } from "../src/workspace/scan.ts";
import { applyPlan } from "../src/workspace/write.ts";
import { createSnapshot, restoreSnapshot } from "../src/workspace/snapshots.ts";
import { hasErrors, lintWorkspace } from "../src/workspace/lint.ts";
import { planClean } from "../src/commands/clean.ts";
import { exportMarkdown } from "../src/commands/export.ts";
import { sessionStats } from "../src/commands/sessions.ts";
import { fixture } from "./scan.test.ts";
import { addOrphan, tempWorkspace } from "./helpers.ts";

let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let home: string;
beforeEach(async () => {
  ws = await tempWorkspace();
  home = await mkdtemp(join(tmpdir(), "tfa-home-"));
  process.env.TFA_HOME = home;
  process.env.TFA_TOONFLOW_PORT = "1";
});
afterEach(async () => { await ws.dispose(); await rm(home, { recursive: true, force: true }); });

test("clean lists only the orphan directory and removes it on apply", async () => {
  const orphan = await addOrphan(ws.root);
  const plan = planClean(await scanWorkspace(ws.root));
  expect(plan.changes.map(c => c.path)).toEqual([`assets/${orphan}`]);
  await applyPlan(plan, {
    snapshot: async r => (await createSnapshot(ws.root, r)).id,
    restore: id => restoreSnapshot(ws.root, id).then(() => undefined),
    log: () => {},
  });
  expect(await stat(join(ws.root, "assets", orphan)).catch(() => undefined)).toBeUndefined();
  const after = await scanWorkspace(ws.root);
  expect(after.assets).toHaveLength(3);
  expect(hasErrors(lintWorkspace(after))).toBe(false);
});

test("clean refuses when a canvas is unparseable", async () => {
  await addOrphan(ws.root);
  await Bun.write(join(ws.root, "坏.json"), '{"toonflowCanvas": true, "nodes": [');
  const plan = planClean(await scanWorkspace(ws.root));
  expect(plan.changes).toHaveLength(0);
  expect(plan.notes[0]).toContain("无法解析");
});

test("export writes one markdown per text node plus index", async () => {
  const out = join(home, "out");
  const files = await exportMarkdown(await scanWorkspace(fixture), out);
  expect(files).toEqual(["制作简报｜灯塔来信.md", "故事大纲｜灯塔来信.md", "第一集剧本｜灯塔来信 EP01.md", "index.md"]);
  expect((await readdir(out)).length).toBe(4);
  expect(await readFile(join(out, "index.md"), "utf8")).toContain("故事大纲");
});

test("session stats from the sample", async () => {
  const path = ".agent/sessions/sample.jsonl";
  const stats = sessionStats(path, await readFile(join(fixture, path), "utf8"));
  expect(stats.userTurns).toBe(3);
  expect(Object.values(stats.toolCalls).reduce((a, b) => a + b, 0)).toBe(15);
  expect(stats.toolCalls.addNode).toBe(3);
  expect(stats.toolErrors).toBe(0);
  expect(stats.models).toEqual(["volcArk/glm-5-3-flash-260828"]);
  expect(stats.tokens.input).toBeGreaterThan(0);
});
