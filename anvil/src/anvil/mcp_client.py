"""MCP (Model Context Protocol) client — Cursor-compatible mcp.json, stdio servers."""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import Any

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from . import storage
from .tools import ToolError

_lock = asyncio.Lock()
_tools: dict[str, "McpTool"] = {}
_server_states: dict[str, "ServerState"] = {}
# server name -> (stdio_ctx, session_ctx, session)
_connections: dict[str, tuple[Any, Any, ClientSession]] = {}


@dataclass
class McpTool:
    qualified_name: str
    server: str
    tool: str
    description: str
    input_schema: dict


@dataclass
class ServerState:
    name: str
    status: str  # connected | error | disabled
    error: str = ""
    tools: list[str] = field(default_factory=list)


def _qualify(server: str, tool: str) -> str:
    return f"mcp__{server}__{tool.replace('__', '_')}"


def is_mcp_tool(name: str) -> bool:
    return name.startswith("mcp__") or name in _tools


def get_tools_prompt() -> str:
    if not _tools:
        return ""
    lines = ["\n# MCP tools (connected external servers)\n"]
    has_playwright = any(
        t.server == "playwright" or t.tool.startswith("browser_")
        for t in _tools.values()
    )
    if has_playwright:
        lines.append(
            "# Browser automation (Playwright MCP)\n"
            "You can browse the web like a human: open pages, click, type, scroll, take screenshots, read accessibility snapshots.\n"
            "Typical flow: mcp__playwright__browser_navigate → mcp__playwright__browser_snapshot → "
            "mcp__playwright__browser_click / browser_type → repeat until done.\n"
            "Use browser_snapshot to find element refs before clicking. Use browser_take_screenshot when you need visual proof.\n"
            "Prefer Playwright MCP over web_fetch for JS-heavy sites, logins, forms, and interactive flows.\n"
        )
    for t in _tools.values():
        desc = (t.description or t.tool).strip().replace("\n", " ")
        lines.append(f"{t.qualified_name}(...) — {desc}")
        lines.append(f'Usage: <tool>{{"name": "{t.qualified_name}", "args": {{...}}}}</tool>\n')
    return "\n".join(lines)


def list_status() -> list[dict]:
    cfg = storage.load_mcp_config()
    out = []
    for name, spec in (cfg.get("mcpServers") or {}).items():
        st = _server_states.get(name)
        out.append({
            "name": name,
            "disabled": bool(spec.get("disabled")),
            "status": st.status if st else "unknown",
            "error": st.error if st else "",
            "tools": st.tools if st else [],
            "command": spec.get("command", ""),
            "args": spec.get("args") or [],
            "env": spec.get("env") or {},
        })
    return out


async def reload() -> None:
    async with _lock:
        await _disconnect_all()
        _tools.clear()
        _server_states.clear()
        cfg = storage.load_mcp_config()
        for name, spec in (cfg.get("mcpServers") or {}).items():
            if spec.get("disabled"):
                _server_states[name] = ServerState(name=name, status="disabled")
                continue
            try:
                await _connect_one(name, spec)
            except Exception as e:
                _server_states[name] = ServerState(name=name, status="error", error=str(e))


async def _connect_one(name: str, spec: dict) -> None:
    command = spec.get("command")
    if not command:
        if spec.get("url"):
            raise ToolError("HTTP/SSE MCP URLs are not supported yet — use a stdio command (like Cursor's npx setup)")
        raise ToolError("Server needs a command (e.g. npx)")

    args = list(spec.get("args") or [])
    env = {**os.environ, **(spec.get("env") or {})}
    params = StdioServerParameters(command=command, args=args, env=env)

    stdio_ctx = stdio_client(params)
    read, write = await stdio_ctx.__aenter__()
    session_ctx = ClientSession(read, write)
    session = await session_ctx.__aenter__()
    await session.initialize()
    listed = await session.list_tools()

    tool_names: list[str] = []
    for t in listed.tools:
        qn = _qualify(name, t.name)
        schema = t.inputSchema if isinstance(t.inputSchema, dict) else {}
        _tools[qn] = McpTool(
            qualified_name=qn,
            server=name,
            tool=t.name,
            description=t.description or "",
            input_schema=schema,
        )
        tool_names.append(qn)

    _connections[name] = (stdio_ctx, session_ctx, session)
    _server_states[name] = ServerState(name=name, status="connected", tools=tool_names)


async def _disconnect_all() -> None:
    for name in list(_connections.keys()):
        await _disconnect_one(name)


async def _disconnect_one(name: str) -> None:
    conn = _connections.pop(name, None)
    if not conn:
        return
    stdio_ctx, session_ctx, _session = conn
    try:
        await session_ctx.__aexit__(None, None, None)
    except Exception:
        pass
    try:
        await stdio_ctx.__aexit__(None, None, None)
    except Exception:
        pass


async def call_tool(qualified_name: str, args: dict) -> str:
    tool = _tools.get(qualified_name)
    if not tool:
        raise ToolError(f"Unknown MCP tool: {qualified_name}")
    conn = _connections.get(tool.server)
    if not conn:
        raise ToolError(f"MCP server '{tool.server}' is not connected")
    session = conn[2]
    result = await session.call_tool(tool.tool, arguments=args or {})
    parts: list[str] = []
    for block in result.content:
        text = getattr(block, "text", None)
        parts.append(text if text is not None else str(block))
    return "\n".join(parts) if parts else "(empty MCP result)"


async def shutdown() -> None:
    async with _lock:
        await _disconnect_all()
        _tools.clear()
        _server_states.clear()
