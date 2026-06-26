import { useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode, type RefObject, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import logoUrl from "../assets/logo.png";
import { CodeEditor } from "./CodeEditor";
import { FileTree } from "./FileTree";
import { FileIcon } from "./FileIcon";
import { fileViewKind, type FileViewKind } from "./editorUtils";
import "highlight.js/styles/github-dark.css";

// --- bridge event protocol ----------------------------------------------------
type WsEvent =
  | { type: "thinking" }
  | { type: "reasoning"; level: string }
  | { type: "reasoning_stage"; stage: string; label: string; step: number; total_steps: number }
  | { type: "reasoning_delta"; stage: string; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean }
  | { type: "permission_request"; id: string; name: string; args: Record<string, unknown> }
  | { type: "quiz_request"; id: string; question: string; options: string[] }
  | { type: "tokens"; count: number }
  | { type: "turn_done"; text: string; sessionId?: string }
  | { type: "cancelled" }
  | { type: "loaded"; session: StoredSession }
  | { type: "error"; text: string }
  | UltraCodeStatus;

type UltraCodeAgent = { agent_id: string; name: string; status: string; action: string; tokens: number; tool_calls: number; elapsed: number };
type UltraCodeGroup = { id: string; role: string; goal: string; depends_on: string[]; status: string; agents: UltraCodeAgent[] };
type UltraCodeStatus = { type: "ultracode_status"; id: string; task: string; finished: boolean; failed: boolean; error: string; groups: UltraCodeGroup[] };

type PermissionRequest = { id: string; name: string; args: Record<string, unknown> };
type QuizRequest = { id: string; question: string; options: string[] };

type ToolCard = { name: string; args: Record<string, unknown>; ok?: boolean };
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: ToolCard[]; streaming: boolean };

type ModelInfo = { id: string; name: string; provider: string; tier: string };
type SessionMeta = { id: string; title: string; model: string; created: string; count: number; snippet?: string };
type StoredSession = { id: string; title?: string; model?: string; messages: { role: string; content: string }[] };

type McpServerStatus = {
  name: string;
  disabled: boolean;
  status: string;
  error: string;
  tools: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
};

type RobloxMcpStatus = {
  installed: boolean;
  installDir: string;
  entryScript: string;
  nodeAvailable: boolean;
  nodeOnPath?: boolean;
  bundledNode?: boolean;
  bundledNodeDir?: string;
  canAutoDownloadNode?: boolean;
  nodeVersion: string;
  nodeSource?: string;
  nodeError?: string;
  loaderScript: string;
  loaderPath: string;
  dashboardUrl: string;
  serverName: string;
  mcpConnected?: boolean;
  mcpStatus?: McpServerStatus | null;
};

type SkillInfo = {
  id: string;
  name: string;
  description: string;
  scope: string;
  path: string;
  enabled: boolean;
};

type SkillsState = {
  globalDir: string;
  projectDir: string;
  cursorGlobalDir: string;
  configPath: string;
  skills: SkillInfo[];
  enabledCount: number;
};

type EditorTab = {
  path: string;
  content: string;
  savedContent: string;
  kind: FileViewKind;
  imageUrl?: string;
  loading?: boolean;
  error?: string;
};

function toProjectRelPath(toolPath: string, projectDir: string): string {
  const normalized = normalizeRelPath(toolPath);
  if (!projectDir) return normalized;
  const root = normalizeRelPath(projectDir).replace(/\/+$/, "");
  const lowerRoot = root.toLowerCase();
  const lowerPath = normalized.toLowerCase();
  if (lowerPath === lowerRoot) return "";
  const prefix = lowerRoot + "/";
  if (lowerPath.startsWith(prefix)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);
const FILE_OPEN_TOOLS = new Set([...FILE_WRITE_TOOLS, "read_file"]);

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function tabBasename(relPath: string): string {
  const parts = normalizeRelPath(relPath).split("/");
  return parts[parts.length - 1] || relPath;
}

function filePathsMatch(openRel: string, toolPath: string, projectDir: string): boolean {
  const open = normalizeRelPath(openRel).toLowerCase();
  const tool = normalizeRelPath(toolPath).toLowerCase();
  if (open === tool) return true;
  if (open.endsWith("/" + tool) || tool.endsWith("/" + open)) return true;
  if (projectDir) {
    const root = normalizeRelPath(projectDir).replace(/\/+$/, "").toLowerCase();
    const absOpen = `${root}/${open}`;
    const absTool = tool.startsWith(root) ? tool : `${root}/${tool}`;
    if (absOpen === absTool) return true;
  }
  return false;
}

function toolFilePath(args: Record<string, unknown> | undefined): string | null {
  const p = args?.path;
  return typeof p === "string" ? p : null;
}

const BRIDGE: string = (window as any).anvil?.bridgeUrl ?? "ws://127.0.0.1:8765/ws";
const API: string = (window as any).anvil?.apiUrl ?? "http://127.0.0.1:8765";

const SOURCE_REPO = "https://github.com/hyperronropes/Anvil";
const UPSTREAM_REPO = "https://github.com/Schnickenpick/DeepCodev3";
const DEEPCODE_DISCORD = "https://discord.gg/8WU56Drt7F";

const EXPLORER_KEY = "anvil.explorerOpen";
const CHAT_WIDTH_KEY = "anvil.chatWidth";
const EXPLORER_WIDTH_KEY = "anvil.explorerWidth";
const CHAT_WIDTH_MIN = 280;
const CHAT_WIDTH_MAX = 720;
const EXPLORER_WIDTH_MIN = 180;
const EXPLORER_WIDTH_MAX = 520;
const MODELS_POLL_MS = 30_000;

function loadStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? "", 10);
    if (!Number.isNaN(v)) return Math.min(max, Math.max(min, v));
  } catch {
    /* ignore */
  }
  return fallback;
}

type AgentMode = "off" | "ask" | "auto";

const AGENT_MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: "off", label: "Ask", hint: "Chat only — no tools" },
  { id: "ask", label: "Agent", hint: "Edits & commands — asks permission" },
  { id: "auto", label: "Auto", hint: "Agent — tools auto-approved" },
];

const REASONING_LEVELS = ["off", "low", "middle", "high", "ultra"];

function loadExplorerOpen(): boolean {
  try {
    const v = localStorage.getItem(EXPLORER_KEY);
    if (v === "true" || v === "false") return v === "true";
  } catch {
    /* ignore */
  }
  return false;
}

