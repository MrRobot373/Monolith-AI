"use client";

import {
  ChevronRight,
  CircleCheck,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Loader2,
  Mail,
  PanelRight,
  Plus,
  Slack,
  Sparkles,
  Workflow,
} from "lucide-react";
import { motion } from "motion/react";
import { TopBar, TopBarButton } from "@/components/app/frame";
import { LogoMark } from "@/components/ui/logo";

const STEPS = [
  { icon: ChevronRight, text: "Thought for 9s" },
  { icon: FolderSearch, text: "Read 12 files in Google Drive › Sales › Q3" },
  { icon: Globe, text: "Searched the web privately: 3 competitor pricing pages" },
  { icon: ChevronRight, text: "Thought for 6s" },
  { icon: FileText, text: "Created Pricing comparison.xlsx" },
];

export default function WorkPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Workflow />}
        title={
          <span className="flex items-center gap-2">
            Work AI <span className="rounded border border-border px-1.5 text-[11px] text-fg-subtle">Preview</span>
          </span>
        }
        actions={
          <>
            <TopBarButton disabled>
              <ListChecks /> Review changes
            </TopBarButton>
            <TopBarButton disabled>
              <PanelRight />
            </TopBarButton>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        {/* Thread */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[720px] px-4 pt-8 pb-8 sm:px-6">
              <p className="mb-6 rounded-lg border border-dashed border-border px-3 py-2 text-center text-[12.5px] text-fg-subtle">
                A preview of how Work AI will run tasks for you. It arrives in the next release.
              </p>
              <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-[14px] leading-relaxed">
                Compare our Q3 pricing with our top three competitors, put it in a spreadsheet, and draft a summary email to the
                leadership team. Post the summary in #sales once I approve it.
              </div>

              <div className="mt-5 space-y-2.5 pl-1">
                {STEPS.map((s, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.08 * i }}
                    className="flex items-center gap-2.5 text-[13px] text-fg-muted"
                  >
                    <s.icon className="size-3.5 text-fg-subtle" />
                    {s.text}
                  </motion.div>
                ))}
              </div>

              <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface">
                <div className="px-4 pt-3.5 pb-3">
                  <div className="text-[14px] font-medium">Pricing research</div>
                  <p className="mt-1 text-[13px] text-fg-muted">
                    I compared 14 plans across 3 competitors. We&apos;re 12% cheaper on the base tier but 8% more expensive on Enterprise.
                  </p>
                </div>
                <div className="border-t border-border px-4 py-2.5">
                  <div className="text-[12px] text-fg-subtle">Files edited</div>
                  <div className="mt-1.5 flex items-center gap-2 text-[13px]">
                    <FileText className="size-3.5 text-fg-subtle" /> Pricing comparison.xlsx
                  </div>
                </div>
                <div className="border-t border-border px-4 py-2.5">
                  <div className="flex items-center justify-between text-[12px] text-fg-subtle">
                    <span>Progress</span>
                    <span>3 of 4</span>
                  </div>
                  <ol className="mt-1.5 space-y-1.5 text-[13px]">
                    {[
                      ["Gather our Q3 prices", true],
                      ["Research competitor pricing", true],
                      ["Build comparison spreadsheet", true],
                      ["Draft and send the summary", false],
                    ].map(([t, done]) => (
                      <li key={t as string} className="flex items-center gap-2">
                        {done ? <CircleCheck className="size-3.5 text-success" /> : <Loader2 className="size-3.5 animate-spin text-fg-subtle" />}
                        <span className={done ? "text-fg-muted" : "text-fg"}>{t}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-border-strong bg-surface p-4">
                <div className="flex items-center gap-2 text-[13px]">
                  <Mail className="size-3.5 text-fg-subtle" /> Waiting for your approval
                </div>
                <p className="mt-2 text-[13px] text-fg-muted">
                  Send &ldquo;Q3 pricing vs competitors&rdquo; to leadership@acme.com, then post the summary in{" "}
                  <span className="inline-flex items-center gap-1 text-fg">
                    <Slack className="size-3" /> #sales
                  </span>
                  .
                </p>
                <div className="mt-3 flex gap-2">
                  <span className="inline-flex h-7 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-fg">Approve</span>
                  <span className="inline-flex h-7 items-center rounded-md border border-border px-3 text-[13px] text-fg-muted">Edit draft</span>
                </div>
              </div>
            </div>
          </div>
          <div className="px-4 pb-3 sm:px-6">
            <div className="mx-auto max-w-[720px] rounded-xl border border-border-strong bg-surface opacity-70">
              <div className="px-4 pt-3.5 pb-1 text-[14px] text-fg-subtle">Ask anything, @ for context</div>
              <div className="flex items-center gap-3 px-3 pt-1 pb-2.5 text-[12.5px] text-fg-subtle">
                <Plus className="size-4" />
                <span>Planning</span>
                <span className="flex items-center gap-1">
                  <Sparkles className="size-3.5" /> Skills
                </span>
                <span>Qwen3 · on your servers</span>
              </div>
            </div>
          </div>
        </div>

        {/* Plan panel */}
        <aside className="hidden w-[380px] shrink-0 flex-col border-l border-border xl:flex">
          <div className="flex h-10 items-center gap-4 border-b border-border px-4 text-[12.5px]">
            <span className="text-fg">Plan</span>
            <span className="text-fg-subtle">Task</span>
            <span className="text-fg-subtle">Walkthrough</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 text-[13px] leading-relaxed">
            <div className="flex items-center gap-2 text-fg-subtle">
              <LogoMark className="size-4" /> Implementation plan
            </div>
            <h3 className="mt-3 font-serif text-[22px] leading-snug text-fg">Q3 pricing comparison</h3>
            <p className="mt-2 text-fg-muted">
              Collect our current price list, gather public competitor pricing, normalize plans to comparable tiers and summarize
              the differences for leadership.
            </p>
            <div className="mt-5 text-[12px] text-fg-subtle">Tools this task may use</div>
            <ul className="mt-2 space-y-2">
              {[
                ["Google Drive", "read only"],
                ["Web search", "self-hosted"],
                ["Spreadsheet", "create"],
                ["Gmail", "needs approval"],
                ["Slack", "needs approval"],
              ].map(([t, a]) => (
                <li key={t} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                  <span>{t}</span>
                  <span className="text-[12px] text-fg-subtle">{a}</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
