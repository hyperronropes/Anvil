"""Anvil — GUI backend bridge.

A thin FastAPI + websocket server that wraps the existing terminal-agent core
(the `anvil` package) so an Electron/React frontend can drive it.

Design:
- The core's `agent.run_agent` already takes an `on_event(dict)` callback and a
  `swarm_mode` flag that silences all console output. We run with
  `swarm_mode=True` and pipe every event over the websocket as JSON. That gives
  the frontend structured progress (thinking / delta / tool_call / tool_result /
  tokens / response) with almost no change to the agent.
- Tool calls are either auto-allowed (permissions.MODE_AUTO), denied (readonly,
  Agent off), or routed to the client as permission_request/permission_response
  websocket messages (permissions.MODE_INTERACTIVE, opts.interactive=true).

Run:  python -m server   (or: uvicorn server.server:app)
"""
from __future__ import annotations
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

# Make the core importable without installing it.
_CORE_SRC = Path(__file__).resolve().parent.parent / "anvil" / "src"
if str(_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(_CORE_SRC))

# The core (tools.py, storage.py, ...) resolves file paths and ANVIL.md /
# .Anvil/MEMORY.md relative to Path.cwd()/os.getcwd() -- it has no
# explicit "project dir" concept. Rather than thread a cwd param through every
# tool and storage call, the host (Electron main.js) tells us which folder the
# user picked via ANVIL_PROJECT_DIR, and we chdir into it once, up front,
# before any request can read the old cwd.
_project_dir = os.environ.get("ANVIL_PROJECT_DIR")
if _project_dir and os.path.isdir(_project_dir):
    os.chdir(_project_dir)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from contextlib import asynccontextmanager

from anvil import models, storage, permissions, mcp_client  # noqa: E402
# agent pulls the heaviest deps (tools, tiktoken, …) — import on first turn.


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    try:
        await mcp_client.reload()
    except Exception:
        pass
    yield
    try:
        await mcp_client.shutdown()
    except Exception:
        pass


