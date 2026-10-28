import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { scanWorkspace } from "../src/workspace/scan.ts";
import { hasErrors, lintWorkspace } from "../src/workspace/lint.ts";
import { inspectData } from "../src/commands/inspect.ts";
import { fixture } from "./scan.test.ts";
import { addOrphan, editCanvas, tempWorkspace } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); dispose = undefined; });

async function lintAfter(edit: (root: string) => Promise<void>) {
  const ws = await tempWorkspace();
  dispose = ws.dispose;
  await edit(ws.root);
  return lintWorkspace(await scanWorkspace(ws.root));
}

const rules = (findings: { rule: string }[]) => findings.map(f => f.rule);

test("fixture has no errors and inspect lists three text nodes", async () => {
  const ws = await scanWorkspace(fixture);
  const findings = lintWorkspace(ws);
  expect(hasErrors(findings)).toBe(false);
  const data = inspectData(ws);
  expect(data.canvases[0]!.nodes.map(n => n.type)).toEqual(["textNode", "textNode", "textNode"]);
  expect(data.canvases[0]!.nodes[0]!.model).toBe("volcArk / glm-5-3-flash-260828");
});

test("missing text file", async () => {
  const findings = await lintAfter(root => rm(join(root, "assets/47fe9ad5-a03b-4c6e-ba73-37c1be9ccd3d/content.md")));
  expect(rules(findings)).toContain("text-missing");
});

test("duplicate id, bad model, wrong textPath", async () => {
  const findings = await lintAfter(root => editCanvas(root, canvas => {
    canvas.nodes[1].id = canvas.nodes[0].id;
    canvas.nodes[2].data.model = "glm";
    canvas.nodes[2].data.textPath = "assets/x/content.md";
  }));
  expect(rules(findings)).toEqual(expect.arrayContaining(["node-duplicate-id", "node-model", "text-path"]));
});

test("dangling edge, bad handle, ref overflow, bad referenceOrder", async () => {
  const findings = await lintAfter(root => editCanvas(root, canvas => {
    const [a, b] = canvas.nodes;
    canvas.edges.push({ id: "e1", source: a.id, sourceHandle: "text", target: "missing", targetHandle: "in" });
    canvas.edges.push({ id: "e2", source: a.id, sourceHandle: "nope", target: b.id, targetHandle: "in" });
    b.data.prompt = "{{ref 1}} 与 {{ref 3}}";
    b.data.referenceOrder = { in: [encodeURIComponent(JSON.stringify(["ghost", "text"])), "%%%"] };
  }));
  expect(rules(findings)).toEqual(expect.arrayContaining(["edge-dangling", "edge-handle", "prompt-ref", "reference-order"]));
});

test("orphan asset directory and broken JSON", async () => {
  const findings = await lintAfter(async root => {
    await addOrphan(root);
    await Bun.write(join(root, "坏画布.json"), '{"toonflowCanvas": true, "nodes": [');
  });
  expect(rules(findings)).toEqual(expect.arrayContaining(["asset-orphan", "canvas-parse"]));
});
