/**
 * Node templates for Toonflow canvas files.
 *
 * Source: HBAI-Ltd/Toonflow-app @ af6e884 (2026-10-27), derived from
 * packages/nodes/<name>/src/index.vue (handles + `data.value.x ??=` defaults)
 * and packages/nodeScaffold/src/useNode.ts (outputs are filtered against handles on load),
 * cross-checked with a canvas saved by the app (the fictional test/fixtures/sample-workspace mirrors its exact shape).
 *
 * Toonflow fills missing defaults when a node mounts, so a minimal `data` loads correctly.
 */

export const toonflowVersion = "af6e884";

export type HandleTemplate = { id: string; type: "source" | "target"; dataType: string | string[]; label: string };

export const nodeHandles: Record<string, HandleTemplate[]> = {
  textNode: [
    { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "STRING", "FILE"], label: "视频、图片、文本、文件输入" },
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ],
  imageNode: [
    { id: "in", type: "target", dataType: "IMAGE", label: "来源图片" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ],
  imageGenerationNode: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ],
  videoGenerationNode: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ],
};

/** Plugin nodes are registered as `remote-<name>` (observed in app-saved canvases). */
export const nodeTypeName = (name: string) => `remote-${name}`;
export const baseNodeName = (type: string) => type.replace(/^remote-/, "");

/** Text nodes must store their body at exactly this path (textNode/index.vue:101,146). */
export const textPathFor = (nodeId: string) => `assets/${nodeId}/content.md`;

export function newTextNode(id: string, label: string, position: { x: number; y: number }, model?: string) {
  return {
    id,
    type: nodeTypeName("textNode"),
    initialized: false,
    position,
    data: {
      label,
      handles: structuredClone(nodeHandles.textNode),
      outputs: {},
      ...(model ? { model } : {}),
      textPath: textPathFor(id),
      promptModel: [[{ type: "Write", text: "" }]],
    },
  };
}

/** Horizontal gap the app's arrangeCanvas uses between neighbouring text nodes (observed: 460). */
export const nodeGapX = 460;