app = FastAPI(title="Anvil bridge", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # local desktop app; tighten if ever hosted
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    """Lightweight readiness probe — Electron polls this while bridge.exe boots."""
    return {"ok": True}


@app.get("/api/status")
async def service_status():
    """Bridge + upstream model API readiness — the UI uses this to distinguish
    'websocket connected' from 'models can actually be called'."""
    from anvil import api as dc_api
    import httpx

    base = dc_api.get_base_url()
    proxy_ok = False
    proxy_detail: dict = {}
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(f"{base}/health")
            proxy_ok = resp.status_code == 200
            if proxy_ok:
                try:
                    proxy_detail = resp.json()
                except Exception:
                    proxy_detail = {}
    except Exception as exc:
        proxy_detail = {"error": str(exc)}
    return {
        "bridge": True,
        "proxy": proxy_ok,
        "base_url": base,
        "proxy_detail": proxy_detail,
    }


@app.get("/api/models")
async def list_models():
    """Model registry — static catalog merged with live backend list (no cap)."""
    from anvil import api as dc_api

    remote = await dc_api.fetch_models()
    merged = models.merge_models(remote)
    cfg = storage.load_config()
    return {
        "default": cfg.get("model", models.DEFAULT_MODEL),
        "models": [
            {
                "id": m["id"],
                "name": m["name"],
                "provider": m.get("provider", ""),
                "tier": m.get("tier", ""),
            }
            for m in merged
        ],
    }


@app.get("/api/config")
async def get_config():
    cfg = storage.load_config()
    mode = cfg.get("gui_agent_mode", "off")
    if mode not in ("off", "ask", "auto"):
        mode = "off"
    return {
        "model": cfg.get("model", models.DEFAULT_MODEL),
        "accent": cfg.get("accent", "orange"),
        "agentMode": mode,
        "agent": mode != "off",
        "reasoning": cfg.get("reasoning", None),
    }


@app.get("/api/sessions")
async def list_sessions():
    """Conversation history for the sidebar (shared with the terminal). Newest
    first; messages omitted here — fetched per-session via /api/sessions/{id}."""
    sessions = storage.load_history()
    out = []
    for s in reversed(sessions[-100:]):
        out.append({
            "id": s.get("id"),
            "title": s.get("title") or "Untitled",
            "model": s.get("model", ""),
            "created": s.get("created", ""),
            "count": len(s.get("messages", [])),
        })
    return {"sessions": out}


@app.get("/api/sessions/search")
async def search_sessions(q: str = ""):
    """Search title + message content across history (newest first)."""
    q = q.strip().lower()
    if not q:
        return {"sessions": []}
    sessions = storage.load_history()
    out = []
    for s in reversed(sessions[-200:]):
        title = (s.get("title") or "Untitled")
        messages = s.get("messages", [])
        hit = q in title.lower()
        snippet = ""
        if not hit:
            for m in messages:
                content = m.get("content", "")
                idx = content.lower().find(q)
                if idx != -1:
                    hit = True
                    start = max(0, idx - 40)
                    snippet = content[start:idx + len(q) + 40]
                    break
        if hit:
            out.append({
                "id": s.get("id"),
                "title": title,
                "model": s.get("model", ""),
                "created": s.get("created", ""),
                "count": len(messages),
                "snippet": snippet,
            })
    return {"sessions": out}


@app.get("/api/sessions/{sid}")
async def get_session(sid: str):
    sessions = storage.load_history()
    s = next((x for x in sessions if x.get("id") == sid), None)
    if s is None:
        return {"error": "not found"}
    return s


@app.post("/api/sessions/{sid}/rename")
async def rename_session(sid: str, body: dict):
    title = (body.get("title") or "").strip()
    if not title:
        return {"error": "title required"}
    sessions = storage.load_history()
    s = next((x for x in sessions if x.get("id") == sid), None)
    if s is None:
        return {"error": "not found"}
    s["title"] = title[:80]
    storage.save_history(sessions)
    return {"ok": True}


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str):
    sessions = storage.load_history()
    kept = [s for s in sessions if s.get("id") != sid]
    if len(kept) == len(sessions):
        return {"error": "not found"}
    storage.save_history(kept)
    return {"ok": True}


@app.get("/api/mcp")
async def get_mcp():
    """MCP config folder + live connection status."""
    storage.ensure_mcp_setup()
    return {
        "configDir": str(storage.mcp_config_dir()),
        "configPath": str(storage.mcp_config_path()),
        "examplePath": str(storage.MCP_EXAMPLE_FILE),
        "config": storage.load_mcp_config(),
        "servers": mcp_client.list_status(),
    }


@app.get("/api/mcp/cursor")
async def get_cursor_mcp():
    cfg = storage.load_cursor_mcp_config()
    if cfg is None:
        return {"error": "Cursor mcp.json not found at ~/.cursor/mcp.json"}
    return cfg


@app.put("/api/mcp")
async def save_mcp(body: dict):
    storage.save_mcp_config(body)
    await mcp_client.reload()
    return {"ok": True, "servers": mcp_client.list_status()}


