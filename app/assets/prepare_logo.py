"""Copy user logo, remove outer black background, write logo.png + icon.ico."""

from __future__ import annotations

import shutil
import sys
from collections import deque
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent

SRC = Path(
    r"C:\Users\Shadow\.cursor\projects\c-Users-Shadow-Desktop-RandomProjects\assets"
    r"\c__Users_Shadow_AppData_Roaming_Cursor_User_workspaceStorage_79df68b5502f29ce97a7bdcd403a0fac_images"
    r"_ChatGPT_Image_Jun_25__2026__10_55_30_PM-cfad0e21-4e4e-43ab-824f-669e5ffd3f59.png"
)

# Every size Windows uses for taskbar / Start / Alt-Tab (largest first for ICO master).
ICO_SIZES = (256, 128, 96, 64, 48, 40, 32, 24, 20, 16)


def remove_outer_black_bg(img: Image.Image, threshold: int = 85) -> Image.Image:
    """Flood-fill from image edges so internal anvil cutouts stay opaque."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_background(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 0 and r <= threshold and g <= threshold and b <= threshold

    seen: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque()

    for x in range(w):
        for y in (0, h - 1):
            if is_background(x, y):
                seen.add((x, y))
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_background(x, y) and (x, y) not in seen:
                seen.add((x, y))
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        px[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen and is_background(nx, ny):
                seen.add((nx, ny))
                queue.append((nx, ny))

    return img


def crop_to_content(img: Image.Image, pad: int = 1) -> Image.Image:
    """Trim transparent margins so the anvil fills the taskbar icon."""
    bbox = img.getbbox()
    if not bbox:
        return img
    left = max(0, bbox[0] - pad)
    top = max(0, bbox[1] - pad)
    right = min(img.width, bbox[2] + pad)
    bottom = min(img.height, bbox[3] + pad)
    return img.crop((left, top, right, bottom))


def build_icon_master(img: Image.Image, size: int = 1024, fill: float = 0.99) -> Image.Image:
    """Max-size logo on transparent square — fills ~99% of the canvas."""
    img = crop_to_content(img)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = min(size * fill / img.width, size * fill / img.height)
    nw, nh = max(1, int(img.width * scale)), max(1, int(img.height * scale))
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def save_ico(master: Image.Image, path: Path) -> None:
    """Write multi-resolution ICO — each size rendered from the 1024px master."""
    largest = max(ICO_SIZES)
    if master.width < largest:
        master = master.resize((largest, largest), Image.Resampling.LANCZOS)
    frames = [master.resize((s, s), Image.Resampling.LANCZOS) for s in ICO_SIZES]
    frames[0].save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC
    if not src.is_file():
        src = HERE / "logo_source.png"
    if not src.is_file():
        print(f"logo source not found: {src}", file=sys.stderr)
        sys.exit(1)

    out_png = HERE / "logo.png"
    shutil.copy2(src, HERE / "logo_source.png")
    img = remove_outer_black_bg(Image.open(src))
    img.save(out_png, optimize=True)

    master = build_icon_master(img)
    master.save(HERE / "icon.png")
    save_ico(master, HERE / "icon.ico")
    print(f"wrote {out_png.name}, icon.png, icon.ico ({len(ICO_SIZES)} sizes, max fill)")


if __name__ == "__main__":
    main()
