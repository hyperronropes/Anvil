import { fileExtension } from "./editorUtils";

type IconSpec = { label: string; bg: string; fg: string };

const ICONS: Record<string, IconSpec> = {
  js: { label: "JS", bg: "#f7df1e", fg: "#1a1a1a" },
  mjs: { label: "JS", bg: "#f7df1e", fg: "#1a1a1a" },
  cjs: { label: "JS", bg: "#f7df1e", fg: "#1a1a1a" },
  jsx: { label: "JS", bg: "#61dafb", fg: "#0d1117" },
  ts: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
  tsx: { label: "TS", bg: "#3178c6", fg: "#ffffff" },
  py: { label: "PY", bg: "#3572a5", fg: "#ffffff" },
  rs: { label: "RS", bg: "#dea584", fg: "#1a1a1a" },
  go: { label: "GO", bg: "#00add8", fg: "#ffffff" },
  json: { label: "{}", bg: "#6b7280", fg: "#f3f4f6" },
  md: { label: "MD", bg: "#519aba", fg: "#ffffff" },
  css: { label: "CSS", bg: "#563d7c", fg: "#ffffff" },
  html: { label: "HTML", bg: "#e34c26", fg: "#ffffff" },
  vue: { label: "VUE", bg: "#41b883", fg: "#1a1a1a" },
  java: { label: "JV", bg: "#b07219", fg: "#ffffff" },
  cpp: { label: "C++", bg: "#f34b7d", fg: "#ffffff" },
  c: { label: "C", bg: "#555555", fg: "#ffffff" },
  cs: { label: "C#", bg: "#178600", fg: "#ffffff" },
  php: { label: "PHP", bg: "#4f5d95", fg: "#ffffff" },
  rb: { label: "RB", bg: "#cc342d", fg: "#ffffff" },
  sh: { label: "SH", bg: "#89e051", fg: "#1a1a1a" },
  bat: { label: "BAT", bg: "#4d4d4d", fg: "#e5e5e5" },
  yml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
  yaml: { label: "YML", bg: "#cb171e", fg: "#ffffff" },
  exe: { label: "EXE", bg: "#6b7280", fg: "#f9fafb" },
  dll: { label: "DLL", bg: "#6b7280", fg: "#f9fafb" },
  jpg: { label: "IMG", bg: "#a855f7", fg: "#ffffff" },
  jpeg: { label: "IMG", bg: "#a855f7", fg: "#ffffff" },
  gif: { label: "IMG", bg: "#a855f7", fg: "#ffffff" },
  webp: { label: "IMG", bg: "#a855f7", fg: "#ffffff" },
  svg: { label: "SVG", bg: "#f59e0b", fg: "#1a1a1a" },
};

function specForPath(path: string, isDir: boolean): IconSpec | "folder" {
  if (isDir) return "folder";
  const ext = fileExtension(path);
  if (ICONS[ext]) return ICONS[ext];
  if (!ext) return { label: "·", bg: "#3f3f46", fg: "#d4d4d8" };
  return { label: ext.slice(0, 3).toUpperCase(), bg: "#3f3f46", fg: "#e4e4e7" };
}

export function FileIcon({ path, isDir = false }: { path: string; isDir?: boolean }) {
  const spec = specForPath(path, isDir);
  if (spec === "folder") {
    return (
      <span className="file-icon file-icon-folder" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="file-icon file-icon-badge" style={{ backgroundColor: spec.bg, color: spec.fg }} aria-hidden>
      {spec.label}
    </span>
  );
}