function folderLabel(dir: string) {
  if (!dir) return "No folder";
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [apiUp, setApiUp] = useState(false);
  const [bridgeUp, setBridgeUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [thinkingLabel, setThinkingLabel] = useState("Thinking…");
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(loadExplorerOpen);
  const [chatWidth, setChatWidth] = useState(() => loadStoredWidth(CHAT_WIDTH_KEY, 420, CHAT_WIDTH_MIN, CHAT_WIDTH_MAX));
  const [explorerWidth, setExplorerWidth] = useState(() =>
    loadStoredWidth(EXPLORER_WIDTH_KEY, 260, EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectBasename, setProjectBasename] = useState("Anvil");
  const [explorerReloadKey, setExplorerReloadKey] = useState("0");
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);

  // toggles — Agent defaults OFF
  const [agentMode, setAgentMode] = useState<"off" | "ask" | "auto">("off");
  const [reasoning, setReasoning] = useState("off");
  const [permRequest, setPermRequest] = useState<PermissionRequest | null>(null);
  const permQueueRef = useRef<PermissionRequest[]>([]);
  const [quizRequest, setQuizRequest] = useState<QuizRequest | null>(null);
  const [projectDir, setProjectDir] = useState<string>("");

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionMeta[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [ultracode, setUltracode] = useState<UltraCodeStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "prompt" | "skills" | "mcp">("general");
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpToolCount, setMcpToolCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const editorTabsRef = useRef(editorTabs);
  const lastToolFilePathRef = useRef<string | null>(null);
  const reloadEditorFileRef = useRef<(toolPath: string) => void>(() => {});

  useEffect(() => {
    editorTabsRef.current = editorTabs;
  }, [editorTabs]);

  // --- websocket (single socket; no StrictMode) ------------------------------
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (!alive) return;
      const ex = wsRef.current;
      if (ex && (ex.readyState === WebSocket.OPEN || ex.readyState === WebSocket.CONNECTING)) return;
      const ws = new WebSocket(BRIDGE);
      wsRef.current = ws;
      ws.onopen = () => {
        if (!alive) return;
        setConnected(true);
      };
      ws.onclose = () => {
        if (!alive || wsRef.current !== ws) return;
        setConnected(false);
        retry = setTimeout(connect, 300);
      };
      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        handleEvent(JSON.parse(ev.data) as WsEvent);
      };
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(retry);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(EXPLORER_KEY, String(explorerOpen));
    } catch {
      /* ignore */
    }
  }, [explorerOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
      localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth));
    } catch {
      /* ignore */
    }
  }, [chatWidth, explorerWidth]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--chat-width", `${chatWidth}px`);
    document.documentElement.style.setProperty("--explorer-width", `${explorerWidth}px`);
  }, [chatWidth, explorerWidth]);

  const resizeChat = useCallback(
    (delta: number) => setChatWidth((w) => Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, w + delta))),
    [],
  );
  const resizeExplorer = useCallback(
    (delta: number) =>
      setExplorerWidth((w) => Math.min(EXPLORER_WIDTH_MAX, Math.max(EXPLORER_WIDTH_MIN, w - delta))),
    [],
  );

  const refreshProjectMeta = useCallback(() => {
    const dc = (window as any).anvil;
    dc?.getProjectBasename?.().then((n: string) => n && setProjectBasename(n));
    setExplorerReloadKey(String(Date.now()));
  }, []);

  const reloadEditorFromDisk = useCallback(
    async (toolPath: string, force = false) => {
      const dc = (window as any).anvil;
      if (!dc?.readProjectFile) return;
      const tabs = editorTabsRef.current.filter((t) => t.kind === "text" && filePathsMatch(t.path, toolPath, projectDir));
      await Promise.all(
        tabs.map(async (tab) => {
          try {
            const text = await dc.readProjectFile(tab.path);
            setEditorTabs((prev) =>
              prev.map((t) => {
                if (t.path !== tab.path) return t;
                const dirty = t.content !== t.savedContent;
                if (dirty && !force) return t;
                return { ...t, content: text, savedContent: text, loading: false, error: undefined };
              }),
            );
          } catch {
            /* ignore transient read errors during agent writes */
          }
        }),
      );
      refreshProjectMeta();
    },
    [projectDir, refreshProjectMeta],
  );

  useEffect(() => {
    reloadEditorFileRef.current = (toolPath: string) => {
      void reloadEditorFromDisk(toolPath, true);
    };
  }, [reloadEditorFromDisk]);

  const openEditorFile = useCallback(async (relPath: string) => {
    const dc = (window as any).anvil;
    if (!dc?.readProjectFile) return;
    const normalized = normalizeRelPath(relPath);
    const kind = fileViewKind(normalized);
    setActiveEditorPath(normalized);
    setEditorTabs((prev) => {
      if (prev.some((t) => t.path === normalized)) return prev;
      return [
        ...prev,
        {
          path: normalized,
          content: "",
          savedContent: "",
          kind,
          loading: kind !== "unsupported",
        },
      ];
    });
    if (kind === "unsupported") {
      setEditorTabs((prev) =>
        prev.map((t) => (t.path === normalized ? { ...t, loading: false, error: undefined } : t)),
      );
      return;
    }
    if (kind === "image") {
      if (!dc.readProjectFileBinary) {
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.path === normalized ? { ...t, loading: false, error: "Image preview unavailable" } : t,
          ),
        );
        return;
      }
      try {
        const { dataUrl } = await dc.readProjectFileBinary(normalized);
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.path === normalized
              ? { ...t, kind: "image", imageUrl: dataUrl, loading: false, error: undefined }
              : t,
          ),
        );
      } catch (err) {
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.path === normalized
              ? { ...t, loading: false, error: err instanceof Error ? err.message : String(err) }
              : t,
          ),
        );
      }
      return;
    }
    try {
      const content = await dc.readProjectFile(normalized);
      setEditorTabs((prev) =>
        prev.map((t) =>
          t.path === normalized ? { ...t, content, savedContent: content, loading: false, error: undefined } : t,
        ),
      );
    } catch (err) {
      setEditorTabs((prev) =>
        prev.map((t) =>
          t.path === normalized
            ? { ...t, loading: false, error: err instanceof Error ? err.message : String(err) }
            : t,
        ),
      );
    }
  }, []);

  const closeEditorTab = useCallback(
    (relPath: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      setEditorTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === relPath);
        if (idx < 0) return prev;
        const next = prev.filter((t) => t.path !== relPath);
        if (activeEditorPath === relPath) {
          const pick = next[Math.min(idx, next.length - 1)] ?? next[next.length - 1];
          setActiveEditorPath(pick?.path ?? null);
        }
        return next;
      });
    },
    [activeEditorPath],
  );

  const updateEditorContent = useCallback((relPath: string, content: string) => {
    setEditorTabs((prev) => prev.map((t) => (t.path === relPath ? { ...t, content } : t)));
  }, []);

  const saveEditorTab = useCallback(
    async (relPath?: string) => {
      const dc = (window as any).anvil;
      const target = relPath ?? activeEditorPath;
      if (!target || !dc?.writeProjectFile) return;
      const tab = editorTabsRef.current.find((t) => t.path === target);
      if (!tab || tab.loading || tab.kind !== "text") return;
      try {
        await dc.writeProjectFile(target, tab.content);
        setEditorTabs((prev) =>
          prev.map((t) => (t.path === target ? { ...t, savedContent: t.content, error: undefined } : t)),
        );
        refreshProjectMeta();
      } catch (err) {
        setEditorTabs((prev) =>
          prev.map((t) =>
            t.path === target ? { ...t, error: err instanceof Error ? err.message : String(err) } : t,
          ),
        );
      }
    },
    [activeEditorPath, refreshProjectMeta],
  );

  useEffect(() => {
    if (!busy) return;
    const dc = (window as any).anvil;
    if (!dc?.readProjectFile) return;
    const id = setInterval(() => {
      const tabs = editorTabsRef.current;
      if (!tabs.length) return;
      void Promise.all(
        tabs
          .filter((tab) => tab.kind === "text")
          .map(async (tab) => {
          try {
            const disk = await dc.readProjectFile(tab.path);
            setEditorTabs((prev) =>
              prev.map((t) => {
                if (t.path !== tab.path || t.loading) return t;
                if (disk === t.content) return t;
                const dirty = t.content !== t.savedContent;
                if (dirty) return t;
                return { ...t, content: disk, savedContent: disk };
              }),
            );
          } catch {
            /* ignore */
          }
        }),
      );
    }, 600);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s" && activeEditorPath) {
        e.preventDefault();
        void saveEditorTab(activeEditorPath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeEditorPath, saveEditorTab]);

  const openSettings = useCallback((tab: "general" | "prompt" | "skills" | "mcp" = "general") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const refreshMcp = useCallback(() => {
    fetch(`${API}/api/mcp`)
      .then((r) => r.json())
      .then((d) => {
        const servers = (d.servers ?? []) as McpServerStatus[];
        setMcpServers(servers);
        setMcpToolCount(servers.reduce((n, s) => n + (s.tools?.length ?? 0), 0));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshProjectMeta();
  }, [projectDir, refreshProjectMeta]);

  const refreshServiceStatus = useCallback(() => {
    fetch(`${API}/api/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setBridgeUp(Boolean(d.bridge));
        setApiUp(Boolean(d.proxy));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const dc = (window as any).anvil;
    const off = dc?.onBridgeStatus?.((s: { bridge?: boolean; proxy?: boolean; ready?: boolean }) => {
      if (typeof s?.bridge === "boolean") setBridgeUp(s.bridge);
      if (typeof s?.proxy === "boolean") setApiUp(s.proxy);
      // Legacy shape from older builds.
      if (typeof s?.ready === "boolean" && typeof s?.proxy !== "boolean") setApiUp(s.ready);
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!connected) return;
    refreshServiceStatus();
    const id = window.setInterval(refreshServiceStatus, 4000);
    return () => window.clearInterval(id);
  }, [connected, refreshServiceStatus]);

  useEffect(() => {
    if (connected) refreshMcp();
  }, [connected, refreshMcp]);

  const refreshModels = useCallback(() => {
    fetch(`${API}/api/models`)
      .then((r) => r.json())
      .then((d) => {
        const next = (d.models ?? []) as ModelInfo[];
        setModels(next);
        setModel((cur) => {
          if (cur && next.some((m) => m.id === cur)) return cur;
          return (d.default as string) || next[0]?.id || cur;
        });
      })
      .catch(() => {});
  }, []);

  const refreshSessions = useCallback(() => {
    fetch(`${API}/api/sessions`)
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!connected) return;
    refreshModels();
    const id = window.setInterval(refreshModels, MODELS_POLL_MS);
    return () => window.clearInterval(id);
  }, [connected, refreshModels]);

  const persistAgentMode = useCallback((mode: AgentMode) => {
    setAgentMode(mode);
    fetch(`${API}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { gui_agent_mode: mode } }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API}/api/config`).then((r) => r.json()).then((d) => {
      const mode = d.agentMode;
      setAgentMode(mode === "auto" || mode === "ask" ? mode : "off");
      setReasoning(d.reasoning ?? "off");
    }).catch(() => {});
    refreshSessions();
    (window as any).anvil?.getProjectDir?.().then((d: string) => d && setProjectDir(d)).catch(() => {});
  }, [refreshSessions]);

  const pickProject = async () => {
    const dir = await (window as any).anvil?.pickProjectDir?.();
    if (dir) {
      setProjectDir(dir);
      setEditorTabs([]);
      setActiveEditorPath(null);
      // The bridge process gets restarted (main.js) against the new folder.
      // Its old socket connection drops; the websocket effect's
      // reconnect-on-close logic picks it back up once it's listening again.
      // Clear local state since the new bridge process has no in-memory
      // conversation for us yet (it's a brand-new process).
      setMessages([]);
      setActiveId(null);
      refreshSessions();
      refreshProjectMeta();
    }
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking, quizRequest, permRequest]);

  // --- event handling --------------------------------------------------------
  const handleEvent = useCallback((ev: WsEvent) => {
    if (ev.type === "ultracode_status") {
      setUltracode(ev);
      setBusy(!ev.finished);
      setThinking(false);
      return;
    }
    if (ev.type === "permission_request") {
      // Queue rather than clobber: a turn can fire multiple tool calls before
      // the user answers the first prompt.
      permQueueRef.current.push({ id: ev.id, name: ev.name, args: ev.args });
      setPermRequest((cur) => cur ?? permQueueRef.current.shift() ?? null);
      return;
    }
    if (ev.type === "quiz_request") {
      const quiz = { id: ev.id, question: ev.question, options: ev.options };
      setQuizRequest(quiz);
      setThinking(false);
      // Show the question in the thread; options live in the bottom bar (Cursor-style).
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.text.includes(ev.question)) return prev;
        return [
          ...prev,
          { role: "assistant", text: ev.question, tools: [], streaming: false },
        ];
      });
      return;
    }
    if (ev.type === "loaded") {
      const s = ev.session;
      setActiveId(s.id);
      setMessages(
        (s.messages ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) =>
            m.role === "user"
              ? { role: "user", text: m.content }
              : { role: "assistant", text: m.content, tools: [], streaming: false }
          )
      );
      setThinking(false);
      setBusy(false);
      return;
    }
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      const ensure = (): Msg & { role: "assistant" } => {
        if (last && last.role === "assistant" && last.streaming) return last as any;
        const fresh = { role: "assistant" as const, text: "", tools: [], streaming: true };
        next.push(fresh);
        return fresh;
      };
      switch (ev.type) {
        case "thinking":
          setThinking(true);
          break;
        case "reasoning":
          setThinking(true);
          setThinkingLabel(`Reasoning (${ev.level})…`);
          break;
        case "reasoning_stage":
          setThinking(true);
          setThinkingLabel(ev.label ? `${ev.label}… (${ev.step}/${ev.total_steps})` : "Thinking…");
          setThinkingText((t) => (t ? t + "\n\n" : "") + `── ${ev.label} ──\n`);
          break;
        case "reasoning_delta":
          setThinkingText((t) => t + ev.text);
          break;
        case "delta":
          ensure().text += ev.text;
          setThinking(false);
          break;
        case "tool_call":
          ensure().tools.push({ name: ev.name, args: ev.args });
          setThinking(false);
          if (FILE_WRITE_TOOLS.has(ev.name)) {
            const p = toolFilePath(ev.args);
            if (p) lastToolFilePathRef.current = p;
          }
          break;
        case "tool_result": {
          const a = ensure();
          for (let i = a.tools.length - 1; i >= 0; i--)
            if (a.tools[i].name === ev.name && a.tools[i].ok === undefined) {
              a.tools[i].ok = ev.ok;
              break;
            }
          if (FILE_WRITE_TOOLS.has(ev.name) && ev.ok && lastToolFilePathRef.current) {
            const p = lastToolFilePathRef.current;
            queueMicrotask(() => reloadEditorFileRef.current(p));
          }
          break;
        }
        case "turn_done": {
          const a = ensure();
          // Backend's cleaned text is authoritative — it has tool-call JSON
          // and quiz tags stripped out; streamed deltas may still contain
          // an in-progress tag's leading text that didn't get caught.
          if (ev.text) a.text = ev.text;
          a.streaming = false;
          setThinking(false);
          setBusy(false);
          if (ev.sessionId) setActiveId(ev.sessionId);
          setTimeout(refreshSessions, 200);
          break;
        }
        case "cancelled": {
          const a = ensure();
          a.streaming = false;
          setThinking(false);
          setBusy(false);
          break;
        }
        case "error": {
          const a = ensure();
          a.text += `\n\n[error] ${ev.text}`;
          a.streaming = false;
          setThinking(false);
          setBusy(false);
          break;
        }
      }
      return next;
    });
  }, [refreshSessions]);

  const send = () => {
    const text = input.trim();
    if (!text || !connected) return;
    if (!apiUp) {
      setMessages((m) => [
        ...m,
        { role: "user", text },
        {
          role: "assistant",
          text:
            "The model API is not running yet. Anvil starts **proxy.exe** in the background on port 8000 — if chat hangs on “Thinking”, that process was blocked or is still starting.\n\n" +
            "• Share the **whole** `Anvil` folder (not just Anvil.exe)\n" +
            "• Allow **proxy.exe** through Windows Defender / antivirus\n" +
            "• Open **Settings → General → latest.log** for details\n" +
            "• Wait ~30s after launch — the API warms up on first run",
          tools: [],
          streaming: false,
        },
      ]);
      setInput("");
      return;
    }
    // Cursor-style: answer a pending quiz from the composer instead of blocking modal.
    if (quizRequest) {
      answerQuiz(text);
      setInput("");
      return;
    }
    if (busy) return;
    if (text.startsWith("/ultracode ")) {
      runUltracode(text.slice("/ultracode ".length).trim());
      return;
    }
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    setThinking(true);
    setThinkingLabel("Thinking…");
    setThinkingText("");
    setThinkingOpen(false);
    setUltracode(null);
    wsRef.current?.send(JSON.stringify({
      type: "chat",
      text,
      opts: {
        model,
        reasoning,
        agent: agentMode !== "off",
        // "ask" -> MODE_INTERACTIVE (permission_request round-trip);
        // "auto" -> MODE_AUTO (auto-allow, no prompts). See server.py run_turn.
        interactive: agentMode === "ask",
      },
    }));
  };

  const runUltracode = (task: string) => {
    if (!task || !connected || busy) return;
    setMessages((m) => [...m, { role: "user", text: `/ultracode ${task}` }]);
    setInput("");
    setBusy(true);
    setThinking(false);
    setUltracode({ type: "ultracode_status", id: "", task, finished: false, failed: false, error: "", groups: [] });
    wsRef.current?.send(JSON.stringify({ type: "ultracode", text: task, opts: { model } }));
  };

  const stop = () => {
    wsRef.current?.send(JSON.stringify({ type: "stop" }));
  };

  const respondPermission = (decision: "allow" | "allow_always" | "deny" | "deny_always") => {
    if (!permRequest) return;
    wsRef.current?.send(JSON.stringify({
      type: "permission_response",
      id: permRequest.id,
      decision,
    }));
    setPermRequest(permQueueRef.current.shift() ?? null);
  };

  const answerQuiz = (answer: string) => {
    if (!quizRequest) return;
    wsRef.current?.send(JSON.stringify({
      type: "quiz_response",
      id: quizRequest.id,
      answer,
    }));
    setMessages((m) => [...m, { role: "user", text: answer }]);
    setQuizRequest(null);
    setThinking(true);
    setThinkingLabel("Thinking…");
  };

  const deleteChat = async (id: string) => {
    const ok = await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => d.ok)
      .catch(() => false);
    setConfirmDeleteId(null);
    if (!ok) return;
    if (activeId === id) {
      wsRef.current?.send(JSON.stringify({ type: "new" }));
      setMessages([]);
      setActiveId(null);
      setUltracode(null);
      setQuizRequest(null);
    }
    refreshSessions();
  };

  const activeModel = models.find((m) => m.id === model);
  const activeMode = AGENT_MODES.find((m) => m.id === agentMode) ?? AGENT_MODES[0];

  const newChat = () => {
    wsRef.current?.send(JSON.stringify({ type: "new" }));
    setMessages([]);
    setActiveId(null);
    setUltracode(null);
  };
  const loadChat = (id: string) => {
    wsRef.current?.send(JSON.stringify({ type: "load", id }));
    setUltracode(null);
    setSearchOpen(false);
  };

  const startRename = (s: SessionMeta) => {
    setRenamingId(s.id);
    setRenameValue(s.title);
  };
  const commitRename = async () => {
    if (!renamingId) return;
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    await fetch(`${API}/api/sessions/${renamingId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }).catch(() => {});
    refreshSessions();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setExplorerOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`${API}/api/sessions/search?q=${encodeURIComponent(searchQuery.trim())}`)
        .then((r) => r.json())
        .then((d) => setSearchResults(d.sessions ?? []))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [searchOpen, searchQuery]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const chatTitle = messages.length
    ? (sessions.find((s) => s.id === activeId)?.title ?? "Chat")
    : "New Chat";

  return (
    <div className="relative flex h-full flex-col bg-base text-[13px] text-ink">
      {searchOpen && (
        <SearchDialog
          query={searchQuery}
          onQuery={setSearchQuery}
          results={searchResults}
          onPick={loadChat}
          onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          initialTab={settingsTab}
          models={models}
          model={model}
          onModel={setModel}
          agentMode={agentMode}
          onAgentMode={persistAgentMode}
          onClose={() => { setSettingsOpen(false); refreshMcp(); }}
        />
      )}

      <TitleBar
        title={projectBasename}
        projectDir={projectDir}
        onNewChat={newChat}
        onSearch={() => setSearchOpen(true)}
        onPickFolder={pickProject}
        onToggleExplorer={() => setExplorerOpen((v) => !v)}
        onSettings={() => openSettings("general")}
        explorerOpen={explorerOpen}
        mcpToolCount={mcpToolCount}
      />

      <div className="flex min-h-0 flex-1">
        {/* Left — AI chat (Cursor primary panel) */}
        <section
          className="flex shrink-0 flex-col border-r border-border bg-sidebar"
          style={{ width: chatWidth }}
        >
          <div className="titlebar-no-drag flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
            <button type="button" onClick={() => setHistoryOpen((v) => !v)} className="ide-btn-ghost h-7 w-7" title="Chat history">
              <IconHistory />
            </button>
            <button type="button" onClick={newChat} className="ide-btn-ghost h-7 w-7" title="New chat (Ctrl+Shift+L)">
              <IconPlus />
            </button>
            <span className="min-w-0 flex-1 truncate px-1 text-xs text-secondary">{chatTitle}</span>
          </div>

          {historyOpen && (
            <div className="titlebar-no-drag max-h-48 shrink-0 overflow-y-auto border-b border-border py-1">
              {sessions.map((s) => (
                <ChatHistoryRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  renaming={renamingId === s.id}
                  renameValue={renameValue}
                  confirmingDelete={confirmDeleteId === s.id}
                  onSelect={() => {
                    loadChat(s.id);
                    setHistoryOpen(false);
                  }}
                  onStartRename={() => startRename(s)}
                  onRenameChange={setRenameValue}
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenamingId(null)}
                  onRequestDelete={() => setConfirmDeleteId(s.id)}
                  onConfirmDelete={() => deleteChat(s.id)}
                  onCancelDelete={() => setConfirmDeleteId(null)}
                />
              ))}
              {sessions.length === 0 && (
                <div className="px-3 py-2 text-xs text-faint">No history</div>
              )}
            </div>
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-5">
              {messages.map((m, i) => (
                <MessageView
                  key={i}
                  msg={m}
                  projectDir={projectDir}
                  onOpenFile={(path) => void openEditorFile(path)}
                />
              ))}
              {thinking && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setThinkingOpen((v) => !v)}
                    disabled={!thinkingText}
                    className="ide-btn-ghost flex w-fit items-center gap-2 px-1 text-xs text-muted"
                  >
                    <Spinner /> {thinkingLabel}
                  </button>
                  {thinkingOpen && thinkingText && (
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11px] text-muted">
                      {thinkingText}
                    </div>
                  )}
                </div>
              )}
              {ultracode && <UltraCodePanel status={ultracode} />}
            </div>
          </div>

          <div className="titlebar-no-drag shrink-0 p-3 pt-0">
            {!apiUp && connected && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-100/90">
                <span className="mt-0.5 shrink-0 text-amber-400">!</span>
                <div className="min-w-0 flex-1">
                  Model API offline — chat will hang until <span className="font-mono">proxy.exe</span> starts.
                  Check <span className="font-mono">latest.log</span> in Settings.
                </div>
                <button
                  type="button"
                  className="shrink-0 text-amber-300/80 hover:text-amber-100"
                  onClick={() => (window as any).anvil?.openServiceLogs?.()}
                >
                  Logs
                </button>
              </div>
            )}
            {permRequest && (
              <InlinePermissionBar request={permRequest} onChoose={respondPermission} />
            )}
            {quizRequest && (
              <InlineQuizBar request={quizRequest} onAnswer={answerQuiz} />
            )}
            <AnvilComposer
              input={input}
              onInput={setInput}
              onKeyDown={onKey}
              connected={connected}
              busy={busy}
              quizRequest={quizRequest}
              onSend={send}
              onStop={stop}
              agentMode={agentMode}
              modeMenuOpen={modeMenuOpen}
              modelMenuOpen={modelMenuOpen}
              onModeMenuOpen={setModeMenuOpen}
              onModelMenuOpen={setModelMenuOpen}
              onAgentMode={persistAgentMode}
              models={models}
              model={model}
              onModel={setModel}
              reasoning={reasoning}
              onReasoning={setReasoning}
            />
          </div>
        </section>

        <PanelResizeHandle side="left" onResize={resizeChat} />

        {/* Center — welcome or open file tabs + editor */}
        <div className="flex min-w-0 flex-1">
          {editorTabs.length > 0 ? (
            <FileEditorWorkspace
              tabs={editorTabs}
              activePath={activeEditorPath}
              onSelectTab={setActiveEditorPath}
              onCloseTab={closeEditorTab}
              onChangeContent={updateEditorContent}
              onSave={() => void saveEditorTab()}
            />
          ) : (
            <EditorCenter
              onNewChat={newChat}
              onSearch={() => setSearchOpen(true)}
              onPickFolder={pickProject}
              onToggleExplorer={() => setExplorerOpen((v) => !v)}
              onSettings={() => openSettings("mcp")}
              projectName={projectBasename}
              mcpToolCount={mcpToolCount}
            />
          )}

          <ExplorerRail open={explorerOpen} onToggle={() => setExplorerOpen((v) => !v)} />

          {explorerOpen && (
            <>
              <PanelResizeHandle side="right" onResize={resizeExplorer} />
              <ExplorerPanel
                name={projectBasename}
                reloadKey={explorerReloadKey}
                width={explorerWidth}
                activeFile={activeEditorPath}
                onOpenFile={(path) => void openEditorFile(path)}
                onPickFolder={pickProject}
              />
            </>
          )}
        </div>
      </div>

      <footer className="flex h-[var(--statusbar-height)] shrink-0 items-center gap-3 border-t border-border bg-[var(--bg-statusbar)] px-3 font-mono text-[11px] text-muted">
        <span className="flex items-center gap-1.5" title="Local chat bridge (port 8765)">
          <span className={`h-1.5 w-1.5 rounded-full ${connected && bridgeUp ? "bg-accent shadow-[0_0_6px_var(--accent)]" : connected ? "bg-amber-400 animate-pulse" : "bg-muted animate-pulse"}`} />
          {connected ? (bridgeUp ? "Bridge" : "Bridge…") : "Connecting"}
        </span>
        <span className="opacity-30">|</span>
        <span className="flex items-center gap-1.5" title="Model API (port 8000)">
          <span className={`h-1.5 w-1.5 rounded-full ${apiUp ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.45)]" : "bg-red-400/80 animate-pulse"}`} />
          {apiUp ? "API ready" : "API offline"}
        </span>
        <span className="opacity-30">|</span>
        <span className="truncate" title={projectDir}>{folderLabel(projectDir)}</span>
        {mcpToolCount > 0 && (
          <>
            <span className="opacity-30">|</span>
            <button
              type="button"
              onClick={() => openSettings("mcp")}
              className="titlebar-no-drag truncate hover:text-ink"
              title="MCP tools connected"
            >
              MCP · {mcpToolCount} tool{mcpToolCount === 1 ? "" : "s"}
            </button>
          </>
        )}
        <span className="ml-auto truncate">{activeModel?.name ?? model}</span>
        <span className="opacity-30">|</span>
        <span>{activeMode.label}</span>
      </footer>
    </div>
  );
}

