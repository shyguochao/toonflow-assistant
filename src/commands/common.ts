import type { CliOptions } from "../cli.ts";
import { applyPlan, describePlan, type ChangePlan } from "../workspace/write.ts";
import { createSnapshot, restoreSnapshot } from "../workspace/snapshots.ts";
import { printJson } from "../output.ts";

/** Default is a dry-run preview; `--apply` snapshots and writes. */
export async function previewOrApply(plan: ChangePlan, options: CliOptions) {
  if (!options.apply) {
    if (options.json) printJson({ dryRun: true, title: plan.title, notes: plan.notes, changes: plan.changes.map(c => ({ path: c.path, action: c.after === undefined ? "delete" : c.before === undefined ? "create" : "update" })) });
    else console.log(`${describePlan(plan)}\n\n（预览模式，未写入。确认后加 --apply 执行，执行前会自动快照。）`);
    return 0;
  }
  const { snapshotId } = await applyPlan(plan, {
    force: options.force,
    snapshot: async reason => (await createSnapshot(plan.root, `自动快照：${reason}`)).id,
    restore: async id => { await restoreSnapshot(plan.root, id); },
    log: message => console.error(message),
  });
  if (options.json) printJson({ applied: true, snapshotId, changes: plan.changes.map(c => c.path) });
  else console.log(plan.changes.length
    ? `已写入 ${plan.changes.length} 处修改。快照：${snapshotId}（回滚：tfa restore ${plan.root} ${snapshotId} --apply）\n请在 Toonflow 中重新打开画布查看。`
    : "没有需要修改的内容。");
  return 0;
}
