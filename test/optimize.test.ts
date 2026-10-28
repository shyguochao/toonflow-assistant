import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arkChat, arkConfig, redact, stripFence, type Chat, type ChatMessage } from "../src/llm/ark.ts";
import { flattenPromptModel, planOptimize, rebuildPromptModel } from "../src/commands/optimize.ts";
import { scanWorkspace } from "../src/workspace/scan.ts";
import { applyPlan } from "../src/workspace/write.ts";
import { createSnapshot, restoreSnapshot } from "../src/workspace/snapshots.ts";
import { hasErrors, lintWorkspace } from "../src/workspace/lint.ts";
import { nodeHandles, nodeTypeName } from "../src/workspace/templates.ts";
import { editCanvas, tempWorkspace } from "./helpers.ts";

const outlineId = "36a99924-e4cf-403c-b964-19bde0dd022e";
let ws: Awaited<ReturnType<typeof tempWorkspace>>;
let home: string;
beforeEach(async () => {
  ws = await tempWorkspace();
  home = await mkdtemp(join(tmpdir(), "tfa-home-"));
  process.env.TFA_HOME = home;
  process.env.TFA_TOONFLOW_PORT = "1";
});
afterEach(async () => { await ws.dispose(); await rm(home, { recursive: true, force: true }); });

const stub = (reply: (messages: ChatMessage[]) => string): Chat & { calls: ChatMessage[][] } => {
  const calls: ChatMessage[][] = [];
  const fn = (async (messages: ChatMessage[]) => { calls.push(messages); return { content: reply(messages) }; }) as Chat & { calls: ChatMessage[][] };
  fn.calls = calls;
  return fn;
};
const hooks = (root: string) => ({
  snapshot: async (r: string) => (await createSnapshot(root, r)).id,
  restore: (id: string) => restoreSnapshot(root, id).then(() => undefined),
  log: () => {},
});

test("ark config validates env and refuses Agent Plan URLs", () => {
  expect(() => arkConfig({})).toThrow("ARK_API_KEY");
  expect(() => arkConfig({ ARK_API_KEY: "k", ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan/v3" })).toThrow("Agent Plan");
  expect(() => arkConfig({ ARK_API_KEY: "k", ARK_REASONING: "medium" })).toThrow("low、high");
  const dummyKey = ["ark", "dummy", "abc"].join("-");
  const config = arkConfig({ ARK_API_KEY: `Bearer ${dummyKey}` });
  expect(config.apiKey).toBe(dummyKey);
  expect(config.model).toBe("glm-5-3-flash-260828");
});

test("ark client sends thinking + reasoning_effort and redacts errors", async () => {
  const dummyKey = ["ark", "dummy", "0123456789"].join("-"); // not a real key
  const config = arkConfig({ ARK_API_KEY: dummyKey, ARK_REASONING: "low" });
  let body: any;
  const ok = arkChat(config, (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "```markdown\n# 结果\n```" } }], usage: { total_tokens: 9 } }));
  }) as unknown as typeof fetch);
  const result = await ok([{ role: "user", content: "hi" }]);
  expect(result.content).toBe("# 结果");
  expect(body.thinking).toEqual({ type: "enabled" });
  expect(body.reasoning_effort).toBe("low");
  const failing = arkChat(config, (async () => new Response(JSON.stringify({ error: { message: `bad key ${dummyKey}` } }), { status: 401 })) as unknown as typeof fetch);
  await expect(failing([])).rejects.toThrow("HTTP 401");
  await expect(failing([])).rejects.not.toThrow(dummyKey);
  expect(redact("Bearer abc.def ark-zzzzzzzzzz")).toBe("Bearer *** ark-***");
  expect(stripFence("plain")).toBe("plain");
});

test("optimize outline --mode replace only rewrites content.md", async () => {
  const chat = stub(() => "# 优化后的大纲\n" + "内容".repeat(2000));
  const before = await readFile(join(ws.root, "画布1.json"), "utf8");
  const { plan } = await planOptimize(await scanWorkspace(ws.root), { node: "故事大纲", as: "outline" }, chat);
  expect(plan.changes.map(c => c.path)).toEqual([`assets/${outlineId}/content.md`]);
  expect(chat.calls[0]![1]!.content).toContain("制作简报");
  await applyPlan(plan, hooks(ws.root));
  expect(await readFile(join(ws.root, `assets/${outlineId}/content.md`), "utf8")).toStartWith("# 优化后的大纲");
  expect(await readFile(join(ws.root, "画布1.json"), "utf8")).toBe(before);
});

