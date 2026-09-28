"use client";

import { Code2, Files, GitBranch, Monitor, Search, Sparkles, Terminal } from "lucide-react";
import { LogoMark } from "@/components/ui/logo";
import { Badge } from "@/components/ui/misc";

const CODE = [
  ["1", "export async function", " getInvoices", "(customerId: string) {"],
  ["2", "  const rows = await", " db.invoice", ".findMany({ where: { customerId } });"],
  ["3", "  return rows", ".filter", "((r) => r.status !== \"void\");"],
  ["4", "}", "", ""],
];

export default function CodePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 pt-16 pb-16 sm:px-6">
        <div className="flex items-center gap-2">
          <Code2 className="size-5 text-accent" />
          <h1 className="text-xl font-semibold tracking-tight">Code</h1>
          <Badge tone="accent">Coming next</Badge>
        </div>
        <p className="mt-2 max-w-2xl text-fg-muted">
          A full IDE built on VS Code (editor, terminal, git, debugger, extensions), as a desktop app and in the browser. The Aatmiq panel on the right lets the agent write code directly in your project.
        </p>

        <div className="mt-8 overflow-hidden rounded-2xl border border-border bg-bg-subtle font-mono text-[12px] shadow-soft">
          <div className="flex h-9 items-center justify-between border-b border-border px-3 text-fg-subtle">
            <span>billing-service — Aatmiq Code</span>
            <Monitor className="size-3.5" />
          </div>
          <div className="grid grid-cols-[40px_180px_1fr_260px] max-lg:grid-cols-[40px_1fr_240px] max-md:grid-cols-[40px_1fr]">
            <div className="flex flex-col items-center gap-4 border-r border-border py-3 text-fg-subtle">
              <Files className="size-4 text-fg" />
              <Search className="size-4" />
              <GitBranch className="size-4" />
              <LogoMark className="size-4" />
            </div>
            <div className="border-r border-border p-3 text-fg-muted max-lg:hidden">
              <div className="mb-2 text-[10px] tracking-wide text-fg-subtle uppercase">Explorer</div>
              {["src/", "  invoices.ts", "  customers.ts", "tests/", "package.json"].map((f) => (
                <div key={f} className={f.includes("invoices") ? "rounded bg-surface-2 px-1 text-fg" : "px-1"}>
                  {f}
                </div>
              ))}
            </div>
            <div className="min-h-64 bg-surface">
              <div className="flex border-b border-border text-fg-muted">
                <span className="border-r border-border bg-bg-subtle px-3 py-1.5 text-fg">invoices.ts</span>
              </div>
              <div className="p-3 leading-6">
                {CODE.map(([n, a, b, c]) => (
                  <div key={n} className="flex gap-4">
                    <span className="w-4 text-right text-fg-subtle">{n}</span>
                    <span>
                      <span className="text-[#c084fc]">{a}</span>
                      <span className="text-accent-text">{b}</span>
                      <span className="text-fg">{c}</span>
                    </span>
                  </div>
                ))}
                <div className="mt-2 flex gap-4 rounded bg-success-soft">
                  <span className="w-4 text-right text-success">+</span>
                  <span className="text-success">  // Aatmiq: added pagination + test coverage</span>
                </div>
              </div>
              <div className="border-t border-border p-3 text-fg-muted">
                <div className="mb-1 flex items-center gap-2 text-[10px] tracking-wide text-fg-subtle uppercase">
                  <Terminal className="size-3" /> Terminal
                </div>
                <div>$ pnpm test</div>
                <div className="text-success">✓ 24 passed</div>
              </div>
            </div>
            <div className="border-l border-border p-3 font-sans max-md:hidden">
              <div className="mb-3 flex items-center gap-2 text-[12px] font-medium text-fg">
                <LogoMark className="size-4" /> Aatmiq
              </div>
              <div className="rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] text-fg">Add pagination to getInvoices and write tests</div>
              <div className="mt-3 space-y-1.5 text-[11.5px] text-fg-muted">
                <div>✓ Read invoices.ts</div>
                <div>✓ Edited 2 files</div>
                <div>✓ Ran pnpm test</div>
              </div>
              <div className="mt-3 flex gap-1.5 text-[11px]">
                <span className="rounded-md bg-accent px-2 py-1 font-medium text-accent-fg">Accept</span>
                <span className="rounded-md border border-border px-2 py-1 text-fg-muted">Review diff</span>
              </div>
            </div>
          </div>
        </div>
        <p className="mt-6 flex items-center gap-2 text-sm text-fg-subtle">
          <Sparkles className="size-4" /> Works as a normal editor with AI switched off.
        </p>
      </div>
    </div>
  );
}
