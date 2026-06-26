from __future__ import annotations
import json
import os
import shutil
from pathlib import Path
from datetime import datetime

DATA_DIR = Path.home() / ".Anvil"
_LEGACY_DATA_DIR = Path.home() / ".deepcodev3"
HISTORY_FILE = DATA_DIR / "history.json"
MEMORY_FILE = DATA_DIR / "memory.json"
CONFIG_FILE = DATA_DIR / "config.json"
MCP_DIR = DATA_DIR / "mcp"
MCP_CONFIG_FILE = MCP_DIR / "mcp_config.json"
MCP_EXAMPLE_FILE = MCP_DIR / "mcp_config.example.json"
MCP_README_FILE = MCP_DIR / "README.txt"
_LEGACY_MCP_FILE = DATA_DIR / "mcp.json"
_PKG_MCP_EXAMPLE = Path(__file__).resolve().parent / "mcp_config.example.json"
MEMORY_MD_FILE = DATA_DIR / "MEMORY.md"       # global personal facts
USER_MD_FILE = DATA_DIR / "USER.md"           # user identity/profile
PERMISSIONS_FILE = DATA_DIR / "permissions.json"

MEMORY_MD_MAX_CHARS = 3200   # ~800 tokens
USER_MD_MAX_CHARS = 2000     # ~500 tokens
PROJECT_MEMORY_MAX_CHARS = 2000  # ~500 tokens
COMPRESS_AT = 0.80           # compress when file hits 80% of max


def ensure_dir():
    if not DATA_DIR.exists() and _LEGACY_DATA_DIR.exists():
        try:
            shutil.copytree(_LEGACY_DATA_DIR, DATA_DIR)
        except Exception:
            pass
    DATA_DIR.mkdir(exist_ok=True)


def load_history() -> list[dict]:
    ensure_dir()
    if not HISTORY_FILE.exists():
        return []
    try:
        return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_history(sessions: list[dict]):
    ensure_dir()
    HISTORY_FILE.write_text(json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8")


def load_memory() -> list[str]:
    ensure_dir()
    if not MEMORY_FILE.exists():
        return []
    try:
        return json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def save_memory(facts: list[str]):
    ensure_dir()
    MEMORY_FILE.write_text(json.dumps(facts, ensure_ascii=False, indent=2), encoding="utf-8")


def load_memory_md() -> str:
    ensure_dir()
    if not MEMORY_MD_FILE.exists():
        # Migrate from memory.json if exists
        facts = load_memory()
        if facts:
            content = "\n".join(f"- {f}" for f in facts)
            MEMORY_MD_FILE.write_text(content, encoding="utf-8")
            return content
        return ""
    try:
        return MEMORY_MD_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def save_memory_md(content: str):
    ensure_dir()
    MEMORY_MD_FILE.write_text(content[:MEMORY_MD_MAX_CHARS], encoding="utf-8")


def load_user_md() -> str:
    ensure_dir()
    if not USER_MD_FILE.exists():
        return ""
    try:
        return USER_MD_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def save_user_md(content: str):
    ensure_dir()
    USER_MD_FILE.write_text(content[:USER_MD_MAX_CHARS], encoding="utf-8")


def load_config() -> dict:
    ensure_dir()
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict):
    ensure_dir()
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def mcp_config_dir() -> Path:
    return MCP_DIR


def mcp_config_path() -> Path:
    ensure_mcp_setup()
    return MCP_CONFIG_FILE


