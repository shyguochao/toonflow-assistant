import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** shuohao-skills data kinds, keyed by the file-name suffix the upstream skills use (<剧名>-<kind>.json). */
export const shuohaoKinds = {
  outline: { skill: "novel-outline", label: "故事大纲" },
  cast: { skill: "novel-characters", label: "角色设定" },
  art: { skill: "novel-art", label: "美术设定" },
  script: { skill: "novel-script", label: "剧本" },
  staging: { skill: "novel-staging", label: "开场站位" },
  storyboard: { skill: "novel-storyboard", label: "分镜稿" },
  /** toonflow-canvas bundle: native Toonflow canvases built from the kinds above (merged by tfa import). */
  toonflow: { skill: "toonflow-canvas", label: "Toonflow 画布" },
} as const;
export type ShuohaoKind = keyof typeof shuohaoKinds;

/** Skills linked by `tfa setup-skills` (character-refs is opt-in: it calls external image APIs). */
export const productionSkills: string[] = Object.values(shuohaoKinds).map(k => k.skill);
export const optionalSkills = ["character-refs"];
export const pinnedCommit = "af54a67";

export const vendorRoot = () => process.env.TFA_SHUOHAO_DIR ?? join(import.meta.dir, "..", "..", "vendor", "shuohao-skills");
export const skillDir = (skill: string) => join(vendorRoot(), "skills", skill);
export const scriptPath = (skill: string) => join(skillDir(skill), "scripts", `${skill}.mjs`);

export function detectKind(file: string): { kind: ShuohaoKind; title: string } | undefined {
  const match = /^(.*)-(outline|cast|art|script|staging|storyboard|toonflow)\.json$/.exec(basename(file));
  return match ? { kind: match[2] as ShuohaoKind, title: match[1]! } : undefined;
}

/** Upstream JSON that each validator/renderer accepts, looked up next to the file (same title prefix). */
const upstreamArgs: Record<ShuohaoKind, [flag: string, kind: ShuohaoKind, required: boolean][]> = {
  outline: [],
  cast: [],
  art: [["--cast", "cast", false]],
  script: [["--outline", "outline", false]],
  staging: [["--script", "script", false], ["--art", "art", false]],
  storyboard: [["--script", "script", true]],
  toonflow: [],
};

export function companionArgs(file: string) {
  const detected = detectKind(file);
  if (!detected) throw new Error(`无法识别 shuohao 文件类型：${basename(file)}（应为 <剧名>-outline|cast|art|script|staging|storyboard|toonflow.json）`);
  const args: string[] = [];
  for (const [flag, kind, required] of upstreamArgs[detected.kind]) {
    const path = join(dirname(file), `${detected.title}-${kind}.json`);
    if (existsSync(path)) args.push(flag, path);
    else if (required) throw new Error(`${detected.kind} 需要同目录的 ${basename(path)}`);
  }
  return { ...detected, args };
}

export type NodeResult = { code: number; stdout: string; stderr: string };
/** `cwd` matters: novel-storyboard appends .gates.jsonl to its working directory, so run next to the data file. */
export type NodeRunner = (args: string[], cwd: string) => Promise<NodeResult>;

export function nodeBinary() {
  return process.env.TFA_NODE ?? Bun.which("node") ?? undefined;
}

export async function nodeVersion(): Promise<number | undefined> {
  const bin = nodeBinary();
  if (!bin) return undefined;
  const proc = Bun.spawnSync([bin, "--version"]);
  const match = /^v(\d+)/.exec(proc.stdout.toString().trim());
  return match ? Number(match[1]) : undefined;
}

/** Run a vendored script with the local node (>= 18 required by shuohao-skills). */
export const runNode: NodeRunner = async (args, cwd) => {
  const bin = nodeBinary();
  if (!bin) throw new Error("找不到 node（shuohao-skills 需要 Node.js ≥ 18），可用 TFA_NODE 指定路径");
  const major = await nodeVersion();
  if (major !== undefined && major < 18) throw new Error(`node 版本过低（v${major}），shuohao-skills 需要 ≥ 18`);
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code: proc.signalCode ? 124 : code, stdout, stderr };
};

export function ensureVendor() {
  for (const skill of productionSkills) {
    if (!existsSync(scriptPath(skill))) throw new Error(`未找到 ${scriptPath(skill)}。请先执行 git submodule update --init，或运行 tfa doctor 检查`);
  }
}

export async function validateFile(file: string, run: NodeRunner = runNode) {
  ensureVendor();
  const { kind, title, args } = companionArgs(file);
  const result = await run([scriptPath(shuohaoKinds[kind].skill), "validate", file, ...args], dirname(file));
  return { kind, title, ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

export async function renderMarkdown(file: string, run: NodeRunner = runNode) {
  ensureVendor();
  const { kind, args } = companionArgs(file);
  const result = await run([scriptPath(shuohaoKinds[kind].skill), "render", file, "--md", ...args], dirname(file));
  if (result.code !== 0) throw new Error(`渲染失败（exit ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout.trim();
}
