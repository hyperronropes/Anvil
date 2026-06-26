"""Process GUI chat attachments into model context."""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path

TEXT_EXTS = {
    "txt", "md", "markdown", "json", "yaml", "yml", "toml", "xml", "html", "htm",
    "css", "scss", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "rb", "go", "rs",
    "java", "c", "h", "cpp", "hpp", "cs", "php", "swift", "kt", "lua", "sql",
    "sh", "bash", "ps1", "bat", "env", "ini", "cfg", "log", "csv",
}
IMAGE_EXTS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "apng", "ico"}

MAX_TEXT_ATTACHMENT = 32_000
MAX_IMAGE_B64 = 4_000_000  # ~3MB raw image cap in prompt


def _ext(path: Path) -> str:
    return path.suffix.lstrip(".").lower()


def classify_path(path: Path) -> str:
    ext = _ext(path)
    if ext in IMAGE_EXTS:
        return "image"
    if ext in TEXT_EXTS or not ext:
        return "text"
    return "binary"


def merge_attachments(text: str, attachments: list[dict] | None) -> tuple[str, list[dict]]:
    """Append attachment contents to the user message for the agent."""
    if not attachments:
        return text, []

    blocks: list[str] = []
    used: list[dict] = []

    for raw in attachments:
        p = Path(str(raw.get("path") or "")).expanduser()
        name = str(raw.get("name") or p.name)
        kind = str(raw.get("kind") or classify_path(p))

        if not p.is_file():
            blocks.append(f"[Attachment missing: {name}]")
            used.append({**raw, "name": name, "kind": kind})
            continue

        if kind == "image":
            try:
                data = p.read_bytes()
            except OSError:
                blocks.append(f"[Could not read image: {name}]")
                used.append({**raw, "name": name, "kind": "image"})
                continue
            if len(data) > MAX_IMAGE_B64:
                blocks.append(
                    f"[Attached image too large for inline context: {name} ({len(data):,} bytes) at {p}]"
                )
            else:
                mime = raw.get("mime") or mimetypes.guess_type(name)[0] or "image/png"
                b64 = base64.b64encode(data).decode("ascii")
                blocks.append(
                    f"[Attached image: {name}]\n"
                    f"Path on disk: {p}\n"
                    f"data:{mime};base64,{b64}"
                )
            used.append({**raw, "name": name, "kind": "image", "path": str(p)})
            continue

        if kind == "text":
            try:
                content = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                blocks.append(f"[Could not read file: {name}]")
                used.append({**raw, "name": name, "kind": "text"})
                continue
            if len(content) > MAX_TEXT_ATTACHMENT:
                content = content[:MAX_TEXT_ATTACHMENT] + "\n... [truncated]"
            blocks.append(f"[Attached file: {name}]\n{content}")
            used.append({**raw, "name": name, "kind": "text", "path": str(p)})
            continue

        blocks.append(f"[Attached binary file: {name} at {p} — not inlined; use read tools if needed]")
        used.append({**raw, "name": name, "kind": "binary", "path": str(p)})

    if not blocks:
        return text, used
    body = text.strip()
    merged = (body + "\n\n" if body else "") + "\n\n".join(blocks)
    return merged, used