test("optimize character creates a valid new text node", async () => {
  const chat = stub(() => "## 角色设定卡\n林舟……\n## 参考板提示词\n……");
  const { plan } = await planOptimize(await scanWorkspace(ws.root), { node: "第一集剧本", as: "character", goal: "林舟" }, chat);
  expect(plan.changes).toHaveLength(2);
  await applyPlan(plan, hooks(ws.root));
  const after = await scanWorkspace(ws.root);
  const nodes = after.canvases[0]!.canvas!.nodes;
  expect(nodes).toHaveLength(4);
  const created = nodes[3]!;
  expect(created.type).toBe("remote-textNode");
  expect(created.data.label).toBe("第一集剧本｜灯塔来信 EP01｜角色设定｜林舟");
  expect(created.data.textPath).toBe(`assets/${created.id}/content.md`);
  expect(created.data.model).toBe('["volcArk","glm-5-3-flash-260828"]');
  expect(nodes.filter(n => n.id !== created.id).every(n => Math.abs(n.position.x - created.position.x) >= 200 || Math.abs(n.position.y - created.position.y) >= 200)).toBe(true);
  expect(hasErrors(lintWorkspace(after))).toBe(false);
});

test("optimize rejects truncated output and ambiguous node queries", async () => {
  const short = stub(() => "太短");
  await expect(planOptimize(await scanWorkspace(ws.root), { node: "故事大纲", as: "outline" }, short)).rejects.toThrow("输出过短");
  await expect(planOptimize(await scanWorkspace(ws.root), { node: "灯塔来信", as: "outline" }, short)).rejects.toThrow("多个节点");
  await expect(planOptimize(await scanWorkspace(ws.root), { node: "故事大纲", as: "poem" }, short)).rejects.toThrow("--as");
});

test("promptModel placeholders round-trip and prompt optimisation keeps references", async () => {
  const refTag = { type: "Custom", html: '<span style="display: inline-block;"><span class="imageReference" data-reference-id="x" data-value="{{ref 1}}"></span></span>' };
  const model = [[{ type: "Write", text: "A " }, refTag, { type: "Write", text: " 站在窗边" }]];
  const flat = flattenPromptModel(model);
  expect(flat.text).toBe("A [[REF:1]] 站在窗边");
  expect(rebuildPromptModel(flat.text, flat.refs)).toEqual(model);

  const genId = "11111111-2222-4333-8444-555555555555";
  await editCanvas(ws.root, canvas => {
    canvas.nodes.push({ id: genId, type: nodeTypeName("videoGenerationNode"), position: { x: 900, y: 0 },
      data: { label: "镜头1", handles: nodeHandles.videoGenerationNode, outputs: {}, prompt: "{{ref 1}} 站在窗边", promptModel: model, model: "", ratio: "16:9" } });
    canvas.edges.push({ id: "e1", source: outlineId, sourceHandle: "text", target: genId, targetHandle: "in" });
  });
  const good = stub(() => "中景缓推，[[REF:1]] 在窗边回头，神情警惕。");
  const { plan } = await planOptimize(await scanWorkspace(ws.root), { node: genId, as: "prompt" }, good);
  await applyPlan(plan, hooks(ws.root));
  const node = (await scanWorkspace(ws.root)).canvases[0]!.canvas!.nodes.find(n => n.id === genId)!;
  expect(node.data.prompt).toBe("中景缓推，{{ref 1}} 在窗边回头，神情警惕。");
  expect(node.data.promptModel[0][1]).toEqual(refTag);

  const dropped = stub(() => "中景缓推，人物在窗边回头。");
  await expect(planOptimize(await scanWorkspace(ws.root), { node: genId, as: "prompt" }, dropped)).rejects.toThrow("占位符不一致");
});
