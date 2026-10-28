import type { CliOptions } from "../cli.ts";
import { scanWorkspace, outputPaths } from "../workspace/scan.ts";
import { baseNodeName } from "../workspace/templates.ts";
import { charCount, printJson, table } from "../output.ts";
import type { Workspace } from "../workspace/model.ts";

export function inspectData(ws: Workspace) {
  return {
    workspace: ws.root,
    canvases: ws.canvases.map(file => ({
      path: file.path,
      parseError: file.parseError,
      nodes: (file.canvas?.nodes ?? []).map(node => {
        const text = ws.texts.get(node.id);
        let model: string | undefined;
        try { model = node.data?.model ? (JSON.parse(node.data.model) as string[]).join(" / ") : undefined; } catch { model = String(node.data?.model); }
        return {
          id: node.id,
          type: baseNodeName(node.type),
          label: node.data?.label ?? "",
          position: node.position,
          textPath: text?.path,
          chars: text?.exists ? charCount(text.text) : undefined,
          model,
          outputs: outputPaths(node),
        };
      }),
      edges: (file.canvas?.edges ?? []).map(edge => ({ id: edge.id, from: `${edge.source}:${edge.sourceHandle ?? ""}`, to: `${edge.target}:${edge.targetHandle ?? ""}` })),
    })),
    assets: ws.assets.map(dir => ({ path: dir.path, kind: dir.kind, files: dir.files.length, ownerCanvas: dir.ownerCanvas })),
    sharedFiles: ws.sharedFiles,
    sessions: ws.sessions,
  };
}

export async function run(root: string, options: CliOptions) {
  const ws = await scanWorkspace(root);
  const data = inspectData(ws);
  if (options.json) { printJson(data); return 0; }

  const kindLabel = { node: "节点专属", orphan: "孤儿", shared: "共享" } as const;
  const lines = [`# 工作目录：${ws.name}`, "", `路径：${ws.root}`, ""];
  lines.push(`## 画布（${data.canvases.length}）`, "");
  for (const canvas of data.canvases) {
    lines.push(`### ${canvas.path}${canvas.parseError ? `（解析失败：${canvas.parseError}）` : ""}`, "");
    if (canvas.nodes.length) {
      lines.push(table(["标签", "类型", "位置", "正文", "字数", "模型", "输出", "ID"], canvas.nodes.map(n => [
        n.label, n.type, `${n.position?.x ?? "?"},${n.position?.y ?? "?"}`, n.textPath ?? "", n.chars, n.model ?? "", n.outputs.join(", "), n.id,
      ])), "");
    }
    lines.push(canvas.edges.length ? table(["连线", "从", "到"], canvas.edges.map(e => [e.id, e.from, e.to])) : "连线：无", "");
  }
  lines.push(`## 素材目录（${data.assets.length}）`, "");
  lines.push(data.assets.length ? table(["目录", "归属", "文件数", "所属画布"], data.assets.map(a => [a.path, kindLabel[a.kind], a.files, a.ownerCanvas ?? ""])) : "无", "");
  lines.push(`## 会话（${data.sessions.length}）`, "");
  lines.push(data.sessions.length ? table(["文件", "大小(KB)"], data.sessions.map(s => [s.path, Math.round(s.size / 1024)])) : "无");
  console.log(lines.join("\n"));
  return 0;
}
