/**
 * Projects with Work AI (docs/03-projects.md, Phase C). A task in a project gets the project's
 * instructions, a copy of its current sources in `project/` in its folder, and only the
 * connectors the project allows. Access is checked again whenever the task's runtime starts.
 */
import { and, asc, document, eq, isNull, project, projectSource, sql, type DB } from "@aatmiq/db";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Storage } from "./storage";

export type Project = typeof project.$inferSelect;

/** Copies stop here; the rest stay in the project (README says so). */
const MAX_COPY_BYTES = 200 * 1024 * 1024;
export const PROJECT_FOLDER = "project";

/** The project, if this person can still open it: in its workspace, and owner, member, workspace-visible or an admin. */
export async function projectFor(db: DB, userId: string, projectId: string): Promise<Project | null> {
  // Single-table selects leave columns unqualified, so the subqueries name the outer row explicitly.
  const p = sql.raw('"project"');
  const [row] = await db
    .select()
    .from(project)
    .where(
      and(
        eq(project.id, projectId),
        sql`(exists (select 1 from workspace_member wm where wm.workspace_id = ${p}."workspace_id" and wm.user_id = ${userId})
          or exists (select 1 from "user" u where u.id = ${userId} and u.org_role in ('owner', 'admin')))`,
        sql`(${p}."owner_id" = ${userId} or ${p}."visibility" = 'workspace'
          or exists (select 1 from project_member pm where pm.project_id = ${p}."id" and pm.user_id = ${userId})
          or exists (select 1 from workspace_member wm where wm.workspace_id = ${p}."workspace_id" and wm.user_id = ${userId} and wm.role = 'admin')
          or exists (select 1 from "user" u where u.id = ${userId} and u.org_role in ('owner', 'admin')))`,
      ),
    );
  return row ?? null;
}

const LABEL: Record<string, string> = { confirmed: "Confirmed", assumption: "Assumption", tbd: "TBD" };
const KIND: Record<string, string> = { file: "File", note: "Note", answer: "Saved answer" };

/** A file name that is safe in a folder and unique in it (case-insensitively). */
function uniqueName(raw: string, used: Set<string>): string {
  const clean = raw.replace(/[\\/\0]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "source";
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let name = clean;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Write the project's current sources (not the replaced versions) into `dir`, replacing what was
 * there, with a README listing them and their labels. Returns how many were copied and left out.
 */
export async function writeProjectFiles(db: DB, storage: Storage, p: Project, dir: string): Promise<{ copied: number; skipped: number }> {
  const rows = await db
    .select({ name: document.name, kind: document.kind, label: document.label, storageKey: document.storageKey, sizeBytes: document.sizeBytes })
    .from(projectSource)
    .innerJoin(document, eq(document.id, projectSource.documentId))
    .where(and(eq(projectSource.projectId, p.id), isNull(document.supersededById)))
    .orderBy(asc(projectSource.createdAt));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const used = new Set(["readme.md"]);
  const lines: string[] = [];
  let total = 0;
  let skipped = 0;
  for (const r of rows) {
    if (total + r.sizeBytes > MAX_COPY_BYTES) {
      skipped++;
      continue;
    }
    const data = await storage.get(r.storageKey).catch(() => null);
    if (!data) {
      skipped++;
      continue;
    }
    const name = uniqueName(r.name, used);
    await writeFile(join(dir, name), data);
    total += data.length;
    lines.push(`| ${name.replace(/\|/g, "\\|")} | ${KIND[r.kind] ?? r.kind} | ${r.label ? LABEL[r.label] : ""} |`);
  }
  const readme = [
    `# Project: ${p.name}`,
    "",
    "Copies of the project's sources, refreshed each time this task starts. Changes here aren't saved to the project; put your own work outside this folder.",
    "",
    ...(lines.length ? ["| File | Type | Label |", "|---|---|---|", ...lines] : ["The project has no sources yet."]),
    ...(skipped ? ["", `${skipped} more source(s) weren't copied (too large in total, or unreadable).`] : []),
    "",
    "Labels: Confirmed sources are checked; Assumption and TBD sources aren't confirmed, so say so when you rely on them.",
    "",
  ].join("\n");
  await writeFile(join(dir, "README.md"), readme);
  return { copied: lines.length, skipped };
}

/** What the agent is told about the project (added to its system prompt). */
export function projectInstructions(p: Project, copied: number): string {
  return [
    `This task belongs to the project "${p.name}"${p.description ? ` (${p.description})` : ""}.`,
    p.instructions ? `The project's instructions, which you follow:\n${p.instructions}` : "",
    copied
      ? `The project's files are in the folder \`${PROJECT_FOLDER}/\` (copies; ${PROJECT_FOLDER}/README.md lists them with their labels). Read the ones that matter for the task. Save your own results outside \`${PROJECT_FOLDER}/\`.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
