import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companionArgs, detectKind, renderMarkdown, validateFile, vendorRoot } from "../src/shuohao/vendor.ts";
import { linkState, readLinks, textHash, upsertLink } from "../src/shuohao/links.ts";
import { planImport } from "../src/commands/import.ts";
import { scanWorkspace } from "../src/workspace/scan.ts";
import { applyPlan } from "../src/workspace/write.ts";
import { createSnapshot, restoreSnapshot } from "../src/workspace/snapshots.ts";
import { hasErrors, lintWorkspace } from "../src/workspace/lint.ts";
import { tempWorkspace } from "./helpers.ts";

const examples = (kind: string, skill: string) => join(vendorRoot(), "skills", skill, "examples", `渡口-${kind}.json`);
let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let home: string;
let data: string;

beforeEach(async () => {
  ws = await tempWorkspace();
  home = await mkdtemp(join(tmpdir(), "tfa-home-"));
  process.env.TFA_HOME = home;
  process.env.TFA_TOONFLOW_PORT = "1";
  data = join(ws.root, "shuohao");
  await mkdir(data, { recursive: true });
  for (const [kind, skill] of [["outline", "novel-outline"], ["cast", "novel-characters"], ["art", "novel-art"], ["script", "novel-script"], ["storyboard", "novel-storyboard"]]) {
    await cp(examples(kind!, skill!), join(data, `渡口-${kind}.json`));
  }
});
afterEach(async () => { await ws.dispose(); await rm(home, { recursive: true, force: true }); });

const hooks = (root: string) => ({
  snapshot: async (r: string) => (await createSnapshot(root, r)).id,
  restore: (id: string) => restoreSnapshot(root, id).then(() => undefined),
  log: () => {},
});

test("kind detection and companion arguments", () => {
  expect(detectKind("灯塔来信-outline.json")).toEqual({ kind: "outline", title: "灯塔来信" });
  expect(detectKind("notes.json")).toBeUndefined();
  const sb = companionArgs(join(data, "渡口-storyboard.json"));
  expect(sb.args).toEqual(["--script", join(data, "渡口-script.json")]);
  expect(companionArgs(join(data, "渡口-art.json")).args).toEqual(["--cast", join(data, "渡口-cast.json")]);
  expect(() => companionArgs(join(data, "x-storyboard.json"))).toThrow("x-script.json");
});

test("validate and render the upstream examples with real node", async () => {
  const ok = await validateFile(join(data, "渡口-outline.json"));
  expect(ok.ok).toBe(true);
  const md = await renderMarkdown(join(data, "渡口-storyboard.json"));
  expect(md).toStartWith("# 渡口");
  await writeFile(join(data, "坏-outline.json"), JSON.stringify({ episodes: [] }));
  const bad = await validateFile(join(data, "坏-outline.json"));
  expect(bad.ok).toBe(false);
  expect(bad.output.length).toBeGreaterThan(0);
});

test("links state detection", () => {
  const record = { file: "shuohao/a-outline.json", nodeId: "n", canvas: "c.json", renderedHash: textHash("v1"), bodyHash: textHash("v1\n"), importedAt: "" };
  expect(linkState(record, "v1", "v1\n")).toEqual({ stale: false, nodeEdited: false, linkMissing: false });
  expect(linkState(record, "v2", "edited")).toEqual({ stale: true, nodeEdited: true, linkMissing: false });
  expect(linkState(record, undefined, undefined).linkMissing).toBe(true);
  expect(upsertLink(upsertLink({ version: 1, links: [] }, record), { ...record, nodeId: "m" }).links).toHaveLength(1);
});

test("import creates a node, re-import updates it, edits are protected", async () => {
  const before = await scanWorkspace(ws.root);
  const plan = await planImport(before, { from: "shuohao/渡口-outline.json" });
  expect(plan.changes.map(c => c.path)).toEqual(expect.arrayContaining(["画布1.json", "shuohao/links.json"]));
  await applyPlan(plan, hooks(ws.root));

  const after = await scanWorkspace(ws.root);
  const nodes = after.canvases[0]!.canvas!.nodes;
  expect(nodes).toHaveLength(4);
  const created = nodes[3]!;
  expect(created.data.label).toBe("故事大纲｜渡口（shuohao）");
  expect(after.texts.get(created.id)!.text).toStartWith("# 渡口");
  expect(hasErrors(lintWorkspace(after))).toBe(false);
  const { links } = await readLinks(ws.root);
  expect(links.links[0]!.nodeId).toBe(created.id);

  // Re-import with no changes targets the same node and does not touch the canvas.
  const again = await planImport(after, { from: "shuohao/渡口-outline.json" });
  expect(again.changes.map(c => c.path)).not.toContain("画布1.json");

  // Simulate an edit made in the app: import refuses unless forced.
  await writeFile(join(ws.root, `assets/${created.id}/content.md`), "手动改过");
  await expect(planImport(await scanWorkspace(ws.root), { from: "shuohao/渡口-outline.json" })).rejects.toThrow("手动修改过");
  const forced = await planImport(await scanWorkspace(ws.root), { from: "shuohao/渡口-outline.json", force: true });
  expect(forced.changes).toHaveLength(2);
}, 60_000);