@app.get("/api/settings")
async def get_settings():
    from anvil.system_prompt import SYSTEM_PROMPT
    from anvil import skills

    storage.ensure_mcp_setup()
    cfg = storage.load_config()
    custom_prompt = storage.load_system_prompt_override()
    return {
        "configDir": str(storage.DATA_DIR),
        "configPath": str(storage.CONFIG_FILE),
        "config": {
            "model": cfg.get("model", models.DEFAULT_MODEL),
            "base_url": cfg.get("base_url", ""),
            "models_path": cfg.get("models_path", "/models"),
            "reasoning": cfg.get("reasoning"),
            "anvil_bundled": bool(cfg.get("anvil_bundled")),
            "gui_agent_mode": cfg.get("gui_agent_mode", "off"),
        },
        "soul": {
            "content": storage.load_soul_md(),
            "path": str(storage.SOUL_FILE),
            "maxChars": storage.SOUL_MAX_CHARS,
        },
        "userProfile": {
            "content": storage.load_user_md(),
            "path": str(storage.USER_MD_FILE),
            "maxChars": storage.USER_MD_MAX_CHARS,
        },
        "memory": {
            "content": storage.load_memory_md(),
            "path": str(storage.MEMORY_MD_FILE),
            "maxChars": storage.MEMORY_MD_MAX_CHARS,
        },
        "systemPrompt": {
            "custom": custom_prompt,
            "default": SYSTEM_PROMPT,
            "path": str(storage.ANVIL_MD_FILE),
            "maxChars": storage.ANVIL_MD_MAX_CHARS,
            "usingCustom": bool(custom_prompt),
        },
        "mcp": {
            "configDir": str(storage.mcp_config_dir()),
            "configPath": str(storage.mcp_config_path()),
            "examplePath": str(storage.MCP_EXAMPLE_FILE),
            "config": storage.load_mcp_config(),
            "servers": mcp_client.list_status(),
        },
        "skills": skills.list_skills(),
    }


@app.put("/api/settings")
async def save_settings(body: dict):
    if "config" in body and isinstance(body["config"], dict):
        cfg = storage.load_config()
        incoming = body["config"]
        for key in ("model", "base_url", "models_path", "reasoning", "gui_agent_mode"):
            if key in incoming:
                val = incoming[key]
                if val is None or val == "":
                    cfg.pop(key, None)
                elif key == "gui_agent_mode":
                    cfg[key] = val if val in ("off", "ask", "auto") else "off"
                else:
                    cfg[key] = val
        storage.save_config(cfg)

    if "soul" in body:
        content = body["soul"] if body["soul"] is not None else ""
        if str(content).strip():
            storage.save_soul_md(str(content))
        else:
            storage.delete_soul_md()

    if "userProfile" in body:
        storage.save_user_md(str(body["userProfile"] or ""))

    if "memory" in body:
        storage.save_memory_md(str(body["memory"] or ""))

    if "systemPrompt" in body:
        content = body["systemPrompt"]
        if content is None or not str(content).strip():
            storage.delete_system_prompt_override()
        else:
            storage.save_system_prompt_override(str(content))

    if "mcp" in body and isinstance(body["mcp"], dict):
        storage.save_mcp_config(body["mcp"])
        await mcp_client.reload()

    return await get_settings()


@app.post("/api/mcp/reload")
async def reload_mcp():
    await mcp_client.reload()
    return {"servers": mcp_client.list_status()}


@app.get("/api/mcp/roblox")
async def roblox_mcp_status():
    from anvil.roblox_mcp_install import status

    st = status()
    servers = mcp_client.list_status()
    roblox = next((s for s in servers if s.get("name") == st["serverName"]), None)
    st["mcpConnected"] = bool(roblox and roblox.get("status") == "connected")
    st["mcpStatus"] = roblox or None
    return st


@app.post("/api/mcp/roblox/install")
async def roblox_mcp_install_endpoint(body: dict | None = None):
    import asyncio
    from anvil.roblox_mcp_install import install

    force = bool((body or {}).get("force"))
    try:
        result = await asyncio.to_thread(install, force=force)
        await mcp_client.reload()
        result["servers"] = mcp_client.list_status()
        result["ok"] = True
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/mcp/browser")
async def browser_mcp_status():
    from anvil.browser_mcp_install import status

    st = status()
    servers = mcp_client.list_status()
    pw = next((s for s in servers if s.get("name") == st["serverName"]), None)
    st["mcpConnected"] = bool(pw and pw.get("status") == "connected")
    st["mcpStatus"] = pw or None
    st["mcpToolCount"] = len(pw.get("tools") or []) if pw else 0
    return st


