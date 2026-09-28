"use client";

import {
  ChevronDown,
  ChevronRight,
  Code2,
  File,
  Files,
  Folder,
  GitBranch,
  Monitor,
  Play,
  Puzzle,
  Search,
  Terminal,
  X,
} from "lucide-react";
import { TopBar, TopBarButton } from "@/components/app/frame";
import { LogoMark } from "@/components/ui/logo";
import { cn } from "@/lib/cn";

const TREE: [number, string, "dir" | "open" | "file", boolean?][] = [
  [0, "billing-service", "open"],
  [1, "node_modules", "dir"],
  [1, "public", "dir"],
  [1, "src", "open"],
  [2, "components", "dir"],
  [2, "lib", "open"],
  [3, "invoices.ts", "file", true],
  [3, "customers.ts", "file"],
  [3, "db.ts", "file"],
  [2, "index.ts", "file"],
  [1, "tests", "dir"],
  [1, "package.json", "file"],
];

type Line = { n: number; t: React.ReactNode; kind?: "add" | "del" };
const k = (s: string) => <span className="text-[#c792ea]">{s}</span>;
const f = (s: string) => <span className="text-[#82aaff]">{s}</span>;
const str = (s: string) => <span className="text-[#c3e88d]">{s}</span>;
const ty = (s: string) => <span className="text-[#ffcb6b]">{s}</span>;
const c = (s: string) => <span className="text-fg-subtle italic">{s}</span>;

const CODE: Line[] = [
  { n: 1, t: <>{k("import")} {"{ db }"} {k("from")} {str('"./db"')};</> },
  { n: 2, t: <>{k("import type")} {"{ "}{ty("Invoice")}{" }"} {k("from")} {str('"./types"')};</> },
  { n: 3, t: "" },
  { n: 4, t: c("/** Unpaid invoices for a customer, newest first. */") },
  { n: 5, t: <>{k("export async function")} {f("getInvoices")}(customerId: {ty("string")}) {"{"}</> },
  { n: 6, t: <>{"  "}{k("const")} rows = {k("await")} db.invoice.{f("findMany")}({"{ where: { customerId } }"});</>, kind: "del" },
  { n: 6, t: <>{"  "}{k("const")} rows = {k("await")} db.invoice.{f("findMany")}({"{"}</>, kind: "add" },
  { n: 7, t: <>{"    where: { customerId, status: "}{str('"unpaid"')}{" },"}</>, kind: "add" },
  { n: 8, t: <>{"    orderBy: { issuedAt: "}{str('"desc"')}{" },"}</>, kind: "add" },
  { n: 9, t: <>{"    take: "}<span className="text-[#f78c6c]">50</span>,</>, kind: "add" },
  { n: 10, t: "  });", kind: "add" },
  { n: 11, t: <>{"  "}{k("return")} rows {k("as")} {ty("Invoice")}[];</> },
  { n: 12, t: "}" },
];

export default function CodePage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Code2 />}
        title={
          <span className="flex items-center gap-2">
            Code <span className="rounded border border-border px-1.5 text-[11px] text-fg-subtle">Preview</span>
          </span>
        }
        actions={
          <>
            <TopBarButton disabled>
              <Monitor /> Open desktop app
            </TopBarButton>
            <TopBarButton disabled>
              <Play /> Run
            </TopBarButton>
          </>
        }
      />
      <div className="border-b border-border px-4 py-2 text-center text-[12.5px] text-fg-subtle">
        A preview of Aatmiq Code: the full VS Code editor with a built-in agent. It arrives after Work AI.
      </div>
      <div className="flex min-h-0 flex-1 font-mono text-[12.5px]">
        {/* Activity bar */}
        <div className="flex w-11 shrink-0 flex-col items-center gap-4 border-r border-border py-3 text-fg-subtle">
          <Files className="size-[18px] text-fg" />
          <Search className="size-[18px]" />
          <GitBranch className="size-[18px]" />
          <Puzzle className="size-[18px]" />
          <LogoMark className="size-[18px]" />
        </div>
        {/* Explorer */}
        <div className="hidden w-56 shrink-0 border-r border-border py-2 font-sans text-[13px] md:block">
          <div className="px-3 pb-2 text-[11px] tracking-wide text-fg-subtle uppercase">Explorer</div>
          {TREE.map(([d, name, kind, active], i) => (
            <div
              key={i}
              className={cn("flex h-6 items-center gap-1 pr-2", active ? "bg-surface-2 text-fg" : "text-fg-muted")}
              style={{ paddingLeft: 8 + d * 12 }}
            >
              {kind === "file" ? (
                <File className="ml-4 size-3.5 text-fg-subtle" />
              ) : (
                <>
                  {kind === "open" ? <ChevronDown className="size-3.5 text-fg-subtle" /> : <ChevronRight className="size-3.5 text-fg-subtle" />}
                  <Folder className="size-3.5 text-fg-subtle" />
                </>
              )}
              <span className="truncate">{name}</span>
            </div>
          ))}
        </div>
        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-stretch border-b border-border font-sans text-[12.5px]">
            <div className="flex items-center gap-2 border-r border-border bg-surface px-3 text-fg">
              invoices.ts <X className="size-3 text-fg-subtle" />
            </div>
            <div className="flex items-center gap-2 border-r border-border px-3 text-fg-subtle">
              customers.ts <X className="size-3" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-surface py-2 leading-6">
            {CODE.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "flex gap-4 border-l-2 pr-4",
                  l.kind === "add" && "border-success bg-success-soft",
                  l.kind === "del" && "border-danger bg-danger-soft line-through decoration-danger/40",
                  !l.kind && "border-transparent",
                )}
              >
                <span className="w-8 shrink-0 text-right text-fg-subtle select-none">{l.n}</span>
                <span className="text-fg whitespace-pre">{l.t}</span>
              </div>
            ))}
          </div>
          <div className="h-32 shrink-0 border-t border-border p-3 leading-6">
            <div className="mb-1 flex items-center gap-2 font-sans text-[11px] tracking-wide text-fg-subtle uppercase">
              <Terminal className="size-3.5" /> Terminal
            </div>
            <div className="text-fg-muted">$ pnpm test invoices</div>
            <div className="text-success">✓ 8 passed (412ms)</div>
          </div>
        </div>
        {/* Agent panel */}
        <div className="hidden w-80 shrink-0 flex-col border-l border-border font-sans lg:flex">
          <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-[13px]">
            <LogoMark className="size-4" /> Aatmiq
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">Only return unpaid invoices, newest first, max 50. Add tests.</div>
            <div className="space-y-1.5 text-fg-muted">
              <div>› Thought for 4s</div>
              <div>› Read src/lib/invoices.ts</div>
              <div>› Edited 2 files</div>
              <div>› Ran pnpm test invoices</div>
            </div>
            <div className="rounded-lg border border-border">
              <div className="flex items-center justify-between px-3 py-2">
                <span>2 files changed</span>
                <span>
                  <span className="text-success">+14</span> <span className="text-danger">−1</span>
                </span>
              </div>
              <div className="flex gap-2 border-t border-border px-3 py-2">
                <span className="rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-medium text-primary-fg">Accept</span>
                <span className="rounded-md border border-border px-2.5 py-1 text-[12.5px] text-fg-muted">Review</span>
              </div>
            </div>
          </div>
          <div className="m-3 rounded-lg border border-border-strong px-3 py-2.5 text-[13px] text-fg-subtle">Ask Aatmiq to change code…</div>
        </div>
      </div>
    </div>
  );
}
