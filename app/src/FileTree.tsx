import { useCallback, useEffect, useState } from "react";
import { FileIcon } from "./FileIcon";
import {
  loadExpandedFolders,
  saveExpandedFolders,
  setDirChildren,
  type TreeNode,
} from "./editorUtils";

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  loading,
  activeFile,
  onToggleDir,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  expanded: boolean;
  loading?: boolean;
  activeFile: string | null;
  onToggleDir: (node: TreeNode) => void;
  onOpenFile: (path: string) => void;
}) {
  const pad = 8 + depth * 14;
  const isActive = node.kind === "file" && activeFile === node.path;

  if (node.kind === "dir") {
    return (
      <button
        type="button"
        className="explorer-tree-row explorer-tree-dir"
        style={{ paddingLeft: pad }}
        onClick={() => onToggleDir(node)}
        title={node.path}
      >
        <span className="explorer-tree-chevron text-muted">
          {loading ? <span className="explorer-tree-spinner" /> : expanded ? <ChevronDown /> : <ChevronRight />}
        </span>
        <FileIcon path={node.path} isDir />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`explorer-tree-row explorer-tree-file ${isActive ? "explorer-file-active text-ink" : "text-secondary"}`}
      style={{ paddingLeft: pad }}
      onClick={() => onOpenFile(node.path)}
      title={node.path}
    >
      <span className="explorer-tree-chevron explorer-tree-spacer" aria-hidden />
      <FileIcon path={node.path} />
      <span className="truncate font-mono text-[12px]">{node.name}</span>
    </button>
  );
}

function TreeBranch({
  nodes,
  depth,
  expandedFolders,
  loadingDirs,
  activeFile,
  onToggleDir,
  onOpenFile,
}: {
  nodes: TreeNode[];
  depth: number;
  expandedFolders: Set<string>;
  loadingDirs: Set<string>;
  activeFile: string | null;
  onToggleDir: (node: TreeNode) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const expanded = node.kind === "dir" && expandedFolders.has(node.path);
        const showChildren = expanded && node.kind === "dir" && node.children !== null && node.children !== undefined;
        return (
          <div key={`${node.kind}:${node.path}`}>
            <TreeRow
              node={node}
              depth={depth}
              expanded={expanded}
              loading={node.kind === "dir" && loadingDirs.has(node.path)}
              activeFile={activeFile}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
            {showChildren && node.children!.length > 0 && (
              <TreeBranch
                nodes={node.children!}
                depth={depth + 1}
                expandedFolders={expandedFolders}
                loadingDirs={loadingDirs}
                activeFile={activeFile}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            )}
            {expanded && node.kind === "dir" && node.children?.length === 0 && (
              <div className="py-1 text-xs text-faint" style={{ paddingLeft: 8 + (depth + 1) * 14 + 20 }}>
                Empty folder
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

async function fetchDir(relPath: string): Promise<TreeNode[]> {
  const dc = (window as any).anvil;
  const rows = (await dc?.listProjectDir?.(relPath)) ?? [];
  return rows.map((n: TreeNode) => (n.kind === "dir" ? { ...n, children: null } : n));
}

export function FileTree({
  rootName,
  reloadKey,
  activeFile,
  onOpenFile,
}: {
  rootName: string;
  reloadKey: string;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    const saved = loadExpandedFolders();
    saved.add("");
    return saved;
  });

  useEffect(() => {
    saveExpandedFolders(expandedFolders);
  }, [expandedFolders]);

  const loadRoot = useCallback(async () => {
    setRootLoading(true);
    try {
      const nodes = await fetchDir("");
      setTree(nodes);
    } catch {
      setTree([]);
    } finally {
      setRootLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot, reloadKey]);

  const ensureChildren = useCallback(async (dirPath: string) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const children = await fetchDir(dirPath);
      setTree((prev) => setDirChildren(prev, dirPath, children));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  const onToggleDir = useCallback(
    (node: TreeNode) => {
      if (node.kind !== "dir") return;
      const isOpen = expandedFolders.has(node.path);
      if (isOpen) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          next.delete(node.path);
          return next;
        });
        return;
      }
      if (node.children === null || node.children === undefined) {
        void ensureChildren(node.path);
      }
      setExpandedFolders((prev) => new Set(prev).add(node.path));
    },
    [expandedFolders, ensureChildren],
  );

  const toggleRoot = () => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has("")) next.delete("");
      else next.add("");
      return next;
    });
  };

  const rootOpen = expandedFolders.has("");

  return (
    <div className="file-tree py-1">
      <button
        type="button"
        className="explorer-tree-row explorer-tree-dir font-medium"
        style={{ paddingLeft: 8 }}
        onClick={toggleRoot}
        title={rootName}
      >
        <span className="explorer-tree-chevron text-muted">
          {rootLoading ? <span className="explorer-tree-spinner" /> : rootOpen ? <ChevronDown /> : <ChevronRight />}
        </span>
        <FileIcon path={rootName} isDir />
        <span className="truncate text-secondary">{rootName}</span>
      </button>
      {rootOpen && (
        <>
          {!rootLoading && tree.length === 0 ? (
            <div className="px-3 py-2 pl-9 text-xs text-faint">No files here yet</div>
          ) : (
            <TreeBranch
              nodes={tree}
              depth={1}
              expandedFolders={expandedFolders}
              loadingDirs={loadingDirs}
              activeFile={activeFile}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          )}
        </>
      )}
    </div>
  );
}
