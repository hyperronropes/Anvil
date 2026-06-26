/** Embed Anvil name + icon into the real app exe (NOT the NSIS portable wrapper). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const icon = path.join(appRoot, "assets", "icon.ico");
const version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version || "0.1.0";

const targets = [
  path.join(appRoot, "release", "win-unpacked", "Anvil.exe"),
  path.join(repoRoot, "dist", "Anvil", "Anvil.exe"),
];

async function patchExe(exe) {
  if (!fs.existsSync(exe)) return false;
  await rcedit(exe, {
    icon,
    "file-version": version,
    "product-version": version,
    "version-string": {
      FileDescription: "Anvil",
      ProductName: "Anvil",
      InternalName: "Anvil",
      OriginalFilename: "Anvil.exe",
      CompanyName: "Anvil",
    },
  });
  console.log(`branded ${exe}`);
  return true;
}

let patched = 0;
let failed = 0;
for (const exe of targets) {
  try {
    if (await patchExe(exe)) patched++;
  } catch (e) {
    failed++;
    console.warn(`skip ${exe}: ${e?.message ?? e}`);
  }
}

if (!patched) {
  console.warn("No Anvil.exe found — run after electron-builder");
} else if (failed) {
  console.warn(`${failed} target(s) skipped (exe in use?) — close Anvil and run: npm run dist:brand`);
}
