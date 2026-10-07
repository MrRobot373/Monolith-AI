"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BarChart3, Cpu, Inbox, KeyRound, LayoutDashboard, Layers, ScrollText, Settings2, ShieldCheck, Users, UsersRound, Workflow } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppFrame, TopBar } from "@/components/app/frame";
import { SessionGate, useSession } from "@/components/app/session";
import { WorkspaceTile } from "@/components/app/sidebar";
import { SidebarStateProvider } from "@/components/app/sidebar-state";
import { LicenseBanner } from "@/components/admin/license";
import { OrgLogo } from "@/components/org-logo";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";

const GROUPS = [
  {
    label: "Organization",
    items: [
      { href: "/admin", label: "Overview", icon: LayoutDashboard, org: true, exact: true },
      { href: "/admin/users", label: "Users", icon: Users, org: true },
      { href: "/admin/groups", label: "Groups", icon: UsersRound, org: true },
      { href: "/admin/workspaces", label: "Workspaces", icon: Layers },
      { href: "/admin/models", label: "Models", icon: Cpu, org: true },
    ],
  },
  {
    label: "Activity",
    items: [
      { href: "/admin/requests", label: "Token requests", icon: Inbox, badge: true },
      { href: "/admin/usage", label: "Usage", icon: BarChart3 },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, org: true },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/admin/settings", label: "Settings", icon: Settings2, org: true },
      { href: "/admin/authentication", label: "Authentication", icon: ShieldCheck, org: true },
      { href: "/admin/work", label: "Work AI", icon: Workflow, org: true },
      { href: "/admin/license", label: "License", icon: KeyRound, org: true },
    ],
  },
];

function AdminNav() {
  const { me } = useSession();
  const pathname = usePathname();
  const pending = useQuery({
    queryKey: ["review-requests", "pending"],
    queryFn: () => get<unknown[]>("/api/token-requests?scope=review&status=pending"),
    refetchInterval: 30_000,
  });
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => me.isAdmin || !("org" in i && i.org)) })).filter(
    (g) => g.items.length,
  );

  return (
    <aside className="flex w-full shrink-0 flex-col border-border bg-bg-subtle md:h-full md:w-[232px] md:border-r">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        {me.org.logoUrl ? <OrgLogo src={me.org.logoUrl} className="size-5" /> : <WorkspaceTile name={me.org.name} />}
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg">{me.org.name}</div>
          <div className="text-[11.5px] text-fg-subtle">{me.isAdmin ? "Admin console" : "Workspace admin"}</div>
        </div>
      </div>
      <nav className="flex gap-4 overflow-x-auto px-2 pb-2 md:flex-col md:gap-3 md:overflow-visible md:pt-2">
        {groups.map((g) => (
          <div key={g.label} className="flex shrink-0 gap-px md:flex-col">
            <div className="hidden px-2 pb-1 text-[12px] text-fg-subtle md:block">{g.label}</div>
            {g.items.map((i) => {
              const active = "exact" in i && i.exact ? pathname === i.href : pathname.startsWith(i.href);
              const count = "badge" in i && i.badge ? (pending.data?.length ?? 0) : 0;
              return (
                <Link
                  key={i.href}
                  href={i.href}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-[13px] whitespace-nowrap transition-colors",
                    active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
                  )}
                >
                  <i.icon className={cn("size-4", active ? "text-fg" : "text-fg-subtle")} />
                  <span className="flex-1">{i.label}</span>
                  {count > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-medium text-accent-fg">
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="mt-auto hidden border-t border-border p-2 md:block">
        <Link href="/app" className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <ArrowLeft className="size-4 text-fg-subtle" /> Back to workspace
        </Link>
      </div>
    </aside>
  );
}

const TITLES: Record<string, string> = {
  "": "Overview",
  users: "Users",
  groups: "Groups",
  workspaces: "Workspaces",
  models: "Models",
  requests: "Token requests",
  usage: "Usage",
  audit: "Audit log",
  settings: "Settings",
  license: "License",
  authentication: "Authentication",
  work: "Work AI",
};

function Crumbs() {
  const pathname = usePathname();
  const seg = pathname.split("/")[2] ?? "";
  const sub = pathname.split("/")[3];
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-fg-subtle">Admin</span>
      <span className="text-fg-subtle">/</span>
      {sub ? (
        <>
          <Link href={`/admin/${seg}`} className="text-fg-subtle hover:text-fg">{TITLES[seg]}</Link>
          <span className="text-fg-subtle">/</span>
          <span>Details</span>
        </>
      ) : (
        <span>{TITLES[seg] ?? "Admin"}</span>
      )}
    </span>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate requireAdmin="any">
      <SidebarStateProvider>
        <AppFrame className="flex-col md:flex-row">
          <AdminNav />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="hidden md:block">
              <TopBar title={<Crumbs />} />
            </div>
            <LicenseBanner />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-6xl animate-fade-in px-4 py-8 sm:px-8">{children}</div>
            </div>
          </main>
        </AppFrame>
      </SidebarStateProvider>
    </SessionGate>
  );
}