function TitleBar({
  title,
  projectDir,
  onNewChat,
  onSearch,
  onPickFolder,
  onToggleExplorer,
  onSettings,
  explorerOpen,
  mcpToolCount,
}: {
  title: string;
  projectDir: string;
  onNewChat: () => void;
  onSearch: () => void;
  onPickFolder: () => void;
  onToggleExplorer: () => void;
  onSettings: () => void;
  explorerOpen: boolean;
  mcpToolCount: number;
}) {
  const hasProject = Boolean(projectDir && title !== "Anvil");
  return (
    <header className="titlebar relative flex h-[var(--titlebar-height)] shrink-0 items-center border-b border-border bg-titlebar pr-[138px]">
      <div className="titlebar-no-drag relative z-10 flex min-w-0 items-center gap-2 pl-3">
        <Logo className="h-8 w-8 object-contain" glow size="sm" />
        <span className="text-[13px] font-semibold text-ink">Anvil</span>
      </div>

      <div
        className="titlebar-drag pointer-events-none absolute inset-x-0 flex items-center justify-center px-[200px]"
        title={projectDir || title}
      >
        <div className="flex max-w-md items-center gap-1.5 truncate text-[12px] text-secondary">
          {hasProject && <IconFolder className="h-3.5 w-3.5 shrink-0 text-accent/80" />}
          <span className={`truncate ${hasProject ? "text-ink" : "text-muted"}`}>{title}</span>
        </div>
      </div>

      <div className="titlebar-no-drag relative z-10 ml-auto flex items-center gap-0.5 pr-1">
        <button type="button" onClick={onNewChat} className="titlebar-action" title="New chat (Ctrl+Shift+L)">
          <IconPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onPickFolder} className="titlebar-action" title="Open project folder">
          <IconFolder className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onSearch} className="titlebar-action" title="Search chats (Ctrl+K)">
          <IconSearch className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleExplorer}
          className={`titlebar-action ${explorerOpen ? "text-accent" : ""}`}
          title="Toggle explorer (Ctrl+B)"
        >
          <IconPanelRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onSettings} className="titlebar-action" title="Settings">
          <IconSettings className="h-3.5 w-3.5" />
          {mcpToolCount > 0 && (
            <span className="rounded bg-accent/25 px-1 text-[10px] font-medium text-accent">{mcpToolCount}</span>
          )}
        </button>
      </div>
    </header>
  );
}

