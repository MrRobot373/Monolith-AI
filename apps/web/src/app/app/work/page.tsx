"use client";

import { CheckCircle2, Circle, Globe, Loader2, Mail, MessageSquareText, Plug, ShieldCheck, Sparkles, Terminal, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { Badge } from "@/components/ui/misc";

const STEPS = [
  { icon: Globe, label: "Searched the web privately for 3 competitor pricing pages", state: "done" },
  { icon: Plug, label: "Read 12 files from Google Drive › Sales › Q3", state: "done" },
  { icon: Terminal, label: "Ran analysis script in your sandbox", state: "done" },
  { icon: Mail, label: "Draft email to leadership: waiting for your approval", state: "approve" },
  { icon: MessageSquareText, label: "Post summary to #sales on Slack", state: "todo" },
] as const;

export default function WorkPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pt-16 pb-16 sm:px-6">
        <div className="flex items-center gap-2">
          <Workflow className="size-5 text-accent" />
          <h1 className="text-xl font-semibold tracking-tight">Work AI</h1>
          <Badge tone="accent">Coming next</Badge>
        </div>
        <p className="mt-2 max-w-xl text-fg-muted">
          Hand off a whole task. The agent plans it, uses your connected tools inside a private sandbox, and asks before doing anything risky.
        </p>

        <div className="mt-8 rounded-2xl border border-border bg-surface p-4 opacity-90">
          <div className="text-[15px] text-fg-muted">Compare our Q3 pricing against competitors, draft a summary for leadership, and post it to #sales.</div>
          <div className="mt-4 flex items-center gap-2 text-xs text-fg-subtle">
            <span className="rounded-md border border-border px-2 py-1">Google Drive</span>
            <span className="rounded-md border border-border px-2 py-1">Gmail</span>
            <span className="rounded-md border border-border px-2 py-1">Slack</span>
            <span className="rounded-md border border-border px-2 py-1">Web search</span>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-border bg-bg-subtle p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium">Preview · Task timeline</span>
            <span className="flex items-center gap-1.5 text-xs text-fg-subtle"><ShieldCheck className="size-3.5" /> Runs in your sandbox</span>
          </div>
          <ol className="space-y-1">
            {STEPS.map((s, i) => (
              <motion.li
                key={s.label}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.08 }}
                className="flex items-center gap-3 rounded-lg px-2 py-2"
              >
                {s.state === "done" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                ) : s.state === "approve" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
                ) : (
                  <Circle className="size-4 shrink-0 text-fg-subtle" />
                )}
                <s.icon className="size-4 shrink-0 text-fg-subtle" />
                <span className={s.state === "todo" ? "text-sm text-fg-subtle" : "text-sm"}>{s.label}</span>
                {s.state === "approve" && (
                  <span className="ml-auto flex gap-1.5">
                    <span className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg">Approve</span>
                    <span className="rounded-md border border-border px-2 py-1 text-xs text-fg-muted">Edit</span>
                  </span>
                )}
              </motion.li>
            ))}
          </ol>
        </div>
        <p className="mt-6 flex items-center gap-2 text-sm text-fg-subtle">
          <Sparkles className="size-4" /> Powered by an open-source agent engine running on your own servers.
        </p>
      </div>
    </div>
  );
}
