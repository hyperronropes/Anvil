# PyInstaller spec — builds two frozen bundles:
#   bridge.exe    (GUI websocket bridge) onedir
#   proxy.exe     (bundled model API)   onedir
#
# Build:  pyinstaller build/anvil.spec --noconfirm
# Requires sibling ../leech or set LEECH_PATH to the leech repo root.
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

# SPECPATH is injected by PyInstaller = the dir holding this spec (build/).
ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
CORE_SRC = os.path.join(ROOT, "anvil", "src")   # the anvil package
LEECH_ROOT = os.environ.get("LEECH_PATH", os.path.abspath(os.path.join(ROOT, "..", "leech")))
if not os.path.isdir(LEECH_ROOT):
    raise SystemExit(f"leech repo not found at {LEECH_ROOT} — set LEECH_PATH")
# `server` lives at repo root and imports anvil; both must be importable.
PATHS = [ROOT, CORE_SRC]
PROXY_PATHS = [LEECH_ROOT]

# tiktoken ships encodings as a namespace pkg (tiktoken_ext) + a data blob that
# PyInstaller won't find automatically — collect everything.
tk_datas, tk_bins, tk_hidden = collect_all("tiktoken")
tke_datas, tke_bins, tke_hidden = collect_all("tiktoken_ext")
# mcp.cli pulls optional typer — we only need the client runtime for the bridge.
mcp_hidden = collect_submodules("mcp", filter=lambda name: not name.startswith("mcp.cli"))
mcp_datas, mcp_bins = [], []

# uvicorn loads its protocol/loop impls dynamically -> hidden imports.
UVICORN_HIDDEN = collect_submodules("uvicorn") + [
    "websockets", "websockets.legacy", "h11",
]

common = dict(
    pathex=PATHS,
    datas=tk_datas + tke_datas + mcp_datas,
    binaries=tk_bins + tke_bins + mcp_bins,
    hiddenimports=tk_hidden + tke_hidden + mcp_hidden,
    hookspath=[],
    runtime_hooks=[],
    # Anvil needs none of these; they get dragged in via global site-packages
    # / tiktoken's transitive deps and bloat the exe ~3x. Exclude them.
    excludes=[
        "matplotlib", "pygame", "PyQt6", "PyQt5", "PySide6", "IPython",
        "jedi", "parso", "notebook", "numpy", "scipy", "pandas", "lxml",
        "zmq", "tkinter", "PIL", "sqlite3", "test",
    ],
    noarchive=False,
)

_BUILD = SPECPATH

# ---- GUI bridge -> bridge.exe (windowless; spawned by Electron) -------------
br_common = dict(common)
br_common["hiddenimports"] = common["hiddenimports"] + UVICORN_HIDDEN
br_a = Analysis([os.path.join(_BUILD, "bridge_entry.py")], **br_common)
br_pyz = PYZ(br_a.pure)
# onedir (not onefile): bridge starts much faster — no per-launch extract to %TEMP%.
br_exe = EXE(
    br_pyz, br_a.scripts,
    [],
    exclude_binaries=True,
    name="bridge", console=False,
    icon=os.path.join(ROOT, "app", "assets", "icon.ico"),
)
br_coll = COLLECT(
    br_exe, br_a.binaries, br_a.datas,
    strip=False, upx=False,
    name="bridge",
)

# ---- bundled model proxy -> proxy.exe (headless leech API) -------------------
fa_datas, fa_bins, fa_hidden = collect_all("fastapi")
st_datas, st_bins, st_hidden = collect_all("starlette")
PROXY_DATAS = [
    (os.path.join(LEECH_ROOT, "backend"), "backend"),
    (os.path.join(LEECH_ROOT, "worker"), "worker"),
]
PROXY_HIDDEN = UVICORN_HIDDEN + fa_hidden + st_hidden + collect_submodules("backend") + collect_submodules("worker") + [
    "backend.main", "backend.pool", "backend.context",
    "worker.bank", "worker.config", "worker.health", "worker.leech",
    "worker.pool", "worker.spike", "worker.session_http", "worker.proxies",
    "worker.proxy_sources", "worker.harvester", "worker.email_gen", "worker.direct",
    "worker.account_pool",
    "httpx", "httpx._transports", "httpx._transports.default",
    "anyio", "sniffio", "certifi",
]
proxy_common = dict(
    pathex=PROXY_PATHS,
    datas=PROXY_DATAS + fa_datas + st_datas,
    binaries=fa_bins + st_bins,
    hiddenimports=PROXY_HIDDEN,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "matplotlib", "pygame", "PyQt6", "PyQt5", "PySide6", "IPython",
        "playwright", "cloakbrowser", "tiktoken", "tiktoken_ext", "mcp",
        "numpy", "scipy", "pandas", "PIL", "tkinter", "test",
    ],
    noarchive=False,
)
px_a = Analysis([os.path.join(_BUILD, "proxy_entry.py")], **proxy_common)
px_pyz = PYZ(px_a.pure)
px_exe = EXE(
    px_pyz, px_a.scripts,
    [],
    exclude_binaries=True,
    name="proxy", console=False,
    icon=os.path.join(ROOT, "app", "assets", "icon.ico"),
)
px_coll = COLLECT(
    px_exe, px_a.binaries, px_a.datas,
    strip=False, upx=False,
    name="proxy",
)