def ensure_mcp_setup() -> None:
    """Create ~/.Anvil/mcp/ with example config + empty mcp_config.json."""
    ensure_dir()
    MCP_DIR.mkdir(exist_ok=True)

    if _PKG_MCP_EXAMPLE.is_file() and not MCP_EXAMPLE_FILE.exists():
        MCP_EXAMPLE_FILE.write_text(_PKG_MCP_EXAMPLE.read_text(encoding="utf-8"), encoding="utf-8")

    if not MCP_README_FILE.exists():
        MCP_README_FILE.write_text(
            "Anvil MCP configuration\n"
            "========================\n\n"
            "1. Copy mcp_config.example.json → mcp_config.json (or edit mcp_config.json directly)\n"
            "2. Set \"disabled\": false on servers you want active\n"
            "3. In Anvil: open MCP panel → Reload\n\n"
            "Same format as Cursor's mcp.json:\n"
            "  { \"mcpServers\": { \"name\": { \"command\": \"npx\", \"args\": [...], \"disabled\": false } } }\n",
            encoding="utf-8",
        )

    if not MCP_CONFIG_FILE.exists():
        if _LEGACY_MCP_FILE.exists():
            try:
                MCP_CONFIG_FILE.write_text(_LEGACY_MCP_FILE.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception:
                MCP_CONFIG_FILE.write_text('{\n  "mcpServers": {}\n}\n', encoding="utf-8")
        else:
            MCP_CONFIG_FILE.write_text('{\n  "mcpServers": {}\n}\n', encoding="utf-8")


def load_mcp_config() -> dict:
    """Cursor-compatible: { \"mcpServers\": { name: { command, args, env?, disabled? } } }."""
    ensure_mcp_setup()
    try:
        data = json.loads(MCP_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {"mcpServers": {}}


def save_mcp_config(data: dict) -> None:
    ensure_mcp_setup()
    MCP_CONFIG_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_cursor_mcp_config() -> dict | None:
    """Read ~/.cursor/mcp.json if present (for import in GUI)."""
    path = Path.home() / ".cursor" / "mcp.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


SOUL_FILE = DATA_DIR / "SOUL.md"
SOUL_MAX_CHARS = 1024
ANVIL_MD_FILE = DATA_DIR / "ANVIL.md"
ANVIL_MD_MAX_CHARS = 512_000
_LEGACY_ANVIL_MD = DATA_DIR / "Anvil.md"
_LEGACY_SYSTEM_PROMPT_FILE = DATA_DIR / "system_prompt.md"


def load_soul_md() -> str:
    """Load SOUL.md from ~/.Anvil/SOUL.md — global personality, hard-capped at 1024 chars."""
    ensure_dir()
    if not SOUL_FILE.exists():
        return ""
    try:
        return SOUL_FILE.read_text(encoding="utf-8").strip()[:SOUL_MAX_CHARS]
    except Exception:
        return ""


def save_soul_md(content: str):
    ensure_dir()
    SOUL_FILE.write_text(content[:SOUL_MAX_CHARS], encoding="utf-8")


def delete_soul_md():
    if SOUL_FILE.exists():
        SOUL_FILE.unlink()


def load_system_prompt_override() -> str:
    """Optional full replacement — ~/.Anvil/ANVIL.md"""
    ensure_dir()
    for path in (ANVIL_MD_FILE, _LEGACY_ANVIL_MD, _LEGACY_SYSTEM_PROMPT_FILE):
        if path.exists():
            try:
                text = path.read_text(encoding="utf-8").strip()[:ANVIL_MD_MAX_CHARS]
                if path != ANVIL_MD_FILE and text:
                    ANVIL_MD_FILE.write_text(text, encoding="utf-8")
                return text
            except Exception:
                return ""
    return ""


def save_system_prompt_override(content: str) -> None:
    ensure_dir()
    trimmed = content.strip()[:ANVIL_MD_MAX_CHARS]
    if trimmed:
        ANVIL_MD_FILE.write_text(trimmed, encoding="utf-8")
    elif ANVIL_MD_FILE.exists():
        ANVIL_MD_FILE.unlink()


def delete_system_prompt_override() -> None:
    if ANVIL_MD_FILE.exists():
        ANVIL_MD_FILE.unlink()


def load_project_md() -> str:
    """Load ANVIL.md from the project directory (falls back to legacy project filenames)."""
    for name in ("ANVIL.md", "DEEPCODE.md"):  # DEEPCODE.md: pre-Anvil project files only
        p = Path.cwd() / name
        if p.exists():
            try:
                return p.read_text(encoding="utf-8").strip()
            except Exception:
                return ""
    return ""


def _project_memory_file() -> Path:
    primary = Path.cwd() / ".Anvil" / "MEMORY.md"
    legacy = Path.cwd() / ".deepcodev3" / "MEMORY.md"
    if not primary.exists() and legacy.exists():
        return legacy
    return primary


def load_project_memory_md() -> str:
    """Load project-local MEMORY.md from <cwd>/.Anvil/MEMORY.md."""
    p = _project_memory_file()
    if not p.exists():
        return ""
    try:
        return p.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def save_project_memory_md(content: str):
    p = _project_memory_file()
    p.parent.mkdir(exist_ok=True)
    p.write_text(content[:PROJECT_MEMORY_MAX_CHARS], encoding="utf-8")


def needs_compression(content: str, max_chars: int) -> bool:
    return len(content) >= max_chars * COMPRESS_AT


def new_session(model_id: str) -> dict:
    return {
        "id": datetime.now().strftime("%Y%m%d_%H%M%S"),
        "model": model_id,
        "created": datetime.now().isoformat(),
        "messages": [],
    }


# --- Permission rules persistence ---

def load_permission_rules() -> list[dict]:
    """Load persisted deny/allow rules: [{"tool": str, "pattern": str|None, "decision": "allow"|"deny"}]."""
    ensure_dir()
    if not PERMISSIONS_FILE.exists():
        return []
    try:
        data = json.loads(PERMISSIONS_FILE.read_text(encoding="utf-8"))
        return data.get("rules", [])
    except Exception:
        return []


def save_permission_rules(rules: list[dict]):
    ensure_dir()
    PERMISSIONS_FILE.write_text(json.dumps({"rules": rules}, ensure_ascii=False, indent=2), encoding="utf-8")
