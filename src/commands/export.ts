import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CliOptions } from "../cli.ts";
import { isTextNode, scanWorkspace } from "../workspace/scan.ts";
import { assistantHome } from "../workspace/snapshots.ts";
import { charCount, table } from "../output.ts";
import type { Workspace } from "../workspace/model.ts";

const safeName = (name: string) => name.replace(/[\\/:*?"<>|\n\r\t]+/g, "_").trim().slice(0, 80) || "未命名";

/** Text nodes in reading order: canvas file, then top-to-bottom, left-to-right. */
export function orderedTextNodes(ws: Workspace) {
  return ws.canvases.flatMap(file => (file.canvas?.nodes ?? [])
    .filter(isTextNode)
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0))
    .map(node => ({ canvas: file.path, node, text: ws.texts.get(node.id) })));
}

export async function exportMarkdown(ws: Workspace, outDir: string) {
  await mkdir(outDir, { recursive: true });
  const used = new Set<string>();
  const rows: string[][] = [];
  const written: string[] = [];
  for (const { canvas, node, text } of orderedTextNodes(ws)) {
    if (!text?.exists) continue;
    // One folder per canvas (画布/剧本.json → 画布/剧本/), so same-named nodes on different canvases don't collide.
    const dir = canvas.replace(/\.json$/i, "").split("/").map(safeName).join("/");
    const base = safeName(node.data.label ?? node.id);
    let file = `${dir}/${base}.md`;
    for (let i = 2; used.has(file); i++) file = `${dir}/${base}-${i}.md`;
    used.add(file);
    await mkdir(join(outDir, dir), { recursive: true });
    await writeFile(join(outDir, file), text.text);
    written.push(file);
    rows.push([`[${node.data.label ?? node.id}](${encodeURI(file)})`, canvas, String(charCount(text.text)), node.id]);
  }
  const index = [
    `# ${ws.name} 导出`, "", `导出时间：${new Date().toLocaleString("zh-CN")}`, "",
    rows.length ? table(["文档", "画布", "字数", "节点 ID"], rows) : "没有可导出的文本节点。", "",
  ].join("\n");
  await writeFile(join(outDir, "index.md"), index);
  return [...written, "index.md"];
}

export async function run(root: string, options: CliOptions) {
  const ws = await scanWorkspace(root);
  // Default target holds only the latest export: the previous one is replaced. A user-given --out is never wiped.
  const outDir = options.out ?? join(assistantHome(), "exports", ws.name);
  if (!options.out) await rm(outDir, { recursive: true, force: true });
  const files = await exportMarkdown(ws, outDir);
  console.log(`已导出 ${files.length} 个文件到 ${outDir}`);

  if (options.format === "docx") {
    if (!Bun.which("pandoc")) {
      console.log("未找到 pandoc，已只导出 Markdown。安装：brew install pandoc");
      return 0;
    }
    for (const file of files) {
      const proc = Bun.spawnSync(["pandoc", file, "-o", file.replace(/\.md$/, ".docx")], { cwd: outDir });
      if (proc.exitCode !== 0) console.error(`转换失败：${file}：${proc.stderr.toString().trim()}`);
    }
    console.log("已用 pandoc 转换为 .docx。");
  } else if (options.format && options.format !== "md") {
    throw new Error(`不支持的格式：${options.format}（可选 md、docx）`);
  }
  return 0;
}
