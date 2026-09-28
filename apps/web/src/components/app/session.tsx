"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, get, post } from "@/lib/api";
import { applyAccent } from "@/lib/theme";
import type { Me } from "@/lib/types";

interface SessionValue {
  me: Me;
  workspaceId: string;
  workspace: Me["workspaces"][number] | undefined;
  setWorkspaceId: (id: string) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

const WS_KEY = "aatmiq.workspace";

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside <SessionGate>");
  return v;
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/api/me"), staleTime: 30_000 });
}

/** Loads the signed-in user or redirects to /login. Provides the current workspace. */
export function SessionGate({ children, requireAdmin }: { children: ReactNode; requireAdmin?: "org" | "any" }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { data: me, error } = useMe();
  const [workspaceId, setWs] = useState<string>("");

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [error, router, pathname]);

  useEffect(() => applyAccent(me?.org.accentColor), [me?.org.accentColor]);

  useEffect(() => {
    if (!me) return;
    let saved = "";
    try {
      saved = localStorage.getItem(WS_KEY) ?? "";
    } catch {}
    const valid = me.workspaces.find((w) => w.id === (workspaceId || saved));
    if (!valid && me.workspaces[0]) setWs(me.workspaces[0].id);
    else if (valid && valid.id !== workspaceId) setWs(valid.id);
  }, [me, workspaceId]);

  const setWorkspaceId = useCallback((id: string) => {
    setWs(id);
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {}
  }, []);

  const signOut = useCallback(async () => {
    await post("/api/auth/sign-out").catch(() => {});
    qc.clear();
    router.replace("/login");
  }, [qc, router]);

  const value = useMemo<SessionValue | null>(
    () =>
      me
        ? { me, workspaceId, workspace: me.workspaces.find((w) => w.id === workspaceId), setWorkspaceId, signOut }
        : null,
    [me, workspaceId, setWorkspaceId, signOut],
  );

  if (!value) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-fg-subtle">
        {error && !(error instanceof ApiError && error.status === 401) ? (
          <p className="text-sm">Couldn&apos;t reach the server. Retrying…</p>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }
  if (requireAdmin === "org" && !me!.isAdmin) {
    router.replace("/app");
    return null;
  }
  if (requireAdmin === "any" && !me!.isAdmin && !me!.isWorkspaceAdmin) {
    router.replace("/app");
    return null;
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
