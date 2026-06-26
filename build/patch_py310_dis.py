"""Patch Python 3.10.0's dis.py for PyInstaller (bpo-45757).

3.10.0 is the only 3.10.x with this bug; 3.10.1+ fixed it. PyInstaller
scans bytecode and hits IndexError without this one-line fix.

Safe to run repeatedly — skips if already patched or Python != 3.10.0.
"""
import sys
from pathlib import Path

if sys.version_info[:3] != (3, 10, 0):
    print("Python %s — no dis.py patch needed" % (sys.version.split()[0],))
    raise SystemExit(0)

import dis

path = Path(dis.__file__)
text = path.read_text(encoding="utf-8")
old = "        else:\n            arg = None\n        yield (i, op, arg)"
new = "        else:\n            arg = None\n            extended_arg = 0\n        yield (i, op, arg)"

if new in text:
    print("dis.py already patched:", path)
    raise SystemExit(0)

if old not in text:
    print("ERROR: unexpected dis.py layout at", path)
    raise SystemExit(1)

path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Patched dis.py for Python 3.10.0:", path)
