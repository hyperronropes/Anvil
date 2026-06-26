"""Build the shippable Anvil desktop app in one shot.

    python build_all.py

Produces (in ./dist/):
    Anvil/            — desktop GUI (run Anvil.exe)
    Anvil.zip         — same folder, zipped for sharing

Steps:
 1. PyInstaller freezes bridge.exe + proxy.exe into build/_pydist/.
 2. electron-builder packages the GUI to app/release/win-unpacked/.
 3. Copies win-unpacked → dist/Anvil/ and dist/Anvil.zip.

Run from the repo root. Requires: PyInstaller, Node/npm with app deps installed
(cd app && npm install) including electron-builder.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(ROOT, "app")
DIST = os.path.join(ROOT, "dist")
PYDIST = os.path.join(ROOT, "build", "_pydist")
GUI_OUT = os.path.join(APP, "release")


def run(cmd, cwd=None, shell=False, env=None):
    print(f"\n>>> {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    r = subprocess.run(cmd, cwd=cwd, shell=shell, env=env)
    if r.returncode != 0:
        print(f"!!! step failed (exit {r.returncode})")
        sys.exit(r.returncode)


def kill(name):
    subprocess.run(["taskkill", "/IM", name, "/F", "/T"],
                   capture_output=True, text=True)


def main():
    kill("bridge.exe")
    kill("proxy.exe")
    kill("Anvil.exe")

    # Drop stale PyInstaller outputs (e.g. old anvilcli.exe from prior specs).
    if os.path.isdir(PYDIST):
        shutil.rmtree(PYDIST, ignore_errors=True)

    run([sys.executable, "-m", "PyInstaller", "build/anvil.spec",
         "--noconfirm", "--distpath", PYDIST, "--workpath", "build/_work"],
        cwd=ROOT)

    npm = "npm.cmd" if os.name == "nt" else "npm"
    env = dict(os.environ)
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    run([npm, "run", "dist"], cwd=APP, shell=(os.name == "nt"), env=env)

    if os.path.isdir(DIST):
        shutil.rmtree(DIST, ignore_errors=True)
    os.makedirs(DIST, exist_ok=True)

    gui_unpacked = os.path.join(GUI_OUT, "win-unpacked")
    zip_base = os.path.join(DIST, "Anvil")
    zip_path = zip_base + ".zip"
    if os.path.isdir(gui_unpacked):
        if os.path.isfile(zip_path):
            os.remove(zip_path)
        anvil_dir = os.path.join(DIST, "Anvil")
        if os.path.isdir(anvil_dir):
            shutil.rmtree(anvil_dir, ignore_errors=True)
        shutil.copytree(gui_unpacked, anvil_dir, dirs_exist_ok=True)
        for name in ("LICENSE", "README.md", "SOURCE.txt"):
            src = os.path.join(ROOT, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(anvil_dir, name))
        shutil.make_archive(zip_base, "zip", DIST, "Anvil")
        print("  dist/Anvil.zip  (extract, then run Anvil/Anvil.exe)")
        run([npm, "run", "dist:brand"], cwd=APP, shell=(os.name == "nt"), env=env)
    else:
        print(f"!!! GUI build not found at {gui_unpacked}")

    print("\n=== done — final builds in dist/ ===")
    for f in sorted(os.listdir(DIST)):
        p = os.path.join(DIST, f)
        if os.path.isfile(p):
            print(f"  dist/{f}   ({os.path.getsize(p)//1_000_000} MB)")
        else:
            print(f"  dist/{f}/")


if __name__ == "__main__":
    main()
