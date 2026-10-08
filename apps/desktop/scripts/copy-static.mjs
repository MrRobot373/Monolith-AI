// Copies the local pages (connect screen, offline page) next to the compiled main process.
import { cpSync, rmSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
rmSync(`${root}dist/static`, { recursive: true, force: true });
cpSync(`${root}static`, `${root}dist/static`, { recursive: true });