@app.post("/api/mcp/browser/install")
async def browser_mcp_install_endpoint(body: dict | None = None):
    import asyncio
    from anvil.browser_mcp_install import install

    force = bool((body or {}).get("force"))
    try:
        result = await asyncio.to_thread(install, force=force)
        await mcp_client.reload()
        result["servers"] = mcp_client.list_status()
        pw = next((s for s in result["servers"] if s.get("name") == "playwright"), None)
        result["mcpConnected"] = bool(pw and pw.get("status") == "connected")
        result["mcpToolCount"] = len(pw.get("tools") or []) if pw else 0
        result["ok"] = True
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/skills")
async def get_skills():
    from anvil import skills

    return skills.list_skills()


@app.put("/api/skills")
async def put_skills(body: dict):
    from anvil import skills

    skills.set_skills_enabled(body)
    return skills.list_skills()


@app.post("/api/skills/import-cursor")
async def import_cursor_skills():
    from anvil import skills

    result = skills.import_from_cursor()
    result["skills"] = skills.list_skills()
    return result


def _persist(session_dict: dict):
    """Merge a session into history by id (no dup), keep last 100."""
    sessions = storage.load_history()
    merged = [s for s in sessions if s.get("id") != session_dict.get("id")]
    merged.append(session_dict)
    storage.save_history(merged[-100:])


