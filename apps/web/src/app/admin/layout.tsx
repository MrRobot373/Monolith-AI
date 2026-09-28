"use client";

import { ArrowLeft, BarChart3, Cpu, Inbox, LayoutDashboard, Layers, ScrollText, Settings2, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionGate, useSession } from "@/components/app/session";
import { LogoMark } from "@/components/ui/logo";
import { Badge } from "@/components/ui/misc";
import { cn } from "@/lib/cn";

function AdminNav() {
  const { me } = useSession();
  const pathname = usePathname();
  const orgAdmin = me.isAdmin;
  const items = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard, org: true, exact: true },
    { href: "/admin/users", label: "Users", icon: Users, org: true },
    { href: "/admin/workspaces", label: "Workspaces", icon: Layers },
    { href: "/admin/models", label: "Models", icon: Cpu, org: true },
    { href: "/admin/requests", label: "Token requests", icon: Inbox },
    { href: "/admin/usage", label: "Usage", icon: BarChart3 },
    { href: "/admin/audit", label: "Audit log", icon: ScrollText, org: true },
    { href: "/admin/settings", label: "Settings", icon: Settings2, org: true },
  ].filter((i) => orgAdmin || !i.org);

  return (
    <aside className="flex w-full shrink-0 flex-col border-border bg-bg-subtle md:h-dvh md:w-60 md:border-r">
      <div className="flex items-center gap-2.5 p-4">
        <LogoMark className="size-6" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{me.org.name}</div>
          <div className="text-[11px] text-fg-subtle">Admin console</div>
        </div>
      </div>
      <nav className="flex gap-0.5 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
        {items.map((i) => {
          const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
          return (
            <Link
              key={i.href}
              href={i.href}
              className={cn(
                "relative flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px] whitespace-nowrap transition-colors",
                active ? "bg-surface-2 font-medium text-fg" : "text-fg-muted hover:bg-surface-2/60 hover:text-fg",
              )}
            >
              <i.icon className={cn("size-4", active ? "text-accent" : "text-fg-subtle")} />
              {i.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto hidden p-3 md:block">
        {!orgAdmin && <Badge className="mb-3">Workspace admin</Badge>}
        <Link href="/app" className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <ArrowLeft className="size-4" /> Back to workspace
        </Link>
      </div>
    </aside>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate requireAdmin="any">
      <div className="flex min-h-dvh flex-col md:h-dvh md:flex-row">
        <AdminNav />
        <main className="min-w-0 flex-1 md:overflow-y-auto">
          <div className="mx-auto max-w-6xl animate-fade-in px-4 py-8 sm:px-8">{children}</div>
        </main>
      </div>
    </SessionGate>
  );
}
