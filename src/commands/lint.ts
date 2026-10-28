import type { CliOptions } from "../cli.ts";
import { scanWorkspace } from "../workspace/scan.ts";
import { hasErrors, lintWorkspace } from "../workspace/lint.ts";
import { printJson, table } from "../output.ts";

const order = { error: 0, warn: 1, info: 2 } as const;

export async function run(root: string, options: CliOptions) {
  const ws = await scanWorkspace(root);
  const findings = lintWorkspace(ws).sort((a, b) => order[a.severity] - order[b.severity]);
  const code = hasErrors(findings) ? 1 : 0;
  if (options.json) { printJson({ workspace: ws.root, findings }); return code; }
  const count = (s: keyof typeof order) => findings.filter(f => f.severity === s).length;
  console.log(`# 检查：${ws.name}\n\nerror ${count("error")} · warn ${count("warn")} · info ${count("info")}\n`);
  if (findings.length) console.log(table(["级别", "规则", "文件", "节点", "说明"], findings.map(f => [f.severity, f.rule, f.file, f.nodeId ?? "", f.message])));
  else console.log("未发现问题。");
  return code;
}
