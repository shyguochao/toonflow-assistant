export type Severity = "error" | "warn" | "info";

export type Handle = { id: string; type: "source" | "target"; dataType: string | string[]; label?: string };

export type CanvasNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any> & { label?: string; handles?: Handle[]; textPath?: string; model?: string };
  [key: string]: unknown;
};

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
};

export type CanvasJson = {
  toonflowCanvas: true;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
  [key: string]: unknown;
};

export type CanvasFile = {
  /** Path relative to the workspace root, using "/" separators. */
  path: string;
  raw: string;
  canvas?: CanvasJson;
  parseError?: string;
};

export type NodeText = { nodeId: string; path: string; exists: boolean; text: string };

export type AssetDir = {
  /** e.g. "assets/<uuid>" */
  path: string;
  files: string[];
  kind: "node" | "orphan" | "shared";
  ownerCanvas?: string;
};

export type SessionFile = { path: string; size: number };

export type Workspace = {
  root: string;
  name: string;
  canvases: CanvasFile[];
  texts: Map<string, NodeText>;
  assets: AssetDir[];
  sharedFiles: string[];
  sessions: SessionFile[];
};
