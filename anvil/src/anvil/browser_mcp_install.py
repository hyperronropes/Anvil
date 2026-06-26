"""One-click Playwright MCP browser automation (Antigravity-style web browsing)."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import storage
from .roblox_mcp_install import (
    NodeRuntime,
    _bundled_node_exe,
    _bundled_npm,
    _can_auto_download_node,
    _find_node,
    _find_npm,
    _node_env,
    _run,
    _runtime_version,
    bundled_node_dir,
    resolve_node_runtime,
)

SERVER_NAME = "playwright"
MCP_PACKAGE = "@playwright/mcp@latest"
BROWSERS_DIR = storage.DATA_DIR / "tools" / "playwright-browsers"
MARKER_FILE = storage.DATA_DIR / "tools" / "playwright-mcp.ok"


def _npx(runtime: NodeRuntime) -> str:
    parent = Path(runtime.node).resolve().parent
    for name in ("npx.cmd", "npx"):
        p = parent / name
        if p.is_file():
            return str(p)
    found = shutil.which("npx") or shutil.which("npx.cmd")
    if found:
        return found
    raise RuntimeError("npx not found — install Node.js 18+ or use Install in Settings → MCP")


def _browsers_ready() -> bool:
    if not BROWSERS_DIR.is_dir():
        return False
    # Chromium bundle contains chrome-win/chrome.exe on Windows
    for pattern in ("**/chrome.exe", "**/chrome", "**/Chromium.app/**"):
        if any(BROWSERS_DIR.glob(pattern)):
            return True
    return MARKER_FILE.is_file()


def is_installed() -> bool:
    cfg = storage.load_mcp_config()
    spec = (cfg.get("mcpServers") or {}).get(SERVER_NAME)
    return bool(spec and not spec.get("disabled"))


def status() -> dict:
    storage.ensure_dir()
    runtime: NodeRuntime | None = None
    node_error = ""
    try:
        runtime = resolve_node_runtime(allow_download=False)
    except Exception as e:
        node_error = str(e)

    return {
        "installed": is_installed(),
        "browsersReady": _browsers_ready(),
        "browsersDir": str(BROWSERS_DIR),
        "nodeAvailable": runtime is not None,
        "nodeOnPath": bool(_find_node() and _find_npm()),
        "bundledNode": bool(_bundled_node_exe() and _bundled_npm()),
        "bundledNodeDir": str(bundled_node_dir()),
        "canAutoDownloadNode": _can_auto_download_node(),
        "nodeVersion": _runtime_version(runtime.node) if runtime else "",
        "nodeSource": runtime.source if runtime else "",
        "nodeError": node_error,
        "serverName": SERVER_NAME,
        "mcpPackage": MCP_PACKAGE,
    }


def wire_mcp_config(runtime: NodeRuntime) -> dict:
    storage.ensure_mcp_setup()
    BROWSERS_DIR.mkdir(parents=True, exist_ok=True)
    env = {"PLAYWRIGHT_BROWSERS_PATH": str(BROWSERS_DIR)}
    cfg = storage.load_mcp_config()
    servers = cfg.setdefault("mcpServers", {})
    servers[SERVER_NAME] = {
        "command": _npx(runtime),
        "args": ["-y", MCP_PACKAGE],
        "env": env,
        "disabled": False,
    }
    storage.save_mcp_config(cfg)
    return cfg


def install(*, force: bool = False) -> dict:
    storage.ensure_dir()
    runtime = resolve_node_runtime(allow_download=True)
    env = _node_env(runtime)
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(BROWSERS_DIR)
    BROWSERS_DIR.mkdir(parents=True, exist_ok=True)

    npx = _npx(runtime)
    need_browsers = force or not _browsers_ready()
    if need_browsers:
        _run(
            [npx, "-y", "playwright", "install", "chromium"],
            cwd=storage.DATA_DIR,
            env=env,
            timeout=900,
        )
        MARKER_FILE.parent.mkdir(parents=True, exist_ok=True)
        MARKER_FILE.write_text("ok", encoding="utf-8")

    # Warm npx cache so MCP connect does not block on first chat turn.
    _run([npx, "-y", MCP_PACKAGE, "--help"], cwd=storage.DATA_DIR, env=env, timeout=300)

    cfg = wire_mcp_config(runtime)

    st = status()
    if runtime.source == "downloaded":
        message = (
            "Browser automation ready. Anvil downloaded portable Node and Chromium for Playwright MCP."
        )
    elif need_browsers:
        message = "Browser automation ready — Playwright MCP connected with Chromium."
    else:
        message = "Playwright MCP already set up — config refreshed."

    return {
        **st,
        "alreadyInstalled": not need_browsers and is_installed(),
        "message": message,
        "mcpConfig": cfg,
        "nodeSource": runtime.source,
    }
