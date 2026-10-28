import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendorRoot } from "../src/shuohao/vendor.ts";
import { planImport } from "../src/commands/import.ts";
import { lintShuohao } from "../src/shuohao/lint.ts";
import { readLinks } from "../src/shuohao/links.ts";
import { scanWorkspace } from "../src/workspace/scan.ts";
import { applyPlan } from "../src/workspace/write.ts";
import { createSnapshot, restoreSnapshot } from "../src/workspace/snapshots.ts";
import { hasErrors, lintWorkspace } from "../src/workspace/lint.ts";
import { tempWorkspace } from "./helpers.ts";

const example = join(vendorRoot(), "skills", "toonflow-canvas", "examples", "渡口-toonflow.json");
const from = "shuohao/渡口-toonflow.json";
let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let home: string;

beforeEach(async () => {
  ws = await tempWorkspace();
  home = await mkdtemp(join(tmpdir(), "tfa-home-"));
  process.env.TFA_HOME = home;
  process.env.TFA_TOONFLOW_PORT = "1";
  await mkdir(join(ws.root, "shuohao"), { recursive: true });
  await cp(example, join(ws.root, from));
});
afterEach(async () => { await ws.dispose(); await rm(home, { recursive: true, force: true }); });

const hooks = (root: string) => ({
  snapshot: async (r: string) => (await createSnapshot(root, r)).id,
  restore: (id: string) => restoreSnapshot(root, id).then(() => undefined),
  log: () => {},
});
const importOnce = async (options: { force?: boolean } = {}) => {
  const plan = await planImport(await scanWorkspace(ws.root), { from, ...options });
  await applyPlan(plan, hooks(ws.root));
  return plan;
};
const readCanvas = async (path: string) => JSON.parse(await readFile(join(ws.root, path), "utf8"));
const bundle = async () => JSON.parse(await readFile(join(ws.root, from), "utf8"));
const editBundle = async (edit: (b: any) => void) => { const b = await bundle(); edit(b); await writeFile(join(ws.root, from), JSON.stringify(b, null, 2)); };
const editCanvas = async (path: string, edit: (c: any) => void) => { const c = await readCanvas(path); edit(c); await writeFile(join(ws.root, path), JSON.stringify(c, null, 2)); };

