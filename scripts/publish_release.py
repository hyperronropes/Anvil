"""Create a GitHub release and upload Anvil.zip using git-stored credentials."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP_PATH = os.path.join(REPO_DIR, "dist", "Anvil.zip")
TAG = "v0.1.0"
NOTES = """## Anvil v0.1.0

Pre-built Windows desktop app. Extract the zip and run `Anvil/Anvil.exe` (share the whole folder, not just the exe).

### Highlights
- UltraCode swarm toggle in composer with configurable agent count
- File & image attachments in chat
- Browser automation via Playwright MCP (Settings → MCP)
- Skills system

### Important
- **Built with AI:** developed largely with AI-assisted coding.
- **Support:** [GitHub Issues](https://github.com/hyperronropes/Anvil/issues) for bugs. [DeepCode Discord](https://discord.gg/8WU56Drt7F) is **not** official Anvil support — questions only.

Fork of [DeepCode v3](https://github.com/Schnickenpick/DeepCodev3) (GPL-3.0)."""


def git_exe() -> str:
    mingit = os.path.join(os.environ.get("TEMP", ""), "MinGit", "cmd", "git.exe")
    if os.path.isfile(mingit):
        return mingit
    return "git"


def git_token() -> str:
    proc = subprocess.run(
        [git_exe(), "-C", REPO_DIR, "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git credential fill failed: {proc.stderr.strip()}")
    for line in proc.stdout.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise RuntimeError("no GitHub token from git credential helper")


def api_request(token: str, method: str, url: str, data: bytes | None = None, content_type: str = "application/json"):
    headers = {
        "Authorization": f"token {token}",
        "User-Agent": "anvil-release",
        "Accept": "application/vnd.github+json",
    }
    if data is not None:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {e.code}: {body}") from e


def main() -> int:
    if not os.path.isfile(ZIP_PATH):
        print(f"missing zip: {ZIP_PATH}", file=sys.stderr)
        return 1
    token = git_token()
    payload = json.dumps(
        {"tag_name": TAG, "name": "Anvil v0.1.0", "body": NOTES, "draft": False}
    ).encode()
    release = api_request(
        token,
        "POST",
        "https://api.github.com/repos/hyperronropes/Anvil/releases",
        payload,
    )
    upload_base = release["upload_url"].split("{", 1)[0]
    with open(ZIP_PATH, "rb") as f:
        asset = api_request(
            token,
            "POST",
            f"{upload_base}?name=Anvil.zip",
            f.read(),
            content_type="application/zip",
        )
    print(release["html_url"])
    print(asset["browser_download_url"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
