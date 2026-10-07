import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIBRARY_CATEGORIES, librarySkills } from "./index";

const skills = librarySkills();

describe("skill library", () => {
  it("has skills in every category", () => {
    expect(skills.length).toBeGreaterThanOrEqual(50);
    for (const c of LIBRARY_CATEGORIES) expect(skills.some((s) => s.category === c)).toBe(true);
  });

  it("names are valid, unique and match their folders; descriptions say when to use them", () => {
    const names = new Set<string>();
    for (const s of skills) {
      expect(s.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(s.dir.endsWith(`/${s.slug}`)).toBe(true);
      expect(names.has(s.slug)).toBe(false);
      names.add(s.slug);
      expect(s.description.length).toBeGreaterThan(60);
      expect(s.description.length).toBeLessThanOrEqual(160);
      expect(s.description).toMatch(/^Use (when|for)/);
      // The raw frontmatter declares a category we recognize.
      expect(readFileSync(join(s.dir, "SKILL.md"), "utf8")).toMatch(new RegExp(`\\ncategory: ${s.category.replace("&", "\\&")}\\n`));
      expect(s.body).toMatch(/^# /m);
      expect(s.body).toMatch(/## Done when/);
    }
  });

  it("every script a skill mentions exists, and Python scripts compile", () => {
    for (const s of skills) {
      for (const m of s.body.matchAll(/(?<!\.\/)scripts\/([\w.-]+\.(?:py|sh))/g)) {
        const own = join(s.dir, "scripts", m[1]!);
        const sibling = skills.some((o) => existsSync(join(o.dir, "scripts", m[1]!)));
        expect(existsSync(own) || sibling, `${s.slug} mentions scripts/${m[1]}`).toBe(true);
      }
      for (const f of s.files.filter((f) => f.endsWith(".py"))) execFileSync("python3", ["-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", join(s.dir, f)]);
      for (const f of s.files.filter((f) => f.endsWith(".sh"))) execFileSync("bash", ["-n", join(s.dir, f)]);
    }
  });

  it("cross-references point to real skills", () => {
    const names = new Set(skills.map((s) => s.slug));
    for (const s of skills) {
      for (const m of s.body.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)` skill|see `([a-z0-9]+(?:-[a-z0-9]+)+)`|follow(?:ing)? `([a-z0-9]+(?:-[a-z0-9]+)+)`/g)) {
        const ref = m[1] ?? m[2] ?? m[3];
        expect(names.has(ref!), `${s.slug} refers to ${ref}`).toBe(true);
      }
    }
  });
});
