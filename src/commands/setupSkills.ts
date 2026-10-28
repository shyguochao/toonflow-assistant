import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CliOptions } from "../cli.ts";
import { optionalSkills, productionSkills, skillDir, vendorRoot } from "../shuohao/vendor.ts";
import { printJson, table } from "../output.ts";

/** Default: project-level Comate skills of the hermes-workspace that contains this repo. */
export const defaultTarget = () => process.env.TFA_SKILLS_TARGET ?? resolve(import.meta.dir, "..", "..", "..", ".comate", "skills");

export type LinkAction = { skill: string; source: string; dest: string; action: "create" | "ok" | "conflict" | "missing-source"; detail?: string };

export function initSubmodule() {
  const root = vendorRoot();
  if (existsSync(join(root, "skills"))) return "已初始化";
  const repo = resolve(root, "..", "..");
  const proc = Bun.spawnSync(["git", "-C", repo, "submodule", "update", "--init", "vendor/shuohao-skills"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git submodule update --init 失败：${proc.stderr.toString().trim()}`);
  return "已执行 git submodule update --init";
}

export function planLinks(target: string, skills: string[]): LinkAction[] {
  return skills.map(skill => {
    const source = skillDir(skill);
    const dest = join(target, skill);
    if (!existsSync(join(source, "SKILL.md"))) return { skill, source, dest, action: "missing-source" };
    let info;
    try { info = lstatSync(dest); } catch { return { skill, source, dest, action: "create" }; }
    if (info.isSymbolicLink() && resolve(target, readlinkSync(dest)) === resolve(source)) return { skill, source, dest, action: "ok" };
    return { skill, source, dest, action: "conflict", detail: info.isSymbolicLink() ? `已是指向 ${readlinkSync(dest)} 的链接` : "已存在同名目录或文件" };
  });
}

export async function run(options: CliOptions) {
  const target = resolve(options.target ?? defaultTarget());
  const extra = (options.with ?? []).flatMap(v => v.split(",")).map(v => v.trim()).filter(Boolean);
  const unknown = extra.filter(s => !optionalSkills.includes(s) && !productionSkills.includes(s));
  if (unknown.length) throw new Error(`未知 skill：${unknown.join("、")}（可选：${optionalSkills.join("、")}）`);
  const skills = [...productionSkills, ...extra.filter(s => !productionSkills.includes(s))];

  const init = options.apply ? initSubmodule() : existsSync(join(vendorRoot(), "skills")) ? "已初始化" : "未初始化（--apply 时会自动执行 git submodule update --init）";
  const actions = planLinks(target, skills);
  if (options.apply) {
    await mkdir(target, { recursive: true });
    for (const a of actions.filter(a => a.action === "create")) { await symlink(a.source, a.dest, "dir"); a.detail = "已创建"; }
  }
  if (options.json) { printJson({ target, submodule: init, applied: !!options.apply, actions }); return 0; }
  const label = { create: options.apply ? "已链接" : "将链接", ok: "已存在（无需处理）", conflict: "冲突，已跳过", "missing-source": "vendor 中缺失" } as const;
  console.log(`# 安装 shuohao-skills\n\n目标目录：${target}\nsubmodule：${init}\n`);
  console.log(table(["Skill", "状态", "说明"], actions.map(a => [a.skill, label[a.action], a.detail ?? ""])));
  if (!options.apply) console.log("\n（预览模式，未修改。确认后加 --apply 执行。）");
  else console.log(`\n完成。新开一个 Comate 会话后即可使用这些 skill。当前目标目录内容：${(await readdir(target)).join("、")}`);
  return actions.some(a => a.action === "conflict" || a.action === "missing-source") ? 1 : 0;
}
