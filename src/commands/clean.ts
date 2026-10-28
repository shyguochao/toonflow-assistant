import type { CliOptions } from "../cli.ts";
import { scanWorkspace } from "../workspace/scan.ts";
import { newPlan, type ChangePlan } from "../workspace/write.ts";
import type { Workspace } from "../workspace/model.ts";
import { previewOrApply } from "./common.ts";

/** Only node-owned directories whose node no longer exists in any canvas are removed. */
export function planClean(ws: Workspace): ChangePlan {
  const plan = newPlan(ws.root, "清理孤儿素材目录");
  for (const dir of ws.assets.filter(d => d.kind === "orphan")) {
    plan.changes.push({ path: dir.path, before: `${dir.files.length} 个文件：${dir.files.join(", ")}`, after: undefined, touchesCanvas: false });
  }
  const broken = ws.canvases.filter(c => !c.canvas);
  if (broken.length) {
    // A broken canvas may still reference these directories; refuse instead of guessing.
    plan.changes = [];
    plan.notes.push(`存在无法解析的画布（${broken.map(c => c.path).join("、")}），为避免误删已跳过清理。请先修复或运行 tfa lint。`);
  }
  return plan;
}

export async function run(root: string, options: CliOptions) {
  if (options.history) {
    console.log("--history 暂不支持：当前版本 Toonflow 的生成节点不持久化历史记录列表（历史文件仍在 assets/{节点ID}/ 下，由 APP 的历史面板管理），为避免误删不做清理。");
    return 0;
  }
  return previewOrApply(planClean(await scanWorkspace(root)), options);
}