function FileEditorWorkspace({
  tabs,
  activePath,
  onSelectTab,
  onCloseTab,
  onChangeContent,
  onSave,
}: {
  tabs: EditorTab[];
  activePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string, e?: React.MouseEvent) => void;
  onChangeContent: (path: string, content: string) => void;
  onSave: () => void;
}) {
  const active = tabs.find((t) => t.path === activePath) ?? tabs[0];
  const dirty = active?.kind === "text" && active.content !== active.savedContent;
  const readOnly = active?.kind !== "text";

  return (
    <main className="editor-workspace flex min-w-0 flex-1 flex-col bg-editor">
      <div className="editor-tabbar titlebar-no-drag flex shrink-0 overflow-x-auto border-b border-border bg-[var(--bg-titlebar)]">
        {tabs.map((tab) => {
          const isActive = tab.path === (activePath ?? tabs[0]?.path);
          const isDirty = tab.kind === "text" && tab.content !== tab.savedContent;
          return (
            <button
              key={tab.path}
              type="button"
              className={`editor-tab ${isActive ? "editor-tab-active" : ""}`}
              onClick={() => onSelectTab(tab.path)}
              title={tab.path}
            >
              <FileIcon path={tab.path} />
              <span className="editor-tab-name">{tabBasename(tab.path)}</span>
              {isDirty && <span className="editor-tab-dirty" aria-label="Unsaved changes" />}
              <span
                role="button"
                tabIndex={-1}
                className="editor-tab-close"
                title="Close"
                onClick={(e) => onCloseTab(tab.path, e)}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      {active ? (
        <>
          <div className="editor-toolbar titlebar-no-drag flex shrink-0 items-center gap-2 border-b border-border px-3 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={active.path}>
              {active.path}
            </span>
            <button
              type="button"
              className="ide-btn-ghost px-2 py-0.5 text-[11px] disabled:opacity-40"
              disabled={!dirty || active.loading || readOnly}
              onClick={onSave}
              title="Save (Ctrl+S)"
            >
              Save
            </button>
          </div>
          <div className="relative min-h-0 flex-1">
            {active.loading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted">Loading…</div>
            ) : active.error ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-400/90">
                {active.error}
              </div>
            ) : active.kind === "unsupported" ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <FileIcon path={active.path} />
                <p className="text-sm text-secondary">Unsupported file</p>
                <p className="font-mono text-[11px] text-muted">{tabBasename(active.path)}</p>
                <p className="max-w-sm text-[12px] text-faint">
                  Binary files like executables cannot be opened in the editor.
                </p>
              </div>
            ) : active.kind === "image" && active.imageUrl ? (
              <div className="image-viewer flex h-full items-center justify-center overflow-auto p-6">
                <img
                  src={active.imageUrl}
                  alt={active.path}
                  className="max-h-full max-w-full object-contain shadow-lg"
                />
              </div>
            ) : (
              <CodeEditor value={active.content} path={active.path} onChange={(v) => onChangeContent(active.path, v)} />
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}

function EditorCenter({
  onNewChat,
  onSearch,
  onPickFolder,
  onToggleExplorer,
  onSettings,
  projectName,
  mcpToolCount,
}: {
  onNewChat: () => void;
  onSearch: () => void;
  onPickFolder: () => void;
  onToggleExplorer: () => void;
  onSettings: () => void;
  projectName: string;
  mcpToolCount: number;
}) {
  const shortcuts: [string, string, () => void][] = [
    ["New Chat", "Ctrl + Shift + L", onNewChat],
    ["Search Chats", "Ctrl + K", onSearch],
    ["Open Folder", "", onPickFolder],
    ["File Explorer", "Ctrl + B", onToggleExplorer],
    ["Settings", "", onSettings],
  ];
  return (
    <main className="anvil-welcome flex min-w-0 flex-1 flex-col items-center justify-center bg-editor px-6">
      <div className="anvil-logo-glow-wrap mb-6">
        <Logo className="mx-auto h-16 w-16 object-contain" glow size="lg" />
      </div>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-ink">Anvil</h1>
      <p className="mb-8 max-w-md text-center text-[13px] leading-relaxed text-muted">
        {projectName !== "Anvil"
          ? `Project open: ${projectName}. Use the chat panel to plan, build, and iterate.`
          : "Open a folder, pick a model, and start chatting."}
        {mcpToolCount > 0 && ` ${mcpToolCount} MCP tool${mcpToolCount === 1 ? "" : "s"} ready.`}
      </p>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface/50 p-2">
        {shortcuts.map(([label, key, action]) => (
          <button
            key={label}
            type="button"
            onClick={action}
            className="shortcut-row w-full rounded-lg px-3 py-2 hover:bg-elevated/80 hover:text-ink"
          >
            <span className="text-secondary">{label}</span>
            {key ? <span className="shortcut-key">{key}</span> : <span className="text-accent/70">→</span>}
          </button>
        ))}
      </div>
    </main>
  );
}

function ExplorerRail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="explorer-rail titlebar-no-drag shrink-0"
      onClick={onToggle}
      title={open ? "Hide explorer (Ctrl+B)" : "Show explorer (Ctrl+B)"}
      aria-expanded={open}
      aria-label="Toggle file explorer"
    >
      {open ? <IconChevronRight className="h-3.5 w-3.5" /> : <IconChevronLeft className="h-3.5 w-3.5" />}
    </button>
  );
}

function ExplorerPanel({
  name,
  reloadKey,
  width,
  activeFile,
  onOpenFile,
  onPickFolder,
}: {
  name: string;
  reloadKey: string;
  width: number;
  activeFile: string | null;
  onOpenFile: (path: string) => void;
  onPickFolder: () => void;
}) {
  return (
    <aside
      className="flex shrink-0 flex-col border-l border-border bg-sidebar"
      style={{ width }}
    >
      <div className="titlebar-no-drag panel-header justify-between">
        <span className="truncate normal-case tracking-normal text-secondary">Explorer</span>
        <button type="button" onClick={onPickFolder} className="ide-btn-ghost h-6 w-6" title="Open folder">
          <IconFolder />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <FileTree rootName={name} reloadKey={reloadKey} activeFile={activeFile} onOpenFile={onOpenFile} />
      </div>
    </aside>
  );
}

function ChatHistoryRow({
  session,
  active,
  renaming,
  renameValue,
  confirmingDelete,
  onSelect,
  onStartRename,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  session: SessionMeta;
  active: boolean;
  renaming: boolean;
  renameValue: string;
  confirmingDelete: boolean;
  onSelect: () => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  if (confirmingDelete) {
    return (
      <div className="chat-history-row mx-1 rounded-md bg-surface px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-secondary">Delete &quot;{session.title}&quot;?</span>
        <button type="button" onClick={onConfirmDelete} className="ide-btn-ghost px-2 py-0.5 text-[11px] text-red-400">
          Delete
        </button>
        <button type="button" onClick={onCancelDelete} className="ide-btn-ghost px-2 py-0.5 text-[11px]">
          Cancel
        </button>
      </div>
    );
  }

  if (renaming) {
    return (
      <div className="chat-history-row mx-1 rounded-md bg-surface px-2 py-1">
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename();
            }
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={onCommitRename}
          className="min-w-0 flex-1 rounded border border-border bg-base px-2 py-1 text-xs text-ink outline-none focus:border-[color-mix(in_srgb,var(--accent)_35%,transparent)]"
        />
      </div>
    );
  }

  return (
    <div
      className={`chat-history-row group mx-1 rounded-md ${
        active ? "bg-elevated text-ink" : "text-muted hover:bg-elevated/60"
      }`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs">
        {session.title}
      </button>
      <div className={`chat-history-actions pr-1 ${active ? "opacity-100" : ""}`}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
          className="ide-btn-ghost h-6 w-6 text-faint hover:text-ink"
          title="Rename"
        >
          <IconPencil />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete();
          }}
          className="ide-btn-ghost h-6 w-6 text-faint hover:text-red-400"
          title="Delete"
        >
          <IconTrash />
        </button>
      </div>
    </div>
  );
}

function AnvilComposer({
  input,
  onInput,
  onKeyDown,
  connected,
  busy,
  quizRequest,
  onSend,
  onStop,
  agentMode,
  modeMenuOpen,
  modelMenuOpen,
  onModeMenuOpen,
  onModelMenuOpen,
  onAgentMode,
  models,
  model,
  onModel,
  reasoning,
  onReasoning,
}: {
  input: string;
  onInput: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  connected: boolean;
  busy: boolean;
  quizRequest: QuizRequest | null;
  onSend: () => void;
  onStop: () => void;
  agentMode: AgentMode;
  modeMenuOpen: boolean;
  modelMenuOpen: boolean;
  onModeMenuOpen: (v: boolean) => void;
  onModelMenuOpen: (v: boolean) => void;
  onAgentMode: (m: AgentMode) => void;
  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;
  reasoning: string;
  onReasoning: (l: string) => void;
}) {
  const activeMode = AGENT_MODES.find((m) => m.id === agentMode) ?? AGENT_MODES[0];
  const activeModel = models.find((m) => m.id === model);
  const modeLabel = agentMode === "off" ? "Ask" : "Agent";
  const composerRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={composerRef} className="discord-composer">
      <textarea
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder={
          !connected
            ? "Connecting…"
            : quizRequest
              ? "Type your answer…"
              : "What should we build?"
        }
        className="max-h-36 min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13px] leading-relaxed text-ink outline-none placeholder:text-faint"
      />
      <div className="composer-toolbar-row flex items-center justify-between gap-2 px-2.5 py-2">
        <ComposerToolbar
          composerRef={composerRef}
          agentMode={agentMode}
          modeMenuOpen={modeMenuOpen}
          modelMenuOpen={modelMenuOpen}
          onModeMenuOpen={onModeMenuOpen}
          onModelMenuOpen={onModelMenuOpen}
          onAgentMode={onAgentMode}
          models={models}
          model={model}
          onModel={onModel}
          reasoning={reasoning}
          onReasoning={onReasoning}
          modeLabel={modeLabel}
          activeMode={activeMode}
          activeModel={activeModel}
        />
        <div className="flex shrink-0 items-center gap-1">
          {busy && !quizRequest ? (
            <button type="button" onClick={onStop} className="ide-btn-ghost h-8 w-8 text-accent" title="Stop">
              <IconStop />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!connected || !input.trim()}
              className="anvil-send-btn flex h-8 w-8 items-center justify-center disabled:opacity-25"
              title="Send"
            >
              <IconSend />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ComposerToolbar({
  composerRef,
  agentMode,
  modeMenuOpen,
  modelMenuOpen,
  onModeMenuOpen,
  onModelMenuOpen,
  onAgentMode,
  models,
  model,
  onModel,
  reasoning,
  onReasoning,
  modeLabel,
  activeMode,
  activeModel,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  agentMode: AgentMode;
  modeMenuOpen: boolean;
  modelMenuOpen: boolean;
  onModeMenuOpen: (v: boolean) => void;
  onModelMenuOpen: (v: boolean) => void;
  onAgentMode: (m: AgentMode) => void;
  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;
  reasoning: string;
  onReasoning: (l: string) => void;
  modeLabel: string;
  activeMode: (typeof AGENT_MODES)[number];
  activeModel?: ModelInfo;
}) {
  const grouped = models.reduce<Record<string, ModelInfo[]>>((acc, m) => {
    const p = m.provider || "other";
    (acc[p] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <ModeChip
        composerRef={composerRef}
        agentMode={agentMode}
        open={modeMenuOpen}
        onToggle={() => {
          onModeMenuOpen(!modeMenuOpen);
          onModelMenuOpen(false);
        }}
        onClose={() => onModeMenuOpen(false)}
        activeMode={activeMode}
        modeLabel={modeLabel}
        onAgentMode={onAgentMode}
        reasoning={reasoning}
        onReasoning={onReasoning}
      />

      <ModelChip
        composerRef={composerRef}
        open={modelMenuOpen}
        onToggle={() => {
          onModelMenuOpen(!modelMenuOpen);
          onModeMenuOpen(false);
        }}
        onClose={() => onModelMenuOpen(false)}
        model={model}
        onModel={onModel}
        activeModel={activeModel}
        grouped={grouped}
      />

      {reasoning !== "off" && (
        <span className="text-[10px] text-faint">· {reasoning}</span>
      )}
    </div>
  );
}

function ModeChip({
  composerRef,
  agentMode,
  open,
  onToggle,
  onClose,
  activeMode,
  modeLabel,
  onAgentMode,
  reasoning,
  onReasoning,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  agentMode: AgentMode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  activeMode: (typeof AGENT_MODES)[number];
  modeLabel: string;
  onAgentMode: (m: AgentMode) => void;
  reasoning: string;
  onReasoning: (l: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        className={`composer-chip ${agentMode !== "off" ? "composer-chip-active" : ""}`}
        title={activeMode.hint}
      >
        <IconAgent />
        <span>{modeLabel}</span>
        <span className="text-[9px] opacity-50">▾</span>
      </button>
      {open && (
        <ComposerMenu composerRef={composerRef} anchorRef={btnRef} onClose={onClose}>
          {AGENT_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onAgentMode(m.id);
                onClose();
              }}
              className={`composer-menu-item ${m.id === agentMode ? "composer-menu-item-active" : ""}`}
            >
              <span className="font-medium">{m.label}</span>
              <span className="text-[11px] text-faint">{m.hint}</span>
            </button>
          ))}
          <div className="composer-menu-divider" />
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint">Reasoning</div>
          {REASONING_LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => {
                onReasoning(l);
                onClose();
              }}
              className={`composer-menu-item ${l === reasoning ? "composer-menu-item-active" : ""}`}
            >
              <span className="font-medium capitalize">{l}</span>
            </button>
          ))}
        </ComposerMenu>
      )}
    </>
  );
}

function ModelChip({
  composerRef,
  open,
  onToggle,
  onClose,
  model,
  onModel,
  activeModel,
  grouped,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  model: string;
  onModel: (id: string) => void;
  activeModel?: ModelInfo;
  grouped: Record<string, ModelInfo[]>;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        className="composer-chip max-w-[168px]"
        title={model}
      >
        <span className="truncate">{activeModel?.name ?? model ?? "Model"}</span>
        <span className="shrink-0 text-[9px] opacity-50">▾</span>
      </button>
      {open && (
        <ComposerMenu composerRef={composerRef} anchorRef={btnRef} onClose={onClose} wide>
          <div className="max-h-56 overflow-y-auto p-1">
            {Object.entries(grouped).map(([provider, items]) => (
              <div key={provider}>
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                  {provider}
                </div>
                {items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onModel(m.id);
                      onClose();
                    }}
                    className={`composer-menu-item ${m.id === model ? "composer-menu-item-active" : ""}`}
                  >
                    <span className="truncate font-medium">{m.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </ComposerMenu>
      )}
    </>
  );
}

function ComposerMenu({
  composerRef,
  anchorRef,
  children,
  onClose,
  wide,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;

    const place = () => {
      if (!menuRef.current || !anchorRef.current) return;
      const gap = 6;
      const pad = 8;
      const ar = anchorRef.current.getBoundingClientRect();
      const mr = menuRef.current.getBoundingClientRect();
      const mw = mr.width || (wide ? 288 : 224);
      const mh = mr.height || 240;
      const composerTop = composerRef.current?.getBoundingClientRect().top ?? pad;

      let top = ar.bottom + gap;
      if (top + mh > window.innerHeight - pad) {
        top = ar.top - mh - gap;
      }
      // Never cover the text input — keep menu above the composer box.
      if (top + mh > composerTop - gap) {
        top = composerTop - mh - gap;
      }
      top = Math.max(pad, Math.min(top, window.innerHeight - mh - pad));

      let left = ar.left;
      if (left + mw > window.innerWidth - pad) {
        left = window.innerWidth - mw - pad;
      }
      left = Math.max(pad, left);

      setPos({ top, left });
    };

    place();
    requestAnimationFrame(place);
  }, [composerRef, anchorRef, wide, children]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={onClose} aria-hidden />
      <div
        ref={menuRef}
        className={`composer-menu fixed z-[201] overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-panel ${
          wide ? "w-72" : "w-56"
        } ${pos ? "animate-slide-up" : "invisible"}`}
        style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ide-chip ${active ? "ide-chip-active" : "ide-chip-idle"}`}
    >
      {label}
    </button>
  );
}

function ReasoningChip({ level, onChange }: { level: string; onChange: (l: string) => void }) {
  const active = level !== "off";
  return (
    <div className={`ide-chip ${active ? "ide-chip-active" : "ide-chip-idle"}`}>
      <span className="text-[10px] opacity-70">Reasoning</span>
      <select
        value={level}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer bg-transparent text-xs outline-none"
      >
        {REASONING_LEVELS.map((l) => (
          <option key={l} value={l} className="bg-elevated text-ink">
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function MessageView({
  msg,
  projectDir,
  onOpenFile,
}: {
  msg: Msg;
  projectDir: string;
  onOpenFile: (path: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end animate-slide-up">
        <div className="discord-embed discord-embed-user max-w-[88%] whitespace-pre-wrap px-3.5 py-2.5 text-[13px]">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 animate-slide-up">
      {msg.tools.map((t, i) => (
        <ToolView key={i} tool={t} projectDir={projectDir} onOpenFile={onOpenFile} />
      ))}
      {msg.text && (
        <div className="discord-embed discord-embed-bot px-3.5 py-2.5">
          <div className="markdown text-[13px]">
            <ChatMarkdown>{msg.text}</ChatMarkdown>
            {msg.streaming && <Caret />}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        pre({ children, ...props }) {
          return <CodeBlockPre {...props}>{children}</CodeBlockPre>;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function CodeBlockPre({ children, ...props }: ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="code-block-wrap">
      <button type="button" onClick={copy} className="code-copy-btn titlebar-no-drag" title="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  );
}

function PanelResizeHandle({
  side,
  onResize,
}: {
  side: "left" | "right";
  onResize: (delta: number) => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onResize(delta);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.classList.remove("anvil-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onResize]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize chat panel" : "Resize file panel"}
      className={`panel-resize-handle panel-resize-handle-${side} titlebar-no-drag shrink-0`}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        lastX.current = e.clientX;
        document.body.classList.add("anvil-resizing");
      }}
    />
  );
}

function RobloxLoaderCopy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="code-block-wrap">
      <button type="button" onClick={copy} className="code-copy-btn titlebar-no-drag" title="Copy loader script">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="text-[11px] leading-relaxed">{text}</pre>
    </div>
  );
}

function ToolView({
  tool,
  projectDir,
  onOpenFile,
}: {
  tool: ToolCard;
  projectDir: string;
  onOpenFile: (path: string) => void;
}) {
  const filePath = toolFilePath(tool.args);
  const canOpen = !!filePath && FILE_OPEN_TOOLS.has(tool.name);
  const relPath = filePath ? toProjectRelPath(filePath, projectDir) : "";
  const arg =
    filePath ??
    (tool.args?.command as string) ??
    (tool.args?.pattern as string) ??
    JSON.stringify(tool.args ?? {}).slice(0, 80);
  const dot = tool.ok === undefined ? "text-muted" : tool.ok ? "text-emerald-400" : "text-red-400";

  const openFile = () => {
    if (!canOpen || !relPath) return;
    onOpenFile(relPath);
  };

  return (
    <div
      className={`discord-embed discord-embed-tool flex items-center gap-2 px-3 py-2 font-mono text-[11px] ${
        canOpen && relPath ? "cursor-pointer hover:bg-surface/40" : ""
      }`}
      role={canOpen && relPath ? "button" : undefined}
      tabIndex={canOpen && relPath ? 0 : undefined}
      title={canOpen && relPath ? `Open ${relPath} in editor` : undefined}
      onClick={canOpen && relPath ? openFile : undefined}
      onKeyDown={
        canOpen && relPath
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openFile();
              }
            }
          : undefined
      }
    >
      <span className={dot}>●</span>
      <span className="font-medium text-secondary">{tool.name}</span>
      {canOpen && relPath ? (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-accent">
          <FileIcon path={relPath} />
          <span className="truncate underline decoration-accent/40 underline-offset-2">{relPath}</span>
        </span>
      ) : (
        <span className="truncate text-muted">{arg}</span>
      )}
    </div>
  );
}

function CommandPalette({
  onClose,
  onUltracode,
  onNewChat,
  onToggleAgent,
  onReasoning,
  agentMode,
}: {
  onClose: () => void;
  onUltracode: () => void;
  onNewChat: () => void;
  onToggleAgent: () => void;
  onReasoning: (level: string) => void;
  agentMode: "off" | "ask" | "auto";
}) {
  return (
    <div className="absolute inset-x-0 bottom-full z-40 mb-2" onClick={onClose}>
      <div
        className="overflow-hidden rounded-lg border border-border bg-elevated shadow-panel animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-faint">
          Commands
        </div>
        <button type="button" onClick={onUltracode} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-secondary hover:bg-surface">
          <span className="text-accent">⟁</span> UltraCode swarm…
        </button>
        <button type="button" onClick={onToggleAgent} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-secondary hover:bg-surface">
          <span className="text-accent">⏵</span> {agentMode === "off" ? "Enable Agent" : "Cycle Agent mode"}
        </button>
        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">Reasoning</div>
        {REASONING_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onReasoning(l)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-secondary hover:bg-surface"
          >
            {l}
          </button>
        ))}
        <div className="my-px border-t border-border" />
        <button type="button" onClick={onNewChat} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-secondary hover:bg-surface">
          <span className="text-accent">+</span> New chat
        </button>
      </div>
    </div>
  );
}

function UltraCodePanel({ status }: { status: UltraCodeStatus }) {
  const statusDot = (s: string) =>
    s === "done" ? "text-emerald-400" : s === "failed" ? "text-red-400" : s === "running" ? "text-accent animate-pulse" : "text-faint";
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-surface p-3">
      <div className="flex items-center gap-2 text-xs">
        {!status.finished && <Spinner />}
        <span className="font-semibold text-accent">UltraCode</span>
        <span className="truncate text-muted">{status.task}</span>
        {status.finished && !status.failed && <span className="text-emerald-400">done</span>}
        {status.failed && <span className="text-red-400">{status.error || "failed"}</span>}
      </div>
      {status.groups.length === 0 && !status.finished && (
        <div className="mt-2 text-xs text-faint">Planning swarm…</div>
      )}
      <div className="mt-2 flex flex-col gap-1">
        {status.groups.map((g) => (
          <div key={g.id} className="rounded-md border border-border bg-base/60 px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              <span className={statusDot(g.status)}>●</span>
              <span className="font-medium text-secondary">{g.role || g.id}</span>
              <span className="text-faint">{g.status}</span>
            </div>
            {g.agents.length > 0 && (
              <div className="mt-1 flex flex-col gap-0.5 pl-3">
                {g.agents.map((a) => (
                  <div key={a.agent_id} className="flex items-center gap-1.5 truncate text-[11px] text-faint">
                    <span className={statusDot(a.status)}>●</span>
                    <span className="text-muted">{a.agent_id}</span>
                    <span className="truncate">{a.action}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function McpStatusBadge({ status, disabled }: { status: string; disabled?: boolean }) {
  if (disabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-muted" />
        Disabled
      </span>
    );
  }
  const map: Record<string, { label: string; dot: string; text: string }> = {
    connected: { label: "Connected", dot: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]", text: "text-emerald-400" },
    error: { label: "Error", dot: "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.45)]", text: "text-red-400" },
    disabled: { label: "Disabled", dot: "bg-muted", text: "text-muted" },
    unknown: { label: "Unknown", dot: "bg-amber-400", text: "text-amber-400" },
  };
  const s = map[status] ?? map.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function SettingsDialog({
  initialTab,
  models,
  model,
  onModel,
  agentMode,
  onAgentMode,
  onClose,
}: {
  initialTab: "general" | "prompt" | "skills" | "mcp";
  models: ModelInfo[];
  model: string;
  onModel: (id: string) => void;
  agentMode: AgentMode;
  onAgentMode: (m: AgentMode) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [showDefaultPrompt, setShowDefaultPrompt] = useState(false);

  const [configDir, setConfigDir] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsPath, setModelsPath] = useState("/models");
  const [defaultModel, setDefaultModel] = useState("");
  const [bundled, setBundled] = useState(false);
  const [settingsAgentMode, setSettingsAgentMode] = useState<AgentMode>("off");

  const [soul, setSoul] = useState("");
  const [soulMax, setSoulMax] = useState(1024);
  const [userProfile, setUserProfile] = useState("");
  const [userMax, setUserMax] = useState(2000);
  const [memory, setMemory] = useState("");
  const [memoryMax, setMemoryMax] = useState(3200);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [systemPromptMax, setSystemPromptMax] = useState(16000);
  const [defaultPrompt, setDefaultPrompt] = useState("");

  const [mcpJson, setMcpJson] = useState("");
  const [mcpDir, setMcpDir] = useState("");
  const [mcpPath, setMcpPath] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([]);
  const [mcpExpanded, setMcpExpanded] = useState<string | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [robloxMcp, setRobloxMcp] = useState<RobloxMcpStatus | null>(null);
  const [skillsState, setSkillsState] = useState<SkillsState | null>(null);
  const [latestLogPath, setLatestLogPath] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    void (window as any).anvil?.getLatestLogPath?.().then((p: string) => p && setLatestLogPath(p));
    fetch(`${API}/api/settings`)
      .then((r) => r.json())
      .then((d) => {
        setConfigDir(d.configDir ?? "");
        setConfigPath(d.configPath ?? "");
        setBaseUrl(d.config?.base_url ?? "");
        setModelsPath(d.config?.models_path ?? "/models");
        setDefaultModel(d.config?.model ?? "");
        setBundled(!!d.config?.anvil_bundled);
        const mode = d.config?.gui_agent_mode;
        setSettingsAgentMode(mode === "auto" || mode === "ask" ? mode : "off");
        setSoul(d.soul?.content ?? "");
        setSoulMax(d.soul?.maxChars ?? 1024);
        setUserProfile(d.userProfile?.content ?? "");
        setUserMax(d.userProfile?.maxChars ?? 2000);
        setMemory(d.memory?.content ?? "");
        setMemoryMax(d.memory?.maxChars ?? 3200);
        setSystemPrompt(d.systemPrompt?.custom ?? "");
        setSystemPromptMax(d.systemPrompt?.maxChars ?? 16000);
        setDefaultPrompt(d.systemPrompt?.default ?? "");
        setMcpDir(d.mcp?.configDir ?? "");
        setMcpPath(d.mcp?.configPath ?? "");
        setMcpJson(JSON.stringify(d.mcp?.config ?? { mcpServers: {} }, null, 2));
        setMcpServers(d.mcp?.servers ?? []);
        setSkillsState(d.skills ?? null);
      })
      .catch(() => setMsg("Failed to load settings"))
      .finally(() => setLoading(false));
    fetch(`${API}/api/mcp/roblox`)
      .then((r) => r.json())
      .then((d) => setRobloxMcp(d))
      .catch(() => setRobloxMcp(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reloadMcp = async () => {
    setMcpBusy(true);
    setMsg("");
    try {
      const r = await fetch(`${API}/api/mcp/reload`, { method: "POST" });
      const d = await r.json();
      setMcpServers(d.servers ?? []);
      setMsg("MCP reloaded");
    } catch {
      setMsg("MCP reload failed");
    } finally {
      setMcpBusy(false);
    }
  };

  const installRobloxMcp = async (force = false) => {
    setMcpBusy(true);
    setMsg(force ? "Reinstalling Roblox MCP…" : "Installing Roblox MCP… (1–2 min, needs Node.js)");
    try {
      const r = await fetch(`${API}/api/mcp/roblox/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const d = await r.json();
      if (!d.ok) {
        setMsg(d.error || "Roblox MCP install failed");
        return;
      }
      setRobloxMcp(d);
      if (d.mcpConfig) setMcpJson(JSON.stringify(d.mcpConfig, null, 2));
      setMcpServers(d.servers ?? []);
      setMsg(d.message || "Roblox MCP ready");
    } catch {
      setMsg("Roblox MCP install failed");
    } finally {
      setMcpBusy(false);
    }
  };

  const toggleSkill = async (skillId: string, enabled: boolean) => {
    try {
      const r = await fetch(`${API}/api/skills`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toggles: { [skillId]: enabled } }),
      });
      const d = await r.json();
      setSkillsState(d);
      setMsg(enabled ? "Skill enabled" : "Skill disabled");
    } catch {
      setMsg("Failed to update skill");
    }
  };

  const importCursorSkills = async () => {
    setMcpBusy(true);
    try {
      const r = await fetch(`${API}/api/skills/import-cursor`, { method: "POST" });
      const d = await r.json();
      setSkillsState(d.skills ?? d);
      const n = (d.imported as string[] | undefined)?.length ?? 0;
      setMsg(n ? `Imported ${n} skill${n === 1 ? "" : "s"} from Cursor` : "No new Cursor skills to import");
    } catch {
      setMsg("Cursor skills import failed");
    } finally {
      setMcpBusy(false);
    }
  };

  const importCursorMcp = async () => {
    try {
      const r = await fetch(`${API}/api/mcp/cursor`);
      const d = await r.json();
      if (d.error) {
        setMsg(d.error);
        return;
      }
      setMcpJson(JSON.stringify(d, null, 2));
      setMsg("Imported Cursor mcp.json — save to apply");
    } catch {
      setMsg("Import failed");
    }
  };

  const save = async () => {
    setSaving(true);
    setMsg("");
    let mcpConfig: Record<string, unknown> | undefined;
    try {
      mcpConfig = JSON.parse(mcpJson) as Record<string, unknown>;
    } catch {
      if (tab === "mcp") {
        setMsg("MCP JSON is invalid");
        setSaving(false);
        return;
      }
    }
    try {
      const body: Record<string, unknown> = {
        config: {
          model: defaultModel || undefined,
          base_url: baseUrl || undefined,
          models_path: modelsPath || undefined,
          gui_agent_mode: settingsAgentMode,
        },
        soul,
        userProfile,
        memory,
        systemPrompt: systemPrompt.trim() || null,
      };
      if (mcpConfig) body.mcp = mcpConfig;
      const r = await fetch(`${API}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error("save failed");
      setMcpServers(d.mcp?.servers ?? []);
      if (defaultModel) onModel(defaultModel);
      onAgentMode(settingsAgentMode);
      setMsg("Saved");
    } catch {
      setMsg("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: typeof tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "prompt", label: "Prompt & memory" },
    { id: "skills", label: "Skills" },
    { id: "mcp", label: "MCP" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[6vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="titlebar-no-drag flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-panel animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-ink">Settings</h2>
            <p className="text-xs text-muted">Config lives in ~/.Anvil/</p>
          </div>
          <button type="button" onClick={onClose} className="ide-btn-ghost h-8 px-2 text-xs">Close</button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-border p-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1.5 text-left text-xs ${
                  tab === t.id ? "bg-surface text-ink" : "text-muted hover:bg-surface/60 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loading && <p className="text-sm text-muted">Loading…</p>}

              {!loading && tab === "general" && (
                <div className="flex flex-col gap-4">
                  <SettingsField label="Config file" hint={configPath || `${configDir}/config.json`}>
                    <input
                      readOnly
                      value={configPath}
                      className="settings-input settings-input-readonly"
                    />
                  </SettingsField>
                  <SettingsField
                    label="API base URL"
                    hint={bundled ? "Bundled build uses the local proxy — change only if you host your own API." : "OpenAI-compatible API root (no trailing slash)."}
                  >
                    <input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={bundled}
                      placeholder="http://127.0.0.1:8000"
                      className="settings-input"
                    />
                  </SettingsField>
                  <SettingsField label="Models path" hint="Usually /models">
                    <input
                      value={modelsPath}
                      onChange={(e) => setModelsPath(e.target.value)}
                      disabled={bundled}
                      className="settings-input"
                    />
                  </SettingsField>
                  <SettingsField label="Default model" hint={`Current chat model: ${model || "—"}`}>
                    <select
                      value={defaultModel}
                      onChange={(e) => setDefaultModel(e.target.value)}
                      className="settings-input"
                    >
                      <option value="">— select —</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </SettingsField>
                  <SettingsField
                    label="Agent mode"
                    hint="Controls tools (file edits, shell). Auto = always allow without asking each time."
                  >
                    <select
                      value={settingsAgentMode}
                      onChange={(e) => setSettingsAgentMode(e.target.value as AgentMode)}
                      className="settings-input"
                    >
                      {AGENT_MODES.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} — {m.hint}
                        </option>
                      ))}
                    </select>
                    {settingsAgentMode === "auto" && (
                      <p className="mt-2 text-[11px] leading-relaxed text-muted">
                        Always allow is on — the agent can run tools without permission prompts.
                        Dangerous commands (e.g. <code className="text-secondary">rm -rf /</code>) are still blocked.
                      </p>
                    )}
                    {agentMode !== settingsAgentMode && (
                      <p className="mt-1.5 text-[11px] text-accent/80">Save to apply (composer uses this after save).</p>
                    )}
                  </SettingsField>
                  <SettingsField
                    label="Diagnostics (latest.log)"
                    hint="~/.Anvil/logs/latest.log on this machine (created on first launch)"
                  >
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={latestLogPath || "…/logs/latest.log"}
                        className="settings-input settings-input-readonly min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        className="ide-btn-ghost shrink-0 rounded-md px-3 py-1.5 text-xs"
                        onClick={() => void (window as any).anvil?.openServiceLogs?.()}
                      >
                        Open
                      </button>
                    </div>
                  </SettingsField>
                  <SettingsField
                    label="About & source code"
                    hint="GPL-3.0 — full source is public. Required when distributing builds."
                  >
                    <div className="discord-embed flex flex-col gap-2 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
                      <p>
                        <span className="text-secondary">Anvil source:</span>{" "}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => void (window as any).anvil?.openExternal?.(SOURCE_REPO)}
                        >
                          github.com/hyperronropes/Anvil
                        </button>
                      </p>
                      <p>
                        <span className="text-secondary">Upstream (DeepCode v3):</span>{" "}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => void (window as any).anvil?.openExternal?.(UPSTREAM_REPO)}
                        >
                          github.com/Schnickenpick/DeepCodev3
                        </button>
                      </p>
                      <p className="text-faint">
                        When sharing Anvil.zip, include both GitHub links. Clone the repo to build from source
                        (<span className="font-mono">python build_all.py</span>).
                      </p>
                      <p>
                        <span className="text-secondary">Community help:</span>{" "}
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => void (window as any).anvil?.openExternal?.(DEEPCODE_DISCORD)}
                        >
                          DeepCode Discord
                        </button>
                        <span className="text-faint">
                          {" "}— no separate Anvil server; fork makers and users hang out there.
                        </span>
                      </p>
                    </div>
                  </SettingsField>
                </div>
              )}

              {!loading && tab === "prompt" && (
                <div className="flex flex-col gap-4">
                  <SettingsField
                    label="Custom instructions (ANVIL.md)"
                    hint={`Core system prompt override. Saved to ANVIL.md in ~/.Anvil/. Skills are separate — see the Skills tab. Max ${systemPromptMax.toLocaleString()} chars.`}
                  >
                    <textarea
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value.slice(0, systemPromptMax))}
                      rows={8}
                      placeholder="Optional full replacement for the default agent instructions…"
                      className="settings-textarea font-mono text-[11px]"
                    />
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="ide-btn-ghost px-2 py-1 text-[11px]"
                        onClick={() => setSystemPrompt("")}
                      >
                        Use default prompt
                      </button>
                      <button
                        type="button"
                        className="ide-btn-ghost px-2 py-1 text-[11px]"
                        onClick={() => setShowDefaultPrompt((v) => !v)}
                      >
                        {showDefaultPrompt ? "Hide" : "View"} default prompt
                      </button>
                    </div>
                    {showDefaultPrompt && (
                      <pre className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-surface p-2 font-mono text-[10px] leading-relaxed text-muted whitespace-pre-wrap">
                        {defaultPrompt}
                      </pre>
                    )}
                  </SettingsField>

                  <SettingsField label="Personality (SOUL.md)" hint={`Tone & style overlay — max ${soulMax} chars.`}>
                    <textarea
                      value={soul}
                      onChange={(e) => setSoul(e.target.value.slice(0, soulMax))}
                      rows={4}
                      placeholder="e.g. Be concise. Prefer TypeScript. Use dry humor sparingly."
                      className="settings-textarea"
                    />
                  </SettingsField>

                  <SettingsField label="User profile (USER.md)" hint={`Who you are — max ${userMax} chars.`}>
                    <textarea
                      value={userProfile}
                      onChange={(e) => setUserProfile(e.target.value.slice(0, userMax))}
                      rows={3}
                      placeholder="Name, role, stack preferences…"
                      className="settings-textarea"
                    />
                  </SettingsField>

                  <SettingsField label="Global memory (MEMORY.md)" hint={`Facts the agent should remember — max ${memoryMax} chars.`}>
                    <textarea
                      value={memory}
                      onChange={(e) => setMemory(e.target.value.slice(0, memoryMax))}
                      rows={4}
                      placeholder="- Prefers pnpm&#10;- Runs Windows 11"
                      className="settings-textarea font-mono text-[11px]"
                    />
                  </SettingsField>
                </div>
              )}

              {!loading && tab === "skills" && (
                <div className="flex flex-col gap-4">
                  <SettingsField
                    label="Agent skills"
                    hint="Skills inject extra instructions on every turn — separate from ANVIL.md (system prompt). Cursor-compatible SKILL.md folders."
                  >
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="ide-btn-ghost px-2 py-1 text-[11px]"
                        onClick={() => skillsState?.globalDir && void (window as any).anvil?.openPath?.(skillsState.globalDir)}
                      >
                        Open ~/.Anvil/skills/
                      </button>
                      <button
                        type="button"
                        disabled={mcpBusy}
                        onClick={() => void importCursorSkills()}
                        className="ide-btn-ghost px-2 py-1 text-[11px]"
                      >
                        Import from Cursor
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-muted">
                      {skillsState?.enabledCount ?? 0} of {skillsState?.skills.length ?? 0} active ·
                      project skills: <span className="font-mono text-faint">{skillsState?.projectDir}</span>
                    </p>
                  </SettingsField>

                  {(skillsState?.skills.length ?? 0) === 0 ? (
                    <div className="discord-embed px-3 py-4 text-sm text-muted">
                      <p className="mb-2">No skills yet. Add folders with a <span className="font-mono text-ink">SKILL.md</span> file:</p>
                      <pre className="rounded bg-surface/80 p-2 font-mono text-[10px] text-faint">{`~/.Anvil/skills/my-skill/SKILL.md\n---\nname: my-skill\ndescription: When to use this skill\n---\n\nYour instructions here.`}</pre>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {skillsState?.skills.map((s) => (
                        <label
                          key={s.id}
                          className="discord-embed flex cursor-pointer items-start gap-3 px-3 py-2.5"
                        >
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={(e) => void toggleSkill(s.id, e.target.checked)}
                            className="mt-1"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-ink">{s.name}</span>
                              <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">{s.scope}</span>
                            </div>
                            {s.description && (
                              <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{s.description}</p>
                            )}
                            <p className="mt-1 truncate font-mono text-[10px] text-faint" title={s.path}>
                              {s.path}
                            </p>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {!loading && tab === "mcp" && (
                <div className="flex flex-col gap-4">
                  <SettingsField
                    label="Roblox Executor MCP"
                    hint="One-click install into ~/.Anvil/roblox-executor-mcp. If Node/npm isn't installed, Anvil downloads portable Node to ~/.Anvil/tools/nodejs/ (Windows)."
                  >
                    <div className="discord-embed flex flex-col gap-3 px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        {robloxMcp?.installed ? (
                          <span className="rounded bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-400">Installed</span>
                        ) : (
                          <span className="rounded bg-surface px-2 py-0.5 text-muted">Not installed</span>
                        )}
                        {robloxMcp?.nodeOnPath ? (
                          <span className="text-muted">Node {robloxMcp.nodeVersion || "on PATH"}</span>
                        ) : robloxMcp?.bundledNode ? (
                          <span className="text-muted">Portable Node {robloxMcp.nodeVersion || "ready"}</span>
                        ) : robloxMcp?.canAutoDownloadNode ? (
                          <span className="text-muted">No npm — will auto-download Node on install</span>
                        ) : (
                          <span className="text-red-400">Install Node.js 18+ manually</span>
                        )}
                        {robloxMcp?.mcpConnected && (
                          <span className="rounded bg-accent/15 px-2 py-0.5 font-medium text-accent">MCP connected</span>
                        )}
                        {robloxMcp?.mcpStatus?.status === "error" && (
                          <span className="text-red-400 truncate" title={robloxMcp.mcpStatus.error}>
                            MCP error
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={mcpBusy || (!robloxMcp?.nodeAvailable && !robloxMcp?.canAutoDownloadNode)}
                          onClick={() => void installRobloxMcp(false)}
                          className="ide-btn px-3 py-1.5 text-xs"
                        >
                          {mcpBusy ? "Working…" : robloxMcp?.installed ? "Reconnect Roblox MCP" : "Install Roblox MCP"}
                        </button>
                        {robloxMcp?.installed && (
                          <button
                            type="button"
                            disabled={mcpBusy}
                            onClick={() => void installRobloxMcp(true)}
                            className="ide-btn-ghost px-2 py-1.5 text-xs"
                          >
                            Reinstall
                          </button>
                        )}
                        {robloxMcp?.dashboardUrl && (
                          <a
                            href={robloxMcp.dashboardUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="ide-btn-ghost px-2 py-1.5 text-xs"
                          >
                            Dashboard
                          </a>
                        )}
                      </div>
                      {(robloxMcp?.installed || robloxMcp?.loaderScript) && (
                        <div>
                          <p className="mb-1.5 text-[11px] text-muted">
                            After install, run this in your Roblox executor (Auto Execute works):
                          </p>
                          <RobloxLoaderCopy text={robloxMcp?.loaderScript ?? ""} />
                        </div>
                      )}
                      {robloxMcp?.installDir && (
                        <p className="font-mono text-[10px] text-faint truncate" title={robloxMcp.installDir}>
                          {robloxMcp.installDir}
                        </p>
                      )}
                    </div>
                  </SettingsField>

                  <SettingsField label="MCP config" hint={`${mcpPath || mcpDir} · Agent mode required to call tools`}>
                    <textarea
                      value={mcpJson}
                      onChange={(e) => setMcpJson(e.target.value)}
                      rows={10}
                      spellCheck={false}
                      className="settings-textarea font-mono text-[11px]"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" disabled={mcpBusy} onClick={reloadMcp} className="ide-btn-ghost px-2 py-1 text-[11px]">
                        Reload servers
                      </button>
                      <button type="button" onClick={importCursorMcp} className="ide-btn-ghost px-2 py-1 text-[11px]">
                        Import from Cursor
                      </button>
                    </div>
                  </SettingsField>

                  <div>
                    <p className="mb-2 text-xs font-medium text-secondary">Connected servers</p>
                    {mcpServers.length === 0 && (
                      <p className="discord-embed px-3 py-3 text-sm text-muted">No servers yet — add entries under mcpServers, set disabled: false, then Save & Reload.</p>
                    )}
                    <div className="flex flex-col gap-2">
                      {mcpServers.map((s) => (
                        <div key={s.name} className="discord-embed overflow-hidden">
                          <button
                            type="button"
                            className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
                            onClick={() => setMcpExpanded(mcpExpanded === s.name ? null : s.name)}
                          >
                            <McpStatusBadge status={s.status} disabled={s.disabled} />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-ink">{s.name}</span>
                                {s.tools.length > 0 && (
                                  <span className="text-[11px] text-muted">{s.tools.length} tools</span>
                                )}
                              </div>
                              <div className="truncate font-mono text-[11px] text-faint">
                                {s.command} {s.args.join(" ")}
                              </div>
                              {s.error && <div className="mt-1 text-[11px] text-red-400">{s.error}</div>}
                            </div>
                          </button>
                          {mcpExpanded === s.name && s.tools.length > 0 && (
                            <ul className="border-t border-border/60 px-3 py-2 font-mono text-[10px] text-muted">
                              {s.tools.map((t) => (
                                <li key={t} className="truncate py-0.5">{t}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
              <span className="text-xs text-muted">{msg}</span>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="ide-btn-ghost px-3 py-1.5 text-xs">Cancel</button>
                <button type="button" disabled={saving || loading} onClick={save} className="ide-btn px-3 py-1.5 text-xs">
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink">{label}</span>
      {hint && <span className="mb-1.5 block text-[11px] leading-relaxed text-muted">{hint}</span>}
      {children}
    </label>
  );
}

function SearchDialog({
  query,
  onQuery,
  results,
  onPick,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  results: SessionMeta[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 pt-[15vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-elevated shadow-panel animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-3 py-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Search chats…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {query.trim() && results.length === 0 && (
            <div className="px-3 py-4 text-sm text-faint">No matches</div>
          )}
          {results.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              className="w-full rounded-md px-3 py-2 text-left hover:bg-surface"
            >
              <div className="truncate text-sm text-ink">{s.title}</div>
              {s.snippet && <div className="truncate text-xs text-faint">…{s.snippet}…</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function InlineQuizBar({
  request,
  onAnswer,
}: {
  request: QuizRequest;
  onAnswer: (answer: string) => void;
}) {
  return (
    <div className="mb-2 animate-slide-up rounded-lg border border-border bg-elevated/80 px-3 py-2.5">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
        Choose an option or type below
      </div>
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onAnswer(opt)}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-secondary transition-colors hover:border-[color-mix(in_srgb,var(--accent)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] hover:text-ink"
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

function InlinePermissionBar({
  request,
  onChoose,
}: {
  request: PermissionRequest;
  onChoose: (decision: "allow" | "allow_always" | "deny" | "deny_always") => void;
}) {
  const arg =
    (request.args?.path as string) ??
    (request.args?.command as string) ??
    (request.args?.pattern as string) ??
    (request.args?.url as string) ??
    JSON.stringify(request.args ?? {}).slice(0, 120);
  return (
    <div className="mb-2 animate-slide-up rounded-lg border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-elevated/80 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">Allow tool?</span>
        <span className="font-mono text-xs font-medium text-ink">{request.name}</span>
      </div>
      <div className="mb-2 truncate font-mono text-[11px] text-muted" title={arg}>{arg}</div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onChoose("allow")} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-[#1a100c] hover:opacity-90">
          Allow once
        </button>
        <button type="button" onClick={() => onChoose("allow_always")} className="rounded-md border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] px-2.5 py-1 text-xs text-accent hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]">
          Always
        </button>
        <button type="button" onClick={() => onChoose("deny")} className="rounded-md border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface">
          Deny
        </button>
        <button type="button" onClick={() => onChoose("deny_always")} className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface">
          Never
        </button>
      </div>
    </div>
  );
}

function Caret() {
  return <span className="ml-0.5 inline-block w-2 animate-pulse text-accent">▋</span>;
}
function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

function ActivityBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
        active
          ? "border-l-2 border-accent bg-elevated text-accent"
          : "text-muted hover:bg-elevated/80 hover:text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function IconChat() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconPlus({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
function IconSearch({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3-3" strokeLinecap="round" />
    </svg>
  );
}
function IconFolder({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round" />
    </svg>
  );
}
function IconPanelRight({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}
function IconSettings({ className }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round" />
    </svg>
  );
}
function IconChevronRight({ className }: { className?: string } = {}) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronDown({ className }: { className?: string } = {}) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function IconChevronLeft({ className }: { className?: string } = {}) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPencil() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCommand() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M6 15H4.5a2.5 2.5 0 0 0 0 5H6M18 15h1.5a2.5 2.5 0 0 1 0 5H18" strokeLinecap="round" />
    </svg>
  );
}

function Logo({
  className = "",
  glow = false,
  size = "md",
}: {
  className?: string;
  glow?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  const radius = size === "sm" ? "anvil-logo-img--sm" : size === "lg" ? "anvil-logo-img--lg" : "";
  return (
    <img
      src={logoUrl}
      alt="Anvil"
      className={`anvil-logo-img ${radius} ${glow ? "anvil-logo " : ""}${className}`.trim()}
      draggable={false}
    />
  );
}

function IconAgent() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
      <path d="M18.178 8c5.096 0 5.096 8 0 8M5.822 8c-5.096 0-5.096 8 0 8" strokeLinecap="round" />
    </svg>
  );
}
