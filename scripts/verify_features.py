#!/usr/bin/env python3
"""Smoke-test Anvil features: attachments, image gen WS, browser MCP, tools."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CORE = REPO / "anvil" / "src"
if str(CORE) not in sys.path:
    sys.path.insert(0, str(CORE))
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

API = "http://127.0.0.1:8765"
WS_URL = "ws://127.0.0.1:8765/ws"

PASS = 0
FAIL = 0
SKIP = 0


def ok(name: str, detail: str = "") -> None:
    global PASS
    PASS += 1
    print(f"  PASS  {name}" + (f" — {detail}" if detail else ""))


def bad(name: str, detail: str = "") -> None:
    global FAIL
    FAIL += 1
    print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def skip(name: str, detail: str = "") -> None:
    global SKIP
    SKIP += 1
    print(f"  SKIP  {name}" + (f" — {detail}" if detail else ""))


def http_get(path: str, timeout: float = 5.0) -> dict:
    req = urllib.request.Request(f"{API}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_post(path: str, body: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


# ── unit tests (no server) ────────────────────────────────────────────────────

def test_attachments_module() -> None:
    print("\n[attachments]")
    from anvil.attachments import merge_attachments, classify_path

    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        txt = root / "note.txt"
        txt.write_text("hello attachment", encoding="utf-8")
        png = root / "dot.png"
        # 1x1 red PNG
        png.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
            )
        )
        assert classify_path(txt) == "text"
        assert classify_path(png) == "image"

        merged, used = merge_attachments(
            "check this",
            [
                {"id": "1", "name": "note.txt", "path": str(txt), "kind": "text", "size": txt.stat().st_size},
                {"id": "2", "name": "dot.png", "path": str(png), "kind": "image", "size": png.stat().st_size, "mime": "image/png"},
            ],
        )
        if "hello attachment" not in merged:
            bad("merge text file")
        else:
            ok("merge text file")
        if "data:image/png;base64," not in merged:
            bad("merge image base64")
        else:
            ok("merge image base64")
        if len(used) != 2:
            bad("used metadata", f"got {len(used)}")
        else:
            ok("used metadata count")


def test_tools() -> None:
    print("\n[tools]")
    from unittest.mock import patch
    from anvil.tools import browser_open, TOOL_REGISTRY, NETWORK_TOOLS

    if "browser_open" not in TOOL_REGISTRY:
        bad("browser_open in registry")
    else:
        ok("browser_open in registry")
    if "browser_open" not in NETWORK_TOOLS:
        bad("browser_open is network tool")
    else:
        ok("browser_open is network tool")

    # Never open a real browser tab during automated checks.
    with patch("webbrowser.open", return_value=True) as mock_open:
        try:
            out = browser_open("https://example.com")
            if mock_open.called:
                ok("browser_open validates (mocked, no real tab)")
            else:
                bad("browser_open mock", out)
        except Exception as e:
            bad("browser_open", str(e))

    # web_fetch: registry only — no live HTTP (avoids network + side effects).
    if "web_fetch" in TOOL_REGISTRY:
        ok("web_fetch in registry")
    else:
        bad("web_fetch in registry")


def test_browser_mcp_module() -> None:
    print("\n[browser_mcp_install]")
    from anvil.browser_mcp_install import status, SERVER_NAME, MCP_PACKAGE

    st = status()
    if st.get("serverName") != SERVER_NAME:
        bad("server name")
    else:
        ok("status()", f"installed={st.get('installed')}")
    if "@playwright/mcp" not in MCP_PACKAGE:
        bad("MCP package")
    else:
        ok("MCP package", MCP_PACKAGE)



# ── bridge server tests ───────────────────────────────────────────────────────

_bridge_proc: subprocess.Popen | None = None


def bridge_has_new_routes() -> bool:
    try:
        http_get("/api/mcp/browser", timeout=2.0)
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        return True
    except Exception:
        return False


def kill_stale_bridge() -> None:
    if os.name != "nt":
        return
    for exe in ("bridge.exe", "bridge"):
        subprocess.run(["taskkill", "/IM", exe, "/F", "/T"], capture_output=True)


def start_bridge() -> bool:
    global _bridge_proc
    try:
        if bridge_has_new_routes():
            ok("bridge already running (current build)")
            return True
    except Exception:
        pass

    if _bridge_proc is None:
        kill_stale_bridge()
        time.sleep(1)

    try:
        if bridge_has_new_routes():
            ok("bridge running after stale kill")
            return True
    except Exception:
        pass

    env = {**os.environ, "ANVIL_PROJECT_DIR": str(REPO)}
    _bridge_proc = subprocess.Popen(
        [sys.executable, "-m", "server"],
        cwd=str(REPO),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            if bridge_has_new_routes():
                ok("bridge started from source")
                return True
        except Exception:
            if _bridge_proc.poll() is not None:
                out = (_bridge_proc.stdout.read() if _bridge_proc.stdout else "")[:2000]
                bad("bridge exited early", out)
                return False
            time.sleep(0.4)
    bad("bridge health timeout")
    return False


def stop_bridge() -> None:
    global _bridge_proc
    if _bridge_proc and _bridge_proc.poll() is None:
        _bridge_proc.terminate()
        try:
            _bridge_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _bridge_proc.kill()
    _bridge_proc = None


def test_http_endpoints() -> None:
    print("\n[HTTP API]")
    try:
        h = http_get("/api/health")
        if h.get("ok"):
            ok("/api/health")
        else:
            bad("/api/health", str(h))
    except Exception as e:
        bad("/api/health", str(e))
        return

    try:
        st = http_get("/api/status")
        if st.get("bridge"):
            ok("/api/status bridge flag")
        else:
            bad("/api/status", str(st))
    except Exception as e:
        bad("/api/status", str(e))

    try:
        b = http_get("/api/mcp/browser")
        if "serverName" in b and b["serverName"] == "playwright":
            ok("/api/mcp/browser", f"connected={b.get('mcpConnected')}")
        else:
            bad("/api/mcp/browser", str(b))
    except Exception as e:
        bad("/api/mcp/browser", str(e))

    try:
        mcp = http_get("/api/mcp")
        if "servers" in mcp:
            ok("/api/mcp", f"{len(mcp['servers'])} servers")
        else:
            bad("/api/mcp")
    except Exception as e:
        bad("/api/mcp", str(e))


async def test_ws_attachments() -> None:
    print("\n[WebSocket]")
    try:
        import websockets
    except ImportError:
        skip("websocket tests", "pip install websockets")
        return

    uploads = Path.home() / ".Anvil" / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    txt_path = uploads / "verify-test.txt"
    txt_path.write_text("WS attachment verify content", encoding="utf-8")
    att = {
        "id": "verify-id",
        "name": "verify-test.txt",
        "path": str(txt_path),
        "kind": "text",
        "size": txt_path.stat().st_size,
    }

    try:
        async with websockets.connect(WS_URL, open_timeout=5) as ws:
            ok("websocket connect")

            await ws.send(json.dumps({"type": "new"}))
            loaded = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if loaded.get("type") == "loaded":
                ok("session new")
            else:
                bad("session new", str(loaded))

            # Chat with attachment only — will hit model API; we just need no immediate protocol error
            await ws.send(
                json.dumps(
                    {
                        "type": "chat",
                        "text": "",
                        "attachments": [att],
                        "opts": {"model": "test-model", "agent": False, "interactive": False},
                    }
                )
            )
            saw = set()
            deadline = time.time() + 12
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=3)
                except asyncio.TimeoutError:
                    break
                ev = json.loads(raw)
                saw.add(ev.get("type"))
                if ev.get("type") == "error":
                    bad("chat+attachments protocol", ev.get("text", ""))
                    break
                if ev.get("type") in ("thinking", "delta", "turn_done", "cancelled"):
                    ok("chat+attachments accepted", f"events={sorted(saw)}")
                    break
            else:
                if "error" not in saw:
                    ok("chat+attachments no protocol error", f"events={sorted(saw)}")

    except Exception as e:
        bad("websocket flow", str(e))


def test_frontend_build() -> None:
    print("\n[frontend build]")
    dist = REPO / "app" / "dist" / "index.html"
    if dist.is_file():
        ok("vite dist exists", str(dist))
    else:
        bad("vite dist missing — run npm run build in app/")


def test_electron_wiring() -> None:
    print("\n[electron wiring]")
    preload = (REPO / "app" / "electron" / "preload.cjs").read_text(encoding="utf-8")
    main = (REPO / "app" / "electron" / "main.js").read_text(encoding="utf-8")
    app_tsx = (REPO / "app" / "src" / "App.tsx").read_text(encoding="utf-8")

    checks = [
        ("pickChatAttachments preload", "pickChatAttachments" in preload),
        ("chat:pickAttachments IPC", "chat:pickAttachments" in main),
        ("classifyChatFile", "classifyChatFile" in main),
        ("pendingAttachments state", "pendingAttachments" in app_tsx),
        ("installBrowserMcp", "installBrowserMcp" in app_tsx),
    ]
    for name, cond in checks:
        if cond:
            ok(name)
        else:
            bad(name)


def main() -> int:
    print("Anvil feature verification\n" + "=" * 40)
    test_attachments_module()
    test_tools()
    test_browser_mcp_module()
    test_frontend_build()
    test_electron_wiring()

    if not start_bridge():
        print("\nCannot run HTTP/WS tests without bridge.")
    else:
        try:
            test_http_endpoints()
            asyncio.run(test_ws_attachments())
        finally:
            stop_bridge()

    print("\n" + "=" * 40)
    print(f"Results: {PASS} passed, {FAIL} failed, {SKIP} skipped")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
