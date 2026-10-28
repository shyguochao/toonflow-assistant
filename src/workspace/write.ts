import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { scanWorkspace } from "./scan.ts";
import { hasErrors, lintWorkspace } from "./lint.ts";

/** One file write or delete. `before` is undefined for new files; `after` undefined means delete. */
export type FileChange = {
  path: string; // relative to workspace root
  before?: string;
  after?: string;
  touchesCanvas: boolean;
  beforeHash?: string;
  beforeMtime?: number;
};

export type ChangePlan = { root: string; title: string; changes: FileChange[]; notes: string[] };

export const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

export function newPlan(root: string, title: string): ChangePlan {
  return { root, title, changes: [], notes: [] };
}

/** Record a change, capturing the current hash/mtime for optimistic concurrency. */
export async function addChange(plan: ChangePlan, path: string, after: string | undefined, touchesCanvas = false) {
  const full = join(plan.root, path);
  const info = await stat(full).catch(() => undefined);
  const before = info?.isFile() ? await readFile(full, "utf8") : undefined;
  plan.changes.push({ path, before, after, touchesCanvas, beforeHash: before === undefined ? undefined : sha256(before), beforeMtime: info?.mtimeMs });
}

/** Serialise a canvas the way Toonflow's writeJson does (2-space indent, raw unicode), keeping the original trailing newline. */
export function formatCanvas(value: unknown, original?: string) {
  const text = JSON.stringify(value, null, 2);
  return original?.endsWith("\n") ? `${text}\n` : text;
}

/** Minimal line diff (LCS) good enough for previewing Markdown/JSON edits. */
export function unifiedDiff(path: string, before = "", after = "", context = 2) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) return `--- ${path}\n+++ ${path}\n（文件过大，仅显示行数：${a.length} → ${b.length}）`;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ op: " ", line: a[i]! }); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) ops.push({ op: "+", line: b[j++]! });
    else ops.push({ op: "-", line: a[i++]! });
  }
  const keep = ops.map((o, k) => o.op !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some(x => x.op !== " "));
  const out = [`--- ${path}`, `+++ ${path}`];
  let skipped = false;
  ops.forEach((o, k) => {
    if (keep[k]) { out.push(`${o.op}${o.line}`); skipped = false; }
    else if (!skipped) { out.push("@@ …"); skipped = true; }
  });
  return out.join("\n");
}

export function describePlan(plan: ChangePlan) {
  const lines = [`# ${plan.title}`, ""];
  if (!plan.changes.length) { lines.push("没有需要修改的内容。"); return lines.join("\n"); }
  for (const change of plan.changes) {
    const kind = change.after === undefined ? "删除" : change.before === undefined ? "新建" : "修改";
    lines.push(`- ${kind} ${change.path}`);
  }
  for (const note of plan.notes) lines.push(`- 注意：${note}`);
  for (const change of plan.changes) {
    if (change.after === undefined) continue;
    lines.push("", "```diff", unifiedDiff(change.path, change.before, change.after), "```");
  }
  return lines.join("\n");
}

/** True when something accepts TCP connections on the Toonflow server port. */
export function toonflowRunning(port = Number(process.env.TFA_TOONFLOW_PORT ?? 3000), host = "127.0.0.1") {
  return new Promise<boolean>(resolve => {
    const socket = connect({ port, host });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function atomicWrite(full: string, content: string) {
  const mode = await stat(full).then(info => info.mode & 0o777, () => 0o600);
  await mkdir(dirname(full), { recursive: true });
  const temp = `${full}.tfa-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, full);
}

export type ApplyOptions = {
  force?: boolean;
  /** Takes a snapshot and returns its id; called before any write. */
  snapshot: (reason: string) => Promise<string>;
  /** Restores a snapshot after a failed post-write check. */
  restore: (id: string) => Promise<void>;
  log?: (message: string) => void;
};

/** Snapshot → concurrency check → atomic writes → re-lint → roll back on error. */
export async function applyPlan(plan: ChangePlan, options: ApplyOptions) {
  const log = options.log ?? console.log;
  if (!plan.changes.length) return { snapshotId: undefined as string | undefined };
  if (plan.changes.some(c => c.touchesCanvas) && !options.force && await toonflowRunning()) {
    throw new Error("检测到 Toonflow 服务正在运行（127.0.0.1:3000）。画布打开时 APP 会自动保存并覆盖外部修改。请先在 APP 中关闭相关画布并停止服务后重试，或确认画布未打开后加 --force。");
  }
  if (!plan.changes.some(c => c.touchesCanvas) && await toonflowRunning()) {
    log("提示：Toonflow 正在运行。写入后请在 APP 中重新打开该画布；写入期间不要在 APP 中编辑这些节点。");
  }
  const errorKey = (f: { rule: string; file: string; nodeId?: string; message: string }) => `${f.rule}|${f.file}|${f.nodeId ?? ""}|${f.message}`;
  const existingErrors = new Set(lintWorkspace(await scanWorkspace(plan.root)).filter(f => f.severity === "error").map(errorKey));
  const snapshotId = await options.snapshot(plan.title);
  log(`已创建快照 ${snapshotId}`);

  for (const change of plan.changes) {
    const full = join(plan.root, change.path);
    const current = await readFile(full, "utf8").catch(() => undefined);
    if ((current === undefined ? undefined : sha256(current)) !== change.beforeHash) {
      throw new Error(`${change.path} 在预览之后被修改过（可能是 APP 自动保存），已中止，未写入任何文件。请重新运行命令。`);
    }
  }

  try {
    for (const change of plan.changes) {
      const full = join(plan.root, change.path);
      if (change.after === undefined) await rm(full, { recursive: true, force: true });
      else await atomicWrite(full, change.after);
    }
    // Only errors introduced by this write count; pre-existing problems are reported by `tfa lint`.
    const findings = lintWorkspace(await scanWorkspace(plan.root)).filter(f => f.severity === "error" && !existingErrors.has(errorKey(f)));
    if (hasErrors(findings)) throw new Error(`写入后检查失败：${findings.map(f => `${f.rule} ${f.file} ${f.message}`).join("；")}`);
  } catch (error) {
    await options.restore(snapshotId);
    throw new Error(`${error instanceof Error ? error.message : String(error)}（已从快照 ${snapshotId} 回滚）`);
  }
  return { snapshotId };
}