class _Session:
    """One websocket connection. Owns a persistent agent conversation backed by
    a stored session dict (shared history with the terminal)."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.conversation: list[dict] = []
        self.model_id = models.DEFAULT_MODEL
        self.loop = asyncio.get_event_loop()
        self.out: asyncio.Queue = asyncio.Queue()
        self.memory_md = storage.load_memory_md()
        self.user_md = storage.load_user_md()
        self.soul_md = storage.load_soul_md()
        self.project_md = storage.load_project_md()
        self.project_memory_md = storage.load_project_memory_md()
        self.store = storage.new_session(self.model_id)  # persisted session dict
        self.task: asyncio.Task | None = None  # the in-flight run_turn, if any
        self.ultracode_task: asyncio.Task | None = None
        self._pending_quiz: dict[str, asyncio.Future] = {}
        permissions.set_remote_request_handler(self._on_permission_request)

    def stop(self):
        """Cancel the in-flight turn, if any. run_agent's streaming loop
        unwinds cleanly on CancelledError (it propagates past the `except
        Exception` in run_turn since CancelledError is a BaseException)."""
        if self.task and not self.task.done():
            self.task.cancel()

    def load(self, sid: str):
        """Resume an existing stored session into this connection."""
        sessions = storage.load_history()
        s = next((x for x in sessions if x.get("id") == sid), None)
        if not s:
            return
        self.store = s
        self.model_id = s.get("model", self.model_id)
        self.conversation = [
            {"role": m["role"], "content": m["content"]}
            for m in s.get("messages", [])
            if m["role"] in ("user", "assistant")
        ]

    def reset(self):
        """Start a fresh conversation."""
        self.store = storage.new_session(self.model_id)
        self.conversation = []

    def emit(self, event: dict):
        """Thread-safe push from the agent's (sync) on_event into the queue."""
        self.loop.call_soon_threadsafe(self.out.put_nowait, event)

    def _on_permission_request(self, request_id: str, tool_name: str, args: dict):
        """Called from permissions.py (off the event loop, inside
        run_in_executor) when MODE_INTERACTIVE needs a client decision."""
        self.emit({
            "type": "permission_request",
            "id": request_id,
            "name": tool_name,
            "args": args,
        })

    async def _drain(self):
        while True:
            event = await self.out.get()
            if event is None:
                return
            await self.ws.send_text(json.dumps(event))

    def answer_quiz(self, quiz_id: str, answer: str):
        """Host call: feed back the client's pick/free-text for a pending
        <quiz> block. Runs on the event loop already (called from the ws
        receive loop), so a plain asyncio.Future is enough — no thread
        bridging needed like permissions.py's remote-request machinery."""
        fut = self._pending_quiz.get(quiz_id)
        if fut and not fut.done():
            fut.set_result(answer)

    async def run_turn(self, text: str, opts: dict):
        self.memory_md = storage.load_memory_md()
        self.user_md = storage.load_user_md()
        self.soul_md = storage.load_soul_md()
        self.project_md = storage.load_project_md()
        self.project_memory_md = storage.load_project_memory_md()

        model_id = opts.get("model")
        if model_id:
            self.model_id = model_id
        reasoning_level = opts.get("reasoning")  # None/"off"/low/middle/high/ultra
        # Permission posture:
        #  Agent OFF                  -> read-only (file reads/greps allowed,
        #                                 write/exec/network denied).
        #  Agent ON, opts.interactive -> MODE_INTERACTIVE: real prompts
        #                                 round-trip over the websocket as
        #                                 permission_request/permission_response.
        #  Agent ON, no interactive   -> MODE_AUTO (auto-allow; for clients
        #                                 that haven't implemented the
        #                                 permission_request handshake yet).
        # Hard-deny patterns (rm -rf / etc.) apply in all modes.
        agent_on = bool(opts.get("agent", False))
        interactive = bool(opts.get("interactive", False))
        if not agent_on:
            permissions.set_mode(permissions.MODE_READONLY)
        elif interactive:
            permissions.set_mode(permissions.MODE_INTERACTIVE)
        else:
            permissions.set_mode(permissions.MODE_AUTO)

        self.store.setdefault("messages", []).append(
            {"role": "user", "content": text, "model": self.model_id,
             "attachments": opts.get("attachments") or []})

        drainer = asyncio.ensure_future(self._drain())
        try:
            from anvil import agent
            from anvil.attachments import merge_attachments

            effective, _ = merge_attachments(text, opts.get("attachments"))
            # optional reasoning pre-pass (mirrors the terminal's reasoning mode)
            if reasoning_level and reasoning_level != "off":
                self.emit({"type": "reasoning", "level": reasoning_level})
                from anvil import reasoning
                from anvil.agent import effective_system_prompt
                plan = await reasoning.run_reasoning(
                    effective, self.model_id, reasoning_level,
                    effective_system_prompt(self.soul_md), memory_block="", quiet=True,
                    on_event=self.emit)
                if plan:
                    effective = f"{effective}\n\n[Your private reasoning/plan:\n{plan}\n]"

            from anvil.chat import _parse_quiz, DEFAULT_QUIZ_MAX

            visible, self.conversation = await agent.run_agent(
                effective,
                self.conversation,
                self.memory_md,
                self.user_md,
                self.model_id,
                self.project_md,
                self.project_memory_md,
                soul_md=self.soul_md,
                swarm_mode=True,
                on_event=self.emit,
            )

            # The model can ask a clarifying question mid-turn via a <quiz>
            # block instead of acting (see chat.py's terminal agent_quiz
            # loop). agent.run_agent() returns that tag embedded raw in
            # `visible` — round-trip it to the client as quiz_request/
            # quiz_response and keep feeding answers back as new user turns
            # until the model stops asking.
            clean, quiz_data = _parse_quiz(visible, DEFAULT_QUIZ_MAX)
            while quiz_data:
                quiz_id = str(uuid.uuid4())
                fut: asyncio.Future = self.loop.create_future()
                self._pending_quiz[quiz_id] = fut
                await self.ws.send_text(json.dumps({
                    "type": "quiz_request",
                    "id": quiz_id,
                    "question": quiz_data.get("question", ""),
                    "options": quiz_data["options"],
                }))
                try:
                    answer = await fut
                finally:
                    self._pending_quiz.pop(quiz_id, None)

                followup = (
                    f"[Clarification answer: {answer}]\n\n"
                    "Proceed using this answer. Do not re-ask the same question. Act."
                )
                visible, self.conversation = await agent.run_agent(
                    followup,
                    self.conversation,
                    self.memory_md,
                    self.user_md,
                    self.model_id,
                    self.project_md,
                    self.project_memory_md,
                    soul_md=self.soul_md,
                    swarm_mode=True,
                    on_event=self.emit,
                )
                clean, quiz_data = _parse_quiz(visible, DEFAULT_QUIZ_MAX)
            visible = clean

            self.store["messages"].append(
                {"role": "assistant", "content": visible, "model": self.model_id})
            if not self.store.get("title") and visible:
                self.store["title"] = text[:40]
            _persist(self.store)
            await self.ws.send_text(json.dumps(
                {"type": "turn_done", "text": visible, "sessionId": self.store.get("id")}))
        except asyncio.CancelledError:
            # User hit Stop. Persist whatever's in self.conversation so far
            # (run_agent appends the user msg + partial assistant turn before
            # any cancellable await) and tell the client to unfreeze its UI.
            self.store["messages"].append(
                {"role": "assistant", "content": "[stopped]", "model": self.model_id})
            _persist(self.store)
            await self.ws.send_text(json.dumps({"type": "cancelled"}))
        except Exception as e:
            await self.ws.send_text(json.dumps(
                {"type": "error", "text": str(e)}))
        finally:
            self.out.put_nowait(None)
            await drainer
            self.task = None

    def stop_ultracode(self):
        if self.ultracode_task and not self.ultracode_task.done():
            self.ultracode_task.cancel()

    async def run_ultracode(self, task_text: str, opts: dict):
        """Launch an UltraCode swarm and stream a live snapshot of its
        SwarmState over the websocket every ~500ms. ultracode.py itself has
        no event-callback plumbing (it only mutates SwarmState in place for
        the TUI's /workflows poller) — rather than thread on_event through
        every worker/group/leader call, we reuse that same live object and
        poll it, same as the TUI does."""
        model_id = opts.get("model") or self.model_id
        agent_count = opts.get("agents")
        if agent_count is not None:
            try:
                agent_count = max(1, min(int(agent_count), 1000))
            except (TypeError, ValueError):
                agent_count = None
        permissions.set_mode(permissions.MODE_AUTO)  # swarm workers always auto-allow (see agent.py note)

        from anvil.ultracode import UltraCodeOrchestrator, SwarmState, ACTIVE_SWARMS
        import uuid

        swarm_state = SwarmState(id=str(uuid.uuid4())[:8], task=task_text)
        ACTIVE_SWARMS.append(swarm_state)

        self.store.setdefault("messages", []).append(
            {"role": "user", "content": f"[UltraCode task]: {task_text}", "model": model_id})

        def _snapshot() -> dict:
            return {
                "type": "ultracode_status",
                "id": swarm_state.id,
                "task": swarm_state.task,
                "finished": swarm_state.finished,
                "failed": swarm_state.failed,
                "error": swarm_state.error,
                "groups": [
                    {
                        "id": p.id,
                        "role": p.role,
                        "goal": p.goal,
                        "depends_on": p.depends_on,
                        "status": swarm_state.group_status.get(p.id, "pending"),
                        "agents": [
                            {
                                "agent_id": a.agent_id,
                                "name": a.name,
                                "status": a.status.value if hasattr(a.status, "value") else a.status,
                                "action": a.action,
                                "tokens": a.tokens,
                                "tool_calls": a.tool_calls,
                                "elapsed": round(a.elapsed, 1),
                            }
                            for a in swarm_state.agents_for_group(p.id)
                        ],
                    }
                    for p in swarm_state.plans
                ],
            }

        async def _poller():
            try:
                while True:
                    await self.ws.send_text(json.dumps(_snapshot()))
                    if swarm_state.finished:
                        return
                    await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                return

        poll_task = asyncio.ensure_future(_poller())
        try:
            orchestrator = UltraCodeOrchestrator(
                task=task_text,
                model_id=model_id,
                memory_md=self.memory_md,
                user_md=self.user_md,
                project_md=self.project_md,
                project_memory_md=self.project_memory_md,
                swarm_state=swarm_state,
                agent_count=agent_count,
            )
            results = await orchestrator.run()
            summary = orchestrator.synthesize(results)
            swarm_state.finished = True
            await self.ws.send_text(json.dumps(_snapshot()))

            self.store["messages"].append(
                {"role": "assistant", "content": summary, "model": model_id})
            if not self.store.get("title"):
                self.store["title"] = task_text[:40]
            _persist(self.store)
            await self.ws.send_text(json.dumps(
                {"type": "turn_done", "text": summary, "sessionId": self.store.get("id")}))
        except asyncio.CancelledError:
            swarm_state.finished = True
            swarm_state.failed = True
            swarm_state.error = "stopped by user"
            await self.ws.send_text(json.dumps(_snapshot()))
            self.store["messages"].append(
                {"role": "assistant", "content": "[stopped]", "model": model_id})
            _persist(self.store)
            await self.ws.send_text(json.dumps({"type": "cancelled"}))
        except Exception as e:
            swarm_state.finished = True
            swarm_state.failed = True
            swarm_state.error = str(e)
            await self.ws.send_text(json.dumps(_snapshot()))
            await self.ws.send_text(json.dumps({"type": "error", "text": str(e)}))
        finally:
            poll_task.cancel()
            self.ultracode_task = None


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = _Session(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps(
                    {"type": "error", "text": "bad json"}))
                continue
            mtype = msg.get("type")
            if mtype == "chat":
                # Backgrounded (not awaited): a permission_response for this
                # turn arrives on this same socket while the turn is still
                # running, so the receive loop must stay free to read it
                # rather than being blocked inside run_turn.
                opts = dict(msg.get("opts") or {})
                if msg.get("attachments"):
                    opts["attachments"] = msg.get("attachments")
                session.task = asyncio.ensure_future(
                    session.run_turn(msg.get("text", ""), opts))
            elif mtype == "stop":
                session.stop()
                session.stop_ultracode()
            elif mtype == "ultracode":
                session.ultracode_task = asyncio.ensure_future(
                    session.run_ultracode(msg.get("text", ""), msg.get("opts", {})))
            elif mtype == "permission_response":
                permissions.resolve_remote_request(msg.get("id", ""), msg.get("decision", ""))
            elif mtype == "quiz_response":
                session.answer_quiz(msg.get("id", ""), msg.get("answer", ""))
            elif mtype == "load":
                session.load(msg.get("id", ""))
                await ws.send_text(json.dumps(
                    {"type": "loaded", "session": session.store}))
            elif mtype == "new":
                session.reset()
                await ws.send_text(json.dumps(
                    {"type": "loaded", "session": session.store}))
            else:
                await ws.send_text(json.dumps(
                    {"type": "error", "text": f"unknown msg type {msg.get('type')!r}"}))
    except WebSocketDisconnect:
        return


def main():
    import sys
    import uvicorn
    from uvicorn.config import LOGGING_CONFIG
    # When frozen windowless (PyInstaller console=False), sys.stdout/stderr are
    # None. uvicorn's default logging formatter calls stdout.isatty() and crashes
    # ("NoneType has no attribute isatty"). Disable uvicorn's log config when
    # there's no usable stdout.
    log_config = None if sys.stdout is None else LOGGING_CONFIG
    uvicorn.run(app, host="127.0.0.1", port=8765,
                log_level="info", log_config=log_config)


if __name__ == "__main__":
    main()