test("import into an existing node and rejection of invalid JSON", async () => {
  const outlineNode = "36a99924-e4cf-403c-b964-19bde0dd022e";
  const plan = await planImport(await scanWorkspace(ws.root), { from: "shuohao/渡口-script.json", node: outlineNode });
  expect(plan.changes.map(c => c.path)).toEqual([`assets/${outlineNode}/content.md`, "shuohao/links.json"]);
  await writeFile(join(data, "坏-outline.json"), "{}");
  await expect(planImport(await scanWorkspace(ws.root), { from: "shuohao/坏-outline.json" })).rejects.toThrow("未通过");
  await expect(planImport(await scanWorkspace(ws.root), { from: "../x-outline.json" })).rejects.toThrow("工作目录内");
});

test("lintShuohao: clean, stale, edited, missing link, invalid JSON, broken vendor", async () => {
  const { lintShuohao } = await import("../src/shuohao/lint.ts");
  const rules = async () => (await lintShuohao(await scanWorkspace(ws.root))).map(f => f.rule);
  expect(await rules()).toEqual([]);

  await applyPlan(await planImport(await scanWorkspace(ws.root), { from: "shuohao/渡口-outline.json" }), hooks(ws.root));
  expect(await rules()).toEqual([]);

  const outlinePath = join(data, "渡口-outline.json");
  const outline = JSON.parse(await Bun.file(outlinePath).text());
  outline.title = `${outline.title ?? "渡口"}（改）`;
  await writeFile(outlinePath, JSON.stringify(outline, null, 2));
  const { links } = await readLinks(ws.root);
  const nodeId = links.links[0]!.nodeId;
  await writeFile(join(ws.root, `assets/${nodeId}/content.md`), "app edit");
  expect(await rules()).toEqual(expect.arrayContaining(["shuohao-node-edited"]));

  await writeFile(join(data, "坏-outline.json"), "{}");
  expect(await rules()).toContain("shuohao-validate");

  await writeFile(join(ws.root, "shuohao/links.json"), JSON.stringify({ version: 1, links: [{ ...links.links[0]!, nodeId: "gone" }] }));
  expect(await rules()).toContain("shuohao-link-missing");

  const saved = process.env.TFA_SHUOHAO_DIR;
  process.env.TFA_SHUOHAO_DIR = join(home, "no-vendor");
  try { expect(await rules()).toEqual(["shuohao-vendor"]); } finally {
    if (saved === undefined) delete process.env.TFA_SHUOHAO_DIR; else process.env.TFA_SHUOHAO_DIR = saved;
  }
}, 120_000);

test("stale is reported when the JSON changes the rendered output", async () => {
  const { lintShuohao } = await import("../src/shuohao/lint.ts");
  await applyPlan(await planImport(await scanWorkspace(ws.root), { from: "shuohao/渡口-art.json" }), hooks(ws.root));
  const path = join(data, "渡口-art.json");
  const art = JSON.parse(await Bun.file(path).text());
  const text = JSON.stringify(art);
  // Change a visible string without breaking the schema: rename the first scene.
  const scene = (art.scenes ?? [])[0];
  expect(scene).toBeDefined();
  scene.name = `${scene.name}·改`;
  await writeFile(path, JSON.stringify(art, null, 2));
  expect(JSON.stringify(art)).not.toBe(text);
  const findings = await lintShuohao(await scanWorkspace(ws.root));
  expect(findings.map(f => f.rule)).toContain("shuohao-stale");
}, 120_000);

test("setup-skills links, is idempotent and skips conflicts; doctor reports state", async () => {
  const { planLinks } = await import("../src/commands/setupSkills.ts");
  const { doctorChecks } = await import("../src/commands/doctor.ts");
  const { productionSkills } = await import("../src/shuohao/vendor.ts");
  const { symlink, mkdir: mk } = await import("node:fs/promises");
  const target = join(home, "skills");
  await mk(target, { recursive: true });
  await mk(join(target, "novel-art"));                       // conflicting real directory

  const first = planLinks(target, productionSkills);
  expect(first.filter(a => a.action === "create")).toHaveLength(productionSkills.length - 1);
  expect(first.find(a => a.skill === "novel-art")!.action).toBe("conflict");
  for (const a of first.filter(a => a.action === "create")) await symlink(a.source, a.dest, "dir");
  const second = planLinks(target, productionSkills);
  expect(second.filter(a => a.action === "ok")).toHaveLength(productionSkills.length - 1);
  expect(productionSkills).toContain("toonflow-canvas");
  expect(second.filter(a => a.action === "create")).toHaveLength(0);

  const checks = await doctorChecks({ target });
  expect(checks.find(c => c.item === "submodule")!.ok).toBe(true);
  expect(checks.find(c => c.item === "锁定版本")!.ok).toBe(true);
  expect(checks.find(c => c.item === "node")!.ok).toBe(true);
  expect(checks.find(c => c.item === "链接 novel-art")!.ok).toBe(false);
  expect(checks.find(c => c.item === "链接 novel-outline")!.ok).toBe(true);

  const saved = process.env.TFA_SHUOHAO_DIR;
  process.env.TFA_SHUOHAO_DIR = join(home, "no-vendor");
  try {
    const missing = await doctorChecks({ target });
    expect(missing.find(c => c.item === "submodule")!.detail).toContain("git submodule update --init");
  } finally {
    if (saved === undefined) delete process.env.TFA_SHUOHAO_DIR; else process.env.TFA_SHUOHAO_DIR = saved;
  }
});
