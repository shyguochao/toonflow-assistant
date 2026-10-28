import { expect, test } from "bun:test";
import { join } from "node:path";
import { looksLikeCanvas, parseCanvas, scanWorkspace } from "../src/workspace/scan.ts";

export const fixture = join(import.meta.dir, "fixtures", "sample-workspace");

test("scan finds the canvas, three text nodes and their bodies", async () => {
  const ws = await scanWorkspace(fixture);
  expect(ws.name).toBe("sample-workspace");
  expect(ws.canvases.map(c => c.path)).toEqual(["画布1.json"]);
  const canvas = ws.canvases[0]!.canvas!;
  expect(canvas.nodes).toHaveLength(3);
  expect(canvas.edges).toHaveLength(0);
  expect(ws.texts.size).toBe(3);
  for (const text of ws.texts.values()) {
    expect(text.exists).toBe(true);
    expect(text.text.length).toBeGreaterThan(100);
  }
});

test("scan classifies node-owned asset directories", async () => {
  const ws = await scanWorkspace(fixture);
  expect(ws.assets).toHaveLength(3);
  expect(ws.assets.every(a => a.kind === "node" && a.ownerCanvas === "画布1.json")).toBe(true);
  expect(ws.sessions).toHaveLength(1);
});

test("canvas detection and parse errors", () => {
  expect(looksLikeCanvas('{\n  "toonflowCanvas": true, "nodes": []}')).toBe(true);
  expect(looksLikeCanvas('{"other": 1}')).toBe(false);
  expect(parseCanvas("{ bad").parseError).toContain("JSON");
  expect(parseCanvas('{"toonflowCanvas": true}').parseError).toContain("nodes");
});

test("scan rejects a missing directory", async () => {
  await expect(scanWorkspace(join(fixture, "nope"))).rejects.toThrow("工作目录不存在");
});
