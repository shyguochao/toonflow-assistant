#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";

const help = `toonflow-assistant (tfa) — 管理和优化 Toonflow 工作目录

用法: tfa <命令> [工作目录] [选项]
工作目录缺省读取环境变量 TFA_WORKSPACE。

命令:
  inspect               输出工作目录结构化清单
  lint                  一致性检查（有 error 时退出码 1）
  snapshot [-m 备注]     拍快照
  snapshots             列出快照
  restore <快照ID>       回滚到快照（默认预览，--apply 执行）
  clean                 清理孤儿素材目录（默认预览，--apply 执行）
  export                导出文本节点为 Markdown（--format docx 需本机 pandoc）
  sessions              统计 Agent 会话
  import                把 shuohao-skills 的 JSON 校验并渲染后写入文本节点（默认预览，--apply 执行）
                        --from shuohao/<剧名>-<outline|cast|art|script|staging|storyboard|toonflow>.json
                        （-toonflow.json 是 toonflow-canvas 的原生画布 bundle，合并进 画布/*.json）
                        [--node <id|标签>] [--label 新节点标签]
  setup-skills          把 vendor/shuohao-skills 链接到 Agent 的 skills 目录（默认预览，--apply 执行）
                        [--target 目录] [--with character-refs]
  doctor                检查 shuohao-skills 环境（submodule、node、链接）[--selftest]
  optimize              用火山方舟文本模型优化素材（默认预览，--apply 执行）
                        --node <id|标签关键字> --as outline|script|character|scene|storyboard|prompt
                        [--goal 补充要求] [--mode replace|new-node]

通用选项:
  --json      机器可读输出
  --apply     执行写入（写入前自动快照）
  --force     跳过 Toonflow 运行检测
  -h, --help  帮助
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    apply: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    message: { type: "string", short: "m" },
    out: { type: "string" },
    format: { type: "string" },
    node: { type: "string" },
    as: { type: "string" },
    goal: { type: "string" },
    mode: { type: "string" },
    "with-sessions": { type: "boolean" },
    history: { type: "boolean" },
    from: { type: "string" },
    label: { type: "string" },
    target: { type: "string" },
    with: { type: "string", multiple: true },
    selftest: { type: "boolean" },
  },
});

export type CliOptions = typeof values;

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(help);
  process.exit(command ? 0 : 1);
}

function workspaceArg(args: string[]) {
  const path = args[0] ?? process.env.TFA_WORKSPACE;
  if (!path) throw new Error("请指定工作目录，或设置环境变量 TFA_WORKSPACE");
  return resolve(path);
}

const commands: Record<string, () => Promise<number | void>> = {
  inspect: async () => (await import("./commands/inspect.ts")).run(workspaceArg(rest), values),
  lint: async () => (await import("./commands/lint.ts")).run(workspaceArg(rest), values),
  snapshot: async () => (await import("./commands/snapshot.ts")).snapshot(workspaceArg(rest), values),
  snapshots: async () => (await import("./commands/snapshot.ts")).list(workspaceArg(rest), values),
  restore: async () => {
    // tfa restore <ws> <id>  or  tfa restore <id> (with TFA_WORKSPACE)
    const [ws, id] = rest.length >= 2 ? [rest[0], rest[1]] : [undefined, rest[0]];
    if (!id) throw new Error("请指定快照 ID（tfa snapshots 查看）");
    return (await import("./commands/snapshot.ts")).restore(workspaceArg(ws ? [ws] : []), id, values);
  },
  clean: async () => (await import("./commands/clean.ts")).run(workspaceArg(rest), values),
  export: async () => (await import("./commands/export.ts")).run(workspaceArg(rest), values),
  sessions: async () => (await import("./commands/sessions.ts")).run(workspaceArg(rest), values),
  optimize: async () => (await import("./commands/optimize.ts")).run(workspaceArg(rest), values),
  import: async () => (await import("./commands/import.ts")).run(workspaceArg(rest), values),
  "setup-skills": async () => (await import("./commands/setupSkills.ts")).run(values),
  doctor: async () => (await import("./commands/doctor.ts")).run(values),
};

const handler = commands[command];
if (!handler) {
  console.error(`未知命令: ${command}\n`);
  console.log(help);
  process.exit(1);
}

try {
  const code = await handler();
  process.exit(typeof code === "number" ? code : 0);
} catch (error) {
  console.error(`错误: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
