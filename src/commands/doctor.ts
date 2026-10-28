import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliOptions } from "../cli.ts";
import { nodeBinary, nodeVersion, pinnedCommit, productionSkills, skillDir, vendorRoot } from "../shuohao/vendor.ts";
import { defaultTarget, planLinks } from "./setupSkills.ts";
import { printJson, table } from "../output.ts";

type Check = { item: string; ok: boolean; detail: string };

export async function doctorChecks(options: Pick<CliOptions, "target" | "selftest">): Promise<Check[]> {
  const checks: Check[] = [];
  const root = vendorRoot();
  const initialised = existsSync(join(root, "skills"));
  checks.push({ item: "submodule", ok: initialised, detail: initialised ? root : "未初始化：git submodule update --init" });

  if (initialised) {
    const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "--short=7", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
    checks.push({ item: "锁定版本", ok: head === pinnedCommit, detail: head === pinnedCommit ? head : `当前 ${head || "未知"}，锁定 ${pinnedCommit}（升级后请同步 src/shuohao/vendor.ts 的 pinnedCommit）` });
  }

  const major = await nodeVersion();
  checks.push({ item: "node", ok: major !== undefined && major >= 18, detail: major === undefined ? "未找到 node（可用 TFA_NODE 指定）" : `v${major} ${nodeBinary()}` });

  const target = resolve(options.target ?? defaultTarget());
  for (const action of planLinks(target, productionSkills)) {
    checks.push({ item: `链接 ${action.skill}`, ok: action.action === "ok", detail: action.action === "ok" ? action.dest : action.action === "create" ? "未链接：tfa setup-skills --apply" : action.detail ?? action.action });
  }

  if (options.selftest && initialised && major !== undefined && major >= 18) {
    for (const skill of productionSkills) {
      const script = join(skillDir(skill), "scripts", "selftest.mjs");
      if (!existsSync(script)) { checks.push({ item: `自测 ${skill}`, ok: false, detail: "缺少 selftest.mjs" }); continue; }
      const proc = Bun.spawnSync([nodeBinary()!, script], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
      const last = `${proc.stdout}${proc.stderr}`.trim().split("\n").pop() ?? "";
      checks.push({ item: `自测 ${skill}`, ok: proc.exitCode === 0, detail: last.slice(0, 120) });
    }
  }
  return checks;
}

export async function run(options: CliOptions) {
  const checks = await doctorChecks(options);
  if (options.json) printJson(checks);
  else console.log(`# tfa doctor\n\n${table(["检查项", "结果", "说明"], checks.map(c => [c.item, c.ok ? "✓" : "✗", c.detail]))}`);
  return checks.every(c => c.ok) ? 0 : 1;
}
