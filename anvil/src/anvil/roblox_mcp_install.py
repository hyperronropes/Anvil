"""One-click installer for notpoiu/roblox-executor-mcp into ~/.Anvil/."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from . import storage

REPO_ZIP = "https://github.com/notpoiu/roblox-executor-mcp/archive/refs/heads/main.zip"
SERVER_NAME = "roblox-executor-mcp"
BRIDGE_PORT = 16384
DASHBOARD_URL = f"http://localhost:{BRIDGE_PORT}/"

# Windows portable Node (LTS) — downloaded into ~/.Anvil/tools/nodejs when npm missing.
NODE_VERSION = "20.18.2"
NODE_WIN_ZIP = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip"

LOADER_SCRIPT = """-- Paste into your Roblox executor after MCP shows "connected"
local bridgeUrl = getgenv().BridgeURL or "localhost:16384"
loadstring(game:HttpGet("http://" .. bridgeUrl .. "/script.luau"))()
"""


@dataclass(frozen=True)
class NodeRuntime:
    node: str
    npm: str
    source: str  # path | bundled | downloaded


def bundled_node_dir() -> Path:
    return storage.DATA_DIR / "tools" / "nodejs"


def install_dir() -> Path:
    return storage.DATA_DIR / "roblox-executor-mcp"


def entry_script() -> Path:
    return install_dir() / "dist" / "index.js"


def loader_file() -> Path:
    return install_dir() / "roblox-loader.lua"


def _find_on_path(name: str) -> str | None:
    return shutil.which(name)


def _find_node() -> str | None:
    return _find_on_path("node")


def _find_npm() -> str | None:
    return _find_on_path("npm") or _find_on_path("npm.cmd")


def _bundled_node_exe() -> Path | None:
    for name in ("node.exe", "node"):
        p = bundled_node_dir() / name
        if p.is_file():
            return p
    return None


def _bundled_npm() -> Path | None:
    for name in ("npm.cmd", "npm"):
        p = bundled_node_dir() / name
        if p.is_file():
            return p
    return None


def _runtime_version(node_exe: str) -> str:
    try:
        out = subprocess.run(
            [node_exe, "--version"],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        return (out.stdout or "").strip()
    except Exception:
        return ""


def _can_auto_download_node() -> bool:
    return os.name == "nt" and platform.machine().endswith(("64", "AMD64", "x86_64"))


def _download_portable_node() -> None:
    if not _can_auto_download_node():
        raise RuntimeError(
            "Node.js/npm not found. On Windows Anvil can download portable Node automatically; "
            "on other OSes install Node 18+ from https://nodejs.org and restart Anvil."
        )

    dest = bundled_node_dir()
    dest.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = Path(tmp) / "node.zip"
        with httpx.Client(timeout=300, follow_redirects=True) as client:
            resp = client.get(NODE_WIN_ZIP)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)

        stage = Path(tmp) / "extract"
        stage.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(stage)

        roots = [p for p in stage.iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError("Unexpected Node.js archive layout")
        src = roots[0]

        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True, exist_ok=True)
        for item in src.iterdir():
            target = dest / item.name
            if item.is_dir():
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)

    if not _bundled_node_exe() or not _bundled_npm():
        raise RuntimeError("Portable Node download finished but node/npm binaries are missing")


def resolve_node_runtime(*, allow_download: bool = False) -> NodeRuntime:
    node = _find_node()
    npm = _find_npm()
    if node and npm:
        return NodeRuntime(node=node, npm=npm, source="path")

    bn = _bundled_node_exe()
    bnpm = _bundled_npm()
    if bn and bnpm:
        return NodeRuntime(node=str(bn), npm=str(bnpm), source="bundled")

    if allow_download:
        _download_portable_node()
        bn = _bundled_node_exe()
        bnpm = _bundled_npm()
        if bn and bnpm:
            return NodeRuntime(node=str(bn), npm=str(bnpm), source="downloaded")

    if _can_auto_download_node():
        raise RuntimeError(
            "Node.js/npm not found — click Install again; Anvil will download portable Node "
            f"into {bundled_node_dir()}"
        )
    raise RuntimeError(
        "Node.js/npm not found. Install Node 18+ from https://nodejs.org and restart Anvil."
    )


def _node_env(runtime: NodeRuntime) -> dict[str, str]:
    env = dict(os.environ)
    node_parent = str(Path(runtime.node).resolve().parent)
    env["PATH"] = node_parent + os.pathsep + env.get("PATH", "")
    return env


def is_installed() -> bool:
    return entry_script().is_file()


def status() -> dict:
    storage.ensure_dir()
    installed = is_installed()

    runtime: NodeRuntime | None = None
    node_error = ""
    try:
        runtime = resolve_node_runtime(allow_download=False)
    except Exception as e:
        node_error = str(e)

    bundled_ready = bool(_bundled_node_exe() and _bundled_npm())
    path_ready = bool(_find_node() and _find_npm())

    return {
        "installed": installed,
        "installDir": str(install_dir()),
        "entryScript": str(entry_script()) if installed else "",
        "nodeAvailable": runtime is not None,
        "nodeOnPath": path_ready,
        "bundledNode": bundled_ready,
        "bundledNodeDir": str(bundled_node_dir()),
        "canAutoDownloadNode": _can_auto_download_node(),
        "nodeVersion": _runtime_version(runtime.node) if runtime else "",
        "nodeSource": runtime.source if runtime else "",
        "nodeError": node_error,
        "loaderScript": LOADER_SCRIPT,
        "loaderPath": str(loader_file()) if loader_file().is_file() else "",
        "dashboardUrl": DASHBOARD_URL,
        "serverName": SERVER_NAME,
    }


def _download_repo(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = Path(tmp) / "repo.zip"
        with httpx.Client(timeout=120, follow_redirects=True) as client:
            resp = client.get(REPO_ZIP)
            resp.raise_for_status()
            zip_path.write_bytes(resp.content)

        stage = Path(tmp) / "extract"
        stage.mkdir()
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(stage)

        roots = [p for p in stage.iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError("Unexpected GitHub archive layout")
        src_root = roots[0]

        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(src_root, dest)


def _run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int = 600) -> None:
    result = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"{' '.join(cmd)} failed (exit {result.returncode})\n{detail[:4000]}")


def wire_mcp_config(runtime: NodeRuntime) -> dict:
    script = entry_script().resolve()
    if not script.is_file():
        raise RuntimeError(f"Built entry missing: {script}")

    storage.ensure_mcp_setup()
    cfg = storage.load_mcp_config()
    servers = cfg.setdefault("mcpServers", {})
    servers[SERVER_NAME] = {
        "command": runtime.node,
        "args": [str(script)],
        "disabled": False,
    }
    storage.save_mcp_config(cfg)
    return cfg


def install(*, force: bool = False) -> dict:
    storage.ensure_dir()
    runtime = resolve_node_runtime(allow_download=True)
    env = _node_env(runtime)

    target = install_dir()
    if is_installed() and not force:
        wire_mcp_config(runtime)
        loader_file().write_text(LOADER_SCRIPT, encoding="utf-8")
        st = status()
        msg = "Roblox MCP already installed — MCP config refreshed."
        if runtime.source in ("bundled", "downloaded"):
            msg += f" Using portable Node ({runtime.source})."
        return {
            **st,
            "alreadyInstalled": True,
            "message": msg,
            "nodeSource": runtime.source,
        }

    _download_repo(target)
    _run([runtime.npm, "install"], target, env=env)
    _run([runtime.npm, "run", "build"], target, env=env)

    if not entry_script().is_file():
        raise RuntimeError(f"Build finished but {entry_script()} was not created")

    loader_file().write_text(LOADER_SCRIPT, encoding="utf-8")
    cfg = wire_mcp_config(runtime)

    st = status()
    if runtime.source == "downloaded":
        message = (
            "Roblox MCP installed. Anvil downloaded portable Node.js because npm was not on PATH."
        )
    elif runtime.source == "bundled":
        message = "Roblox MCP installed using portable Node in ~/.Anvil/tools/nodejs/."
    else:
        message = "Roblox MCP installed and connected to Anvil."

    return {
        **st,
        "alreadyInstalled": False,
        "message": message,
        "mcpConfig": cfg,
        "nodeSource": runtime.source,
    }
