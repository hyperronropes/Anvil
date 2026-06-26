"""PyInstaller entry for bundled model proxy -> proxy.exe (spawned by Anvil)."""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _bootstrap_path() -> None:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", ""))
    else:
        base = Path(
            os.environ.get(
                "LEECH_PATH",
                Path(__file__).resolve().parent.parent.parent / "leech",
            )
        )
    if base.is_dir() and str(base) not in sys.path:
        sys.path.insert(0, str(base))


_bootstrap_path()

# Module-level import so PyInstaller traces backend + worker into the bundle.
from backend.main import app  # noqa: E402

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ANVIL_PROXY_PORT", "8000"))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )
