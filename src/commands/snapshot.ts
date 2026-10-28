import type { CliOptions } from "../cli.ts";
import { createSnapshot, listSnapshots, planRestore, restoreSnapshot, snapshotRoot } from "../workspace/snapshots.ts";
import { toonflowRunning } from "../workspace/write.ts";
import { printJson, table } from "../output.ts";

export async function snapshot(root: string, options: CliOptions) {
  const manifest = await createSnapshot(root, options.message ?? "手动快照", !!options["with-sessions"]);
  if (options.json) printJson(manifest);
  else console.log(`已创建快照 ${manifest.id}（${manifest.files.length} 个文件）\n位置：${snapshotRoot(root)}/${manifest.id}`);
  return 0;
}

export async function list(root: string, options: CliOptions) {
  const manifests = await listSnapshots(root);
  if (options.json) { printJson(manifests.map(({ files, ...m }) => ({ ...m, fileCount: files.length }))); return 0; }
  console.log(manifests.length
    ? table(["ID", "时间", "文件数", "含会话", "备注"], manifests.map(m => [m.id, new Date(m.createdAt).toLocaleString("zh-CN"), m.files.length, m.withSessions ? "是" : "否", m.message]))
    : `还没有快照（${snapshotRoot(root)}）`);
  return 0;
}

export async function restore(root: string, id: string, options: CliOptions) {
  const plan = await planRestore(root, id);
  const total = plan.overwrite.length + plan.create.length + plan.remove.length;
  if (!options.apply) {
    if (options.json) printJson({ dryRun: true, ...plan });
    else {
      console.log(`# 回滚到快照 ${id}\n`);
      if (!total) console.log("当前内容与快照一致，无需回滚。");
      for (const [label, paths] of [["覆盖", plan.overwrite], ["恢复", plan.create], ["删除", plan.remove]] as const) for (const p of paths) console.log(`- ${label} ${p}`);
      console.log("\n（预览模式，未写入。确认后加 --apply 执行，执行前会先给当前状态拍快照。）");
    }
    return 0;
  }
  if (!total) { console.log("当前内容与快照一致，无需回滚。"); return 0; }
  const touchesCanvas = [...plan.overwrite, ...plan.create, ...plan.remove].some(p => p.endsWith(".json"));
  if (touchesCanvas && !options.force && await toonflowRunning()) {
    throw new Error("检测到 Toonflow 服务正在运行，回滚会改写画布文件。请先关闭画布并停止服务，或确认画布未打开后加 --force。");
  }
  const before = await createSnapshot(root, `回滚前自动快照（目标 ${id}）`);
  await restoreSnapshot(root, id);
  if (options.json) printJson({ applied: true, restoredTo: id, safetySnapshot: before.id, ...plan });
  else console.log(`已回滚到 ${id}（${total} 个文件）。回滚前状态保存在快照 ${before.id}。\n请在 Toonflow 中重新打开画布查看。`);
  return 0;
}
