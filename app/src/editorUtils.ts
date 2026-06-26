export type TreeNode = {
  kind: "file" | "dir";
  name: string;
  path: string;
  /** null = not loaded yet (lazy); [] = loaded empty folder */
  children?: TreeNode[] | null;
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "apng"]);

const LANG_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  vue: "xml",
  bat: "dos",
};

export function fileExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(fileExtension(path));
}

const BINARY_EXTS = new Set([
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "msi",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "app",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
  "mp3",
  "mp4",
  "wav",
  "flac",
  "avi",
  "mov",
  "mkv",
  "webm",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "sqlite",
  "db",
  "wasm",
  "pyc",
  "class",
  "o",
  "obj",
  "lib",
  "a",
]);

export type FileViewKind = "text" | "image" | "unsupported";

export function fileViewKind(path: string): FileViewKind {
  if (isImageFile(path)) return "image";
  if (BINARY_EXTS.has(fileExtension(path))) return "unsupported";
  return "text";
}

export function languageForPath(path: string): string | null {
  const ext = fileExtension(path);
  return LANG_BY_EXT[ext] ?? null;
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const raw of paths) {
    const filePath = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!filePath) continue;
    const parts = filePath.split("/");
    let level = root;
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      current = current ? `${current}/${part}` : part;
      let node = level.find((n) => n.name === part && n.kind === (isFile ? "file" : "dir"));
      if (!node) {
        node = {
          kind: isFile ? "file" : "dir",
          name: part,
          path: current,
          children: isFile ? undefined : [],
        };
        level.push(node);
      }
      if (!isFile && node.children) level = node.children;
    }
  }
  const walk = (nodes: TreeNode[]): TreeNode[] =>
    sortNodes(nodes).map((n) => (n.children ? { ...n, children: walk(n.children) } : n));
  return walk(root);
}

export const EXPANDED_FOLDERS_KEY = "anvil.expandedFolders";

export function loadExpandedFolders(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(EXPANDED_FOLDERS_KEY) ?? "[]");
    if (Array.isArray(v)) return new Set(v.filter((x) => typeof x === "string"));
  } catch {
    /* ignore */
  }
  return new Set();
}

export function saveExpandedFolders(set: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

export function setDirChildren(tree: TreeNode[], dirPath: string, children: TreeNode[]): TreeNode[] {
  return tree.map((n) => {
    if (n.kind === "dir" && n.path === dirPath) return { ...n, children };
    if (n.kind === "dir" && n.children?.length) {
      return { ...n, children: setDirChildren(n.children, dirPath, children) };
    }
    return n;
  });
}
