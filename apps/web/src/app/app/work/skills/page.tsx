"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MoreHorizontal, Pencil, Plus, Sparkles, Trash2, User, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { WorkTabs } from "@/components/work/parts";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, EmptyState, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, patch, post } from "@/lib/api";
import type { Skill } from "@/lib/work";

export default function SkillsPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const skills = useQuery({ queryKey: ["work-skills"], queryFn: () => get<Skill[]>("/api/work/skills") });
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const [removing, setRemoving] = useState<Skill | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["work-skills"] });
  const toggle = useMutation({
    mutationFn: (s: Skill) => patch(`/api/work/skills/${s.id}`, { enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (s: Skill) => del(`/api/work/skills/${s.id}`),
    onSuccess: () => {
      refresh();
      setRemoving(null);
      toast("Skill deleted");
    },
  });

  const all = skills.data ?? [];
  const groups = [
    { key: "org", title: "Organization", hint: "Shared with everyone. Admins manage these.", icon: Building2, items: all.filter((s) => s.scope === "org") },
    { key: "personal", title: "Yours", hint: "Only your tasks use these.", icon: User, items: all.filter((s) => s.scope === "personal") },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Workflow />}
        title="Work AI"
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing("new")} data-testid="new-skill">
            <Plus className="size-3.5" /> New skill
          </Button>
        }
      />
      <WorkTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Skills</h1>
          <p className="mt-1 max-w-xl text-[13px] text-fg-subtle">
            Reusable instructions for recurring work: how your team writes reports, checks invoices or formats data. The agent reads a skill&apos;s description and follows it when it fits the task.
          </p>
          {skills.isLoading ? (
            <Skeleton className="mt-6 h-40 rounded-xl" />
          ) : all.length === 0 ? (
            <EmptyState
              className="mt-6 rounded-xl border border-dashed border-border"
              icon={<Sparkles className="size-5" />}
              title="No skills yet"
              description="Write down how a task should be done once, and every Work AI task can follow it."
              action={
                <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
                  <Plus className="size-3.5" /> New skill
                </Button>
              }
            />
          ) : (
            <div className="mt-6 space-y-8">
              {groups
                .filter((g) => g.items.length)
                .map((g) => (
                  <section key={g.key}>
                    <div className="mb-2 flex items-center gap-2 text-[13px] text-fg">
                      <g.icon className="size-3.5 text-fg-subtle" /> {g.title}
                      <span className="text-[12px] text-fg-subtle">· {g.hint}</span>
                    </div>
                    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                      {g.items.map((s) => (
                        <div key={s.id} className="flex items-center gap-3 px-4 py-3" data-testid="skill-row">
                          <Sparkles className="size-3.5 shrink-0 text-fg-subtle" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-[13.5px] text-fg">
                              {s.name}
                              {!s.enabled && <Badge>Off</Badge>}
                            </div>
                            <div className="truncate text-[12px] text-fg-subtle">{s.description}</div>
                          </div>
                          {s.editable && (
                            <>
                              <Switch checked={s.enabled} onCheckedChange={() => toggle.mutate(s)} label={`Use ${s.name}`} />
                              <Menu>
                                <MenuTrigger asChild>
                                  <Button variant="ghost" size="icon-sm" aria-label={`Options for ${s.name}`}>
                                    <MoreHorizontal className="size-4" />
                                  </Button>
                                </MenuTrigger>
                                <MenuContent align="end">
                                  <MenuItem icon={<Pencil />} onSelect={() => setEditing(s)}>Edit</MenuItem>
                                  <MenuSeparator />
                                  <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(s)}>Delete</MenuItem>
                                </MenuContent>
                              </Menu>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          )}
        </div>
      </div>
      {editing && <SkillDialog key={editing === "new" ? "new" : editing.id} skill={editing === "new" ? undefined : editing} canOrg={me.isAdmin} onClose={() => setEditing(null)} onSaved={refresh} />}
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete “${removing?.name}”?`}
        description={removing?.scope === "org" ? "Nobody's tasks will use it any more." : "Your tasks won't use it any more."}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Delete</Button>
          </>
        }
      />
    </div>
  );
}

function SkillDialog({ skill, canOrg, onClose, onSaved }: { skill?: Skill; canOrg: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    body: skill?.body ?? "",
    scope: skill?.scope ?? ("personal" as "org" | "personal"),
  });
  const save = useMutation({
    mutationFn: () =>
      skill
        ? patch(`/api/work/skills/${skill.id}`, { name: form.name, description: form.description, body: form.body })
        : post("/api/work/skills", form),
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(skill ? "Skill saved" : "Skill added. New tasks can use it.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = form.name.trim() && form.description.trim() && form.body.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={skill ? "Edit skill" : "New skill"}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-skill">
            {skill ? "Save" : "Add skill"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field label="Name">
            <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monthly sales report" data-testid="skill-name" />
          </Field>
          {!skill && canOrg && (
            <Field label="Who can use it">
              <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as "org" | "personal" })}>
                <option value="personal">Only me</option>
                <option value="org">Everyone</option>
              </Select>
            </Field>
          )}
        </div>
        <Field label="When to use it" hint="The agent reads this to decide whether the skill fits a task.">
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Use when asked for a monthly sales report" data-testid="skill-description" />
        </Field>
        <Field label="Instructions" hint="Steps, rules, templates and examples. Markdown works.">
          <Textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            rows={12}
            className="font-mono text-[12.5px] leading-relaxed"
            placeholder={"1. Load sales.csv from the folder\n2. Group by region and month\n3. Save report.md with a summary table and a chart (chart.png)"}
            data-testid="skill-body"
          />
        </Field>
      </div>
    </Dialog>
  );
}
