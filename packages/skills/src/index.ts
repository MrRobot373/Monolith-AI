/**
 * The built-in skill library. Each skill is a folder in `library/` with a SKILL.md (YAML
 * frontmatter: name, description, category) and, for some, helper scripts it refers to.
 * Work AI copies the enabled ones into each task's skills folder.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolved through the package itself, so it works from source, tests, and a bundled API build.
export const LIBRARY_DIR = join(dirname(createRequire(import.meta.url).resolve("@aatmiq/skills/package.json")), "library");

export const LIBRARY_CATEGORIES = ["Software development", "Data", "Documents & writing", "Business", "Apps"] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export interface LibrarySkill {
  /** Folder and skill name, e.g. "code-review". */
  slug: string;
  /** Human title from the first heading. */
  title: string;
  description: string;
  category: LibraryCategory;
  /** Absolute path of the skill's folder. */
  dir: string;
  /** The SKILL.md instructions without frontmatter. */
  body: string;
  /** Other files shipped with the skill (relative paths). */
  files: string[];
}

function frontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    data[kv[1]!] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "__pycache__" || e.name.endsWith(".pyc")) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (rel !== "SKILL.md") out.push(rel);
  }
  return out;
}

let cache: LibrarySkill[] | null = null;

/** Copy filter: skip caches and hidden files when installing a skill somewhere. */
export function shipsFile(path: string): boolean {
  return !/(^|\/)(__pycache__|\.[^/]+)(\/|$)|\.pyc$/.test(path);
}

/** Every skill in the library, sorted by category then title. */
export function librarySkills(): LibrarySkill[] {
  if (cache) return cache;
  if (!existsSync(LIBRARY_DIR)) return (cache = []);
  const skills: LibrarySkill[] = [];
  for (const e of readdirSync(LIBRARY_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(LIBRARY_DIR, e.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const { data, body } = frontmatter(readFileSync(file, "utf8"));
    if (!data.name || !data.description) continue;
    const category = (LIBRARY_CATEGORIES as readonly string[]).includes(data.category ?? "") ? (data.category as LibraryCategory) : "Business";
    skills.push({
      slug: data.name,
      title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? data.name,
      description: data.description,
      category,
      dir,
      body,
      files: listFiles(dir),
    });
  }
  const order = (c: LibraryCategory) => LIBRARY_CATEGORIES.indexOf(c);
  return (cache = skills.sort((a, b) => order(a.category) - order(b.category) || a.title.localeCompare(b.title)));
}

export function librarySkill(slug: string): LibrarySkill | undefined {
  return librarySkills().find((s) => s.slug === slug);
}
