"use client";

import { LogoMark } from "@aatmiq/ui/logo";
import { Avatar } from "@aatmiq/ui/misc";
import { Spinner } from "@aatmiq/ui/spinner";
import { cn } from "@aatmiq/ui/cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, LayoutDashboard, LogOut, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { get, post } from "@/lib/api";
import type { Admin } from "@/lib/types";

const AdminCtx = createContext<Admin | null>(null);
export const useAdmin = () => useContext(AdminCtx)!;

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/customers", label: "Customers", icon: Building2 },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Admin>("/api/me"), retry: false });

  useEffect(() => {
    if (me.isError) router.replace("/login");
  }, [me.isError, router]);

  if (!me.data)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner />
      </div>
    );

  return (
    <AdminCtx.Provider value={me.data}>
      <div className="h-dvh bg-canvas md:p-2">
        <div className="flex h-full flex-col overflow-hidden bg-bg md:flex-row md:rounded-xl md:border md:border-border">
          <aside className="flex shrink-0 flex-col border-border bg-bg-subtle md:w-[220px] md:border-r">
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <LogoMark className="size-5" />
              <div className="min-w-0">
                <div className="truncate text-[13px] text-fg">Aatmiq licensing</div>
                <div className="text-[11.5px] text-fg-subtle">Super Admin</div>
              </div>
            </div>
            <nav className="flex gap-px overflow-x-auto px-2 pb-2 md:flex-col md:pt-2">
              {NAV.map((n) => {
                const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-[13px] whitespace-nowrap transition-colors",
                      active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
                    )}
                  >
                    <n.icon className={cn("size-4", active ? "text-fg" : "text-fg-subtle")} />
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="mt-auto hidden items-center gap-2 border-t border-border p-2 md:flex">
              <Avatar name={me.data.name} className="size-6 text-[9px]" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-muted">{me.data.email}</span>
              <button
                aria-label="Sign out"
                onClick={async () => {
                  await post("/api/auth/logout");
                  qc.clear();
                  router.replace("/login");
                }}
                className="rounded-md p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                <LogOut className="size-4" />
              </button>
            </div>
          </aside>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl animate-fade-in px-4 py-8 sm:px-8">{children}</div>
          </main>
        </div>
      </div>
    </AdminCtx.Provider>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em] text-fg">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-fg-subtle">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
