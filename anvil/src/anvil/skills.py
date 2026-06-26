"""Agent skills — Cursor-compatible SKILL.md folders injected into the system prompt."""
from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import storage

FRONTMATTER_RE = re.compile(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", re.DOTALL)
SKILLS_CONFIG_FILE = storage.DATA_DIR / "skills.json"
GLOBAL_SKILLS_DIR = storage.DATA_DIR / "skills"
MAX_SKILL_BODY = 128_000
MAX_SKILLS_PROMPT = 512_000


@dataclass
class SkillInfo:
    id: str
    name: str
    description: str
    scope: str
    path: str
    enabled: bool
    body: str = ""


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, val = line.split(":", 1)
        meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta, text[match.end() :]


def _skill_roots() -> list[tuple[str, Path]]:
    roots: list[tuple[str, Path]] = [
        ("global", GLOBAL_SKILLS_DIR),
        ("project", Path.cwd() / ".Anvil" / "skills"),
        ("cursor-project", Path.cwd() / ".cursor" / "skills"),
        ("cursor-global", Path.home() / ".cursor" / "skills"),
    ]
    seen: set[str] = set()
    out: list[tuple[str, Path]] = []
    for scope, path in roots:
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        out.append((scope, path))
    return out


def load_skills_config() -> dict:
    storage.ensure_dir()
    GLOBAL_SKILLS_DIR.mkdir(exist_ok=True)
    if not SKILLS_CONFIG_FILE.exists():
        return {"disabled": []}
    try:
        data = json.loads(SKILLS_CONFIG_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {"disabled": list(data.get("disabled") or [])}
    except Exception:
        pass
    return {"disabled": []}


def save_skills_config(cfg: dict) -> None:
    storage.ensure_dir()
    disabled = cfg.get("disabled") if isinstance(cfg.get("disabled"), list) else []
    SKILLS_CONFIG_FILE.write_text(
        json.dumps({"disabled": disabled}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _skill_id(scope: str, folder_name: str) -> str:
    return f"{scope}:{folder_name}"


def _is_enabled(skill_id: str, cfg: dict) -> bool:
    return skill_id not in set(cfg.get("disabled") or [])


def _read_skill(scope: str, folder: Path, cfg: dict, *, load_body: bool) -> SkillInfo | None:
    skill_md = folder / "SKILL.md"
    if not skill_md.is_file():
        return None
    try:
        raw = skill_md.read_text(encoding="utf-8")
    except Exception:
        return None
    meta, body = _parse_frontmatter(raw)
    sid = _skill_id(scope, folder.name)
    name = meta.get("name") or folder.name
    description = meta.get("description") or ""
    if load_body:
        body = body.strip()[:MAX_SKILL_BODY]
    else:
        body = ""
    return SkillInfo(
        id=sid,
        name=name,
        description=description,
        scope=scope,
        path=str(skill_md),
        enabled=_is_enabled(sid, cfg),
        body=body,
    )


def discover_skills(*, load_bodies: bool = False) -> list[SkillInfo]:
    storage.ensure_dir()
    GLOBAL_SKILLS_DIR.mkdir(exist_ok=True)
    cfg = load_skills_config()
    found: dict[str, SkillInfo] = {}
    for scope, root in _skill_roots():
        if not root.is_dir():
            continue
        try:
            children = sorted(root.iterdir(), key=lambda p: p.name.lower())
        except Exception:
            continue
        for child in children:
            if not child.is_dir() or child.name.startswith("."):
                continue
            info = _read_skill(scope, child, cfg, load_body=load_bodies)
            if info and info.id not in found:
                found[info.id] = info
    return list(found.values())


def list_skills() -> dict:
    storage.ensure_dir()
    GLOBAL_SKILLS_DIR.mkdir(exist_ok=True)
    readme = GLOBAL_SKILLS_DIR / "README.txt"
    if not readme.exists():
        readme.write_text(
            "Anvil Agent Skills\n"
            "==================\n\n"
            "Each skill is a folder with SKILL.md (Cursor-compatible):\n\n"
            "  my-skill/SKILL.md\n"
            "  ---\n"
            "  name: my-skill\n"
            "  description: When the agent should use this skill\n"
            "  ---\n\n"
            "  Instructions for the agent...\n\n"
            "Also scanned: <project>/.Anvil/skills/, ~/.cursor/skills/, <project>/.cursor/skills/\n",
            encoding="utf-8",
        )
    skills = discover_skills(load_bodies=False)
    return {
        "globalDir": str(GLOBAL_SKILLS_DIR),
        "projectDir": str(Path.cwd() / ".Anvil" / "skills"),
        "cursorGlobalDir": str(Path.home() / ".cursor" / "skills"),
        "configPath": str(SKILLS_CONFIG_FILE),
        "skills": [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
                "scope": s.scope,
                "path": s.path,
                "enabled": s.enabled,
            }
            for s in skills
        ],
        "enabledCount": sum(1 for s in skills if s.enabled),
    }


def set_skill_enabled(skill_id: str, enabled: bool) -> None:
    cfg = load_skills_config()
    disabled = set(cfg.get("disabled") or [])
    if enabled:
        disabled.discard(skill_id)
    else:
        disabled.add(skill_id)
    cfg["disabled"] = sorted(disabled)
    save_skills_config(cfg)


def set_skills_enabled(body: dict) -> None:
    cfg = load_skills_config()
    if "disabled" in body and isinstance(body["disabled"], list):
        cfg["disabled"] = [str(x) for x in body["disabled"]]
    if "toggles" in body and isinstance(body["toggles"], dict):
        disabled = set(cfg.get("disabled") or [])
        for sid, on in body["toggles"].items():
            if on:
                disabled.discard(str(sid))
            else:
                disabled.add(str(sid))
        cfg["disabled"] = sorted(disabled)
    save_skills_config(cfg)


def import_from_cursor() -> dict:
    """Copy Cursor skills into ~/.Anvil/skills/ (skip existing folders)."""
    storage.ensure_dir()
    GLOBAL_SKILLS_DIR.mkdir(exist_ok=True)
    imported: list[str] = []
    skipped: list[str] = []
    for src_root in (Path.home() / ".cursor" / "skills", Path.cwd() / ".cursor" / "skills"):
        if not src_root.is_dir():
            continue
        for child in sorted(src_root.iterdir()):
            if not child.is_dir() or not (child / "SKILL.md").is_file():
                continue
            dest = GLOBAL_SKILLS_DIR / child.name
            if dest.exists():
                skipped.append(child.name)
                continue
            shutil.copytree(child, dest)
            imported.append(child.name)
    return {"imported": imported, "skipped": skipped, "dest": str(GLOBAL_SKILLS_DIR)}


def get_skills_prompt() -> str:
    cfg = load_skills_config()
    skills = [s for s in discover_skills(load_bodies=True) if _is_enabled(s.id, cfg)]
    if not skills:
        return ""

    parts = [
        "# Agent Skills",
        "The following skills are active. Apply them when relevant to the user's request.",
        "Skills are separate from your core system instructions above.",
        "",
    ]
    total = len("\n".join(parts))
    for skill in skills:
        block = f"## {skill.name}\n"
        if skill.description:
            block += f"{skill.description}\n\n"
        if skill.body:
            block += f"{skill.body}\n"
        block += "\n"
        if total + len(block) > MAX_SKILLS_PROMPT:
            break
        parts.append(block)
        total += len(block)
    return "\n".join(parts).strip()