test("bundle import creates the three canvases and text bodies, and the result lints clean", async () => {
  const plan = await importOnce();
  expect(plan.changes.map(c => c.path)).toEqual(expect.arrayContaining(["画布/剧本.json", "画布/资产.json", "画布/分集/第001集.json", "shuohao/links.json"]));
  const b = await bundle();
  const script = await readCanvas("画布/剧本.json");
  expect(script.toonflowCanvas).toBe(true);
  expect(script.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  expect(await readFile(join(ws.root, "assets", b.keys.outline, "content.md"), "utf8")).toStartWith("# 故事大纲｜渡口");
  const scanned = await scanWorkspace(ws.root);
  expect(hasErrors(lintWorkspace(scanned))).toBe(false);
  expect((await lintShuohao(scanned)).filter(f => f.severity !== "info")).toEqual([]);
  // the model already used by the fixture's text nodes is reused for the new text nodes
  const fixtureModel = (await readCanvas("画布1.json")).nodes.find((n: any) => n.data.model)?.data.model;
  expect(script.nodes.find((n: any) => n.id === b.keys.outline).data.model).toBe(fixtureModel);
}, 120_000);

test("re-import updates in place and keeps position, outputs, model and unmanaged nodes", async () => {
  await importOnce();
  const b = await bundle();
  const castId = b.keys["cast:C01"];
  const output = { dataType: "IMAGE", value: { url: `assets/${castId}/image.png`, mimeType: "image/png" } };
  await mkdir(join(ws.root, "assets", castId), { recursive: true });
  await writeFile(join(ws.root, "assets", castId, "image.png"), "png");
  await editCanvas("画布/资产.json", c => {
    const n = c.nodes.find((n: any) => n.id === castId);
    n.position = { x: 999, y: 888 };
    n.data.outputs = { image: output };
    n.data.model = "[\"volcArk\",\"doubao-seedream-5-0-260128\"]";
    n.data.size = "2K";
    c.nodes.push({ id: "11111111-1111-4111-8111-111111111111", type: "remote-textNode", position: { x: 0, y: 0 }, data: { label: "手动节点" } });
  });
  await editBundle(x => {
    const n = x.canvases["画布/资产.json"].nodes.find((n: any) => n.id === castId);
    n.data.prompt = "新的形象提示词";
    n.data.promptModel = [[{ type: "Write", text: "新的形象提示词" }]];
  });
  const plan = await importOnce();
  expect(plan.notes.join("\n")).toContain("引用节点回填");
  const assets = await readCanvas("画布/资产.json");
  const n = assets.nodes.find((n: any) => n.id === castId);
  expect(n.position).toEqual({ x: 999, y: 888 });
  expect(n.data.prompt).toBe("新的形象提示词");
  expect(n.data.outputs.image).toEqual(output);
  expect(n.data.model).toBe("[\"volcArk\",\"doubao-seedream-5-0-260128\"]");
  expect(n.data.size).toBe("2K");
  expect(assets.nodes.some((n: any) => n.data.label === "手动节点")).toBe(true);
  // the episode reference node now shows the generated asset image
  const ep = await readCanvas("画布/分集/第001集.json");
  expect(ep.nodes.find((n: any) => n.id === b.keys["ref:1:cast:C01"]).data.outputs.image).toEqual(output);
  expect(ep.nodes.length).toBe(17);
}, 120_000);

test("managed edges dropped from the bundle are removed; unmanaged edges stay", async () => {
  await importOnce();
  const b = await bundle();
  const removed = b.canvases["画布/资产.json"].edges[0];
  await editCanvas("画布/资产.json", c => { c.edges.push({ id: "manual-edge", source: b.keys["cast:C01"], sourceHandle: "image", target: b.keys["cast:C02"], targetHandle: "in" }); });
  await editBundle(x => {
    const part = x.canvases["画布/资产.json"];
    part.edges = part.edges.filter((e: any) => e.id !== removed.id);
    const target = part.nodes.find((n: any) => n.id === removed.target);
    delete target.data.referenceOrder;
    target.data.prompt = "改为独立出图";
    target.data.promptModel = [[{ type: "Write", text: "改为独立出图" }]];
  });
  await importOnce();
  const edges = (await readCanvas("画布/资产.json")).edges.map((e: any) => e.id);
  expect(edges).not.toContain(removed.id);
  expect(edges).toContain("manual-edge");
}, 120_000);

test("edits made in the app are protected unless --force", async () => {
  await importOnce();
  const b = await bundle();
  await editCanvas("画布/资产.json", c => { c.nodes.find((n: any) => n.id === b.keys["prop:P01"]).data.prompt = "我在 APP 里改的"; });
  await writeFile(join(ws.root, "assets", b.keys["script:1"], "content.md"), "我在 APP 里改的剧本");
  const findings = await lintShuohao(await scanWorkspace(ws.root));
  expect(findings.filter(f => f.rule === "shuohao-node-edited").length).toBe(2);
  await expect(planImport(await scanWorkspace(ws.root), { from })).rejects.toThrow(/被手动修改过/);
  await importOnce({ force: true });
  expect(await readFile(join(ws.root, "assets", b.keys["script:1"], "content.md"), "utf8")).toStartWith("# 第1集剧本");
}, 120_000);

test("id conflicts with unmanaged nodes and invalid bundles are rejected", async () => {
  const b = await bundle();
  await editCanvas("画布1.json", c => { c.nodes.push({ id: b.keys.outline, type: "remote-textNode", position: { x: 0, y: 0 }, data: { label: "撞号" } }); });
  await expect(planImport(await scanWorkspace(ws.root), { from })).rejects.toThrow(/已在 画布1.json 中/);
  await editCanvas("画布1.json", c => { c.nodes.pop(); });
  await mkdir(join(ws.root, "画布"), { recursive: true });
  await writeFile(join(ws.root, "画布", "资产.json"), "{\"notes\": true}");
  await expect(planImport(await scanWorkspace(ws.root), { from })).rejects.toThrow(/不是 Toonflow 画布/);
  await rm(join(ws.root, "画布", "资产.json"));
  await editBundle(x => { x.canvases["画布/资产.json"].edges[0].sourceHandle = "video"; });
  await expect(planImport(await scanWorkspace(ws.root), { from })).rejects.toThrow(/未通过 toonflow-canvas validate/);
}, 120_000);

test("lint reports a newer bundle, deleted managed nodes and dropped nodes", async () => {
  await importOnce();
  const b = await bundle();
  await editCanvas("画布/分集/第001集.json", c => { c.nodes = c.nodes.filter((n: any) => n.id !== b.keys["seg:E01-10"]); c.edges = c.edges.filter((e: any) => e.target !== b.keys["seg:E01-10"]); });
  await editBundle(x => { x.canvases["画布/剧本.json"].nodes = x.canvases["画布/剧本.json"].nodes.filter((n: any) => n.id !== x.keys["script:6"]); delete x.texts[x.keys["script:6"]]; });
  const rules = (await lintShuohao(await scanWorkspace(ws.root))).map(f => f.rule);
  expect(rules).toContain("shuohao-stale");
  expect(rules).toContain("shuohao-link-missing");
  expect(rules).toContain("shuohao-bundle-dropped");
  const plan = await importOnce();
  expect(plan.notes.join("\n")).toContain("已不在 bundle 中，未删除");
  const { links } = await readLinks(ws.root);
  expect(links.bundles?.[0]?.nodes[b.keys["script:6"]]).toBeDefined();
  expect((await readCanvas("画布/分集/第001集.json")).nodes.some((n: any) => n.id === b.keys["seg:E01-10"])).toBe(true);
}, 120_000);
