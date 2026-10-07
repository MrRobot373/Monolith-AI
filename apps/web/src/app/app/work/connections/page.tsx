"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Workflow } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { WorkTabs } from "@/components/work/parts";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, post } from "@/lib/api";
import { ConnectorIcon } from "@/lib/connectors";

interface Connection {
  id: string;
  name: string;
  displayName: string;
  catalogId: string | null;
  description: string | null;
  category: string | null;
  auth: "none" | "token" | "oauth";
  connected: boolean;
  account: { label: string | null; status: string; connectedAt: string } | null;
}

export default function ConnectionsPage() {
  return (
    <Suspense>
      <Connections />
    </Suspense>
  );
}

function Connections() {
  const qc = useQueryClient();
  const { me } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const list = useQuery({ queryKey: ["connections"], queryFn: () => get<Connection[]>("/api/connectors") });
  const [removing, setRemoving] = useState<Connection | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["connections"] });

  // Back from a service's sign-in page.
  useEffect(() => {
    const ok = params.get("connected");
    const err = params.get("connector_error");
    if (!ok && !err) return;
    if (ok) toast.success("Connected. Your Work AI tasks can use it now.");
    if (err) toast.error(err);
    router.replace("/app/work/connections");
  }, [params, router]);

  const connect = useMutation({
    mutationFn: (c: Connection) => post<{ url: string }>(`/api/connectors/${c.id}/connect`, { returnTo: "/app/work/connections" }),
    onSuccess: (r) => {
      window.location.href = r.url;
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const disconnect = useMutation({
    mutationFn: (c: Connection) => del(`/api/connectors/${c.id}/connection`),
    onSuccess: () => {
      refresh();
      setRemoving(null);
      toast("Disconnected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all = list.data ?? [];
  const personal = all.filter((c) => c.auth === "oauth");
  const shared = all.filter((c) => c.auth !== "oauth");
  const isAdmin = !!me?.isAdmin;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar icon={<Workflow />} title="Work AI" />
      <WorkTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Connections</h1>
          <p className="mt-1 max-w-xl text-[13px] text-fg-subtle">
            Apps your tasks can use. Connect your own accounts and the agent works with your access: your mailbox, your calendar, your designs. It asks before changing anything.
          </p>
          {list.isLoading ? (
            <Skeleton className="mt-6 h-40 rounded-xl" />
          ) : all.length === 0 ? (
            <EmptyState
              className="mt-6 rounded-xl border border-dashed border-border"
              icon={<Plug className="size-5" />}
              title="No apps yet"
              description={isAdmin ? "Add Gmail, Canva, GitHub and more in Admin → Work AI → Connectors." : "Your admin hasn't added any apps yet."}
            />
          ) : (
            <div className="mt-6 space-y-8">
              {personal.length > 0 && (
                <section>
                  <h2 className="mb-2 text-[13px] text-fg">Your accounts</h2>
                  <Card className="divide-y divide-border">
                    {personal.map((c) => (
                      <div key={c.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5" data-testid="connection-row" data-name={c.name}>
                        <ConnectorIcon category={c.category} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-[13.5px] text-fg">
                            {c.displayName}
                            {c.connected && <Badge tone="success">Connected</Badge>}
                            {c.account?.status === "expired" && <Badge tone="warning">Needs reconnecting</Badge>}
                          </div>
                          <div className="truncate text-[12px] text-fg-subtle">
                            {c.connected && c.account?.label ? `Signed in as ${c.account.label}` : (c.description ?? "")}
                          </div>
                        </div>
                        {c.connected ? (
                          <Button variant="ghost" size="sm" onClick={() => setRemoving(c)} data-testid="disconnect">
                            Disconnect
                          </Button>
                        ) : (
                          <Button variant="primary" size="sm" loading={connect.isPending && connect.variables?.id === c.id} onClick={() => connect.mutate(c)} data-testid="connect">
                            {c.account?.status === "expired" ? "Reconnect" : "Connect"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </Card>
                </section>
              )}
              {shared.length > 0 && (
                <section>
                  <h2 className="mb-2 text-[13px] text-fg">Ready for everyone</h2>
                  <Card className="divide-y divide-border">
                    {shared.map((c) => (
                      <div key={c.id} className="flex items-center gap-4 px-4 py-3.5" data-testid="connection-row" data-name={c.name}>
                        <ConnectorIcon category={c.category} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] text-fg">{c.displayName}</div>
                          <div className="truncate text-[12px] text-fg-subtle">{c.description ?? (c.auth === "token" ? "Set up by your admin." : "Open service.")}</div>
                        </div>
                        <Badge>On</Badge>
                      </div>
                    ))}
                  </Card>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Disconnect ${removing?.displayName}?`}
        description="Your tasks stop using it, and Aatmiq forgets your sign-in. You can connect again any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={disconnect.isPending} onClick={() => removing && disconnect.mutate(removing)} data-testid="confirm-disconnect">
              Disconnect
            </Button>
          </>
        }
      />
    </div>
  );
}
