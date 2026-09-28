"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";

/* Single-series charts. One series = one color (--color-chart-1), no legend box; the card title names it. */

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

export interface DailyPoint {
  date: string;
  input: number;
  output: number;
}

/** Daily token columns: ≤24px columns, 4px rounded tops, 2px gaps, hairline grid, hover tooltip. */
export function DailyColumns({ data, height = 180 }: { data: DailyPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => d.input + d.output);
  const max = niceMax(Math.max(...totals, 0));
  const ticks = [0, max / 2, max];
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="relative">
      <div className="flex" style={{ height }}>
        {/* y ticks */}
        <div className="relative w-10 shrink-0 text-[10.5px] text-fg-subtle">
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2 tabular-nums" style={{ top: `${100 - (t / max) * 100}%` }}>
              {formatTokens(t)}
            </span>
          ))}
        </div>
        <div className="relative flex-1" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px bg-border" style={{ top: `${100 - (t / max) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {data.map((d, i) => {
              const v = d.input + d.output;
              return (
                <div
                  key={d.date}
                  className="flex h-full flex-1 items-end justify-center"
                  onMouseEnter={() => setHover(i)}
                  aria-label={`${d.date}: ${v.toLocaleString()} tokens`}
                >
                  <div
                    className={cn(
                      "w-full max-w-6 rounded-t-[4px] bg-chart-1 transition-[height,opacity] duration-500 ease-out",
                      hover !== null && hover !== i && "opacity-40",
                    )}
                    style={{ height: v > 0 ? `max(2px, ${(v / max) * 100}%)` : 0 }}
                  />
                </div>
              );
            })}
          </div>
          {h && hover !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-44 animate-fade-in rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-soft"
              style={{ left: `${((hover + 0.5) / data.length) * 100}%`, transform: `translateX(${hover < data.length / 4 ? "-10%" : hover > (data.length * 3) / 4 ? "-90%" : "-50%"})` }}
            >
              <div className="text-fg-muted">
                {new Date(`${h.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
              </div>
              <div className="mt-1 flex justify-between"><span className="text-fg-muted">Total</span><span className="font-medium tabular-nums">{(h.input + h.output).toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-fg-subtle">Input</span><span className="tabular-nums text-fg-muted">{h.input.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-fg-subtle">Output</span><span className="tabular-nums text-fg-muted">{h.output.toLocaleString()}</span></div>
            </div>
          )}
        </div>
      </div>
      {/* x labels: first, middle, last */}
      <div className="mt-2 ml-10 flex justify-between text-[10.5px] text-fg-subtle">
        {[data[0], data[Math.floor(data.length / 2)], data[data.length - 1]].map((d, i) => (
          <span key={i}>{d ? new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</span>
        ))}
      </div>
      {/* Table view for screen readers */}
      <table className="sr-only">
        <caption>Tokens per day</caption>
        <thead><tr><th>Date</th><th>Input</th><th>Output</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.input}</td><td>{d.output}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/** Ranked horizontal bars with text labels and the value at the tip. */
export function BarList({
  rows,
  empty = "No usage yet",
}: {
  rows: { key: string; label: string; sub?: string | null; value: number }[];
  empty?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-fg-subtle">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <ul className="space-y-2.5" onMouseLeave={() => setHover(null)}>
      {rows.map((r) => (
        <li key={r.key} onMouseEnter={() => setHover(r.key)} className="group" title={`${r.label}: ${r.value.toLocaleString()} tokens (${Math.round((r.value / total) * 100)}%)`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate">
              {r.label}
              {r.sub && <span className="ml-1.5 text-xs text-fg-subtle">{r.sub}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-fg-muted">
              {formatTokens(r.value)}
              <span className={cn("ml-1.5 text-xs text-fg-subtle transition-opacity", hover === r.key ? "opacity-100" : "opacity-0")}>
                {Math.round((r.value / total) * 100)}%
              </span>
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-2">
            <div
              className={cn("h-full rounded-full bg-chart-1 transition-[width,opacity] duration-500 ease-out", hover && hover !== r.key && "opacity-40")}
              style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-[12.5px] text-fg-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}
