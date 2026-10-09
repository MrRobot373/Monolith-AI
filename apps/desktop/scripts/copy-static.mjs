// Copies the local pages (connect screen, offline page) next to the compiled main process.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// fileURLToPath, not URL.pathname: on Windows the pathname is "/D:/…", which isn't a path.
const root = fileURLToPath(new URL("..", import.meta.url));
rmSync(join(root, "dist", "static"), { recursive: true, force: true });
cpSync(join(root, "static"), join(root, "dist", "static"), { recursive: true });
