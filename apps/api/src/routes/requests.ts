import { and, desc, eq, inArray, or, tokenRequest, user, workspace, workspaceMember } from "@aatmiq/db";
import { decideRequestSchema, formatTokens, isOrgAdmin, periodStart, tokenRequestSchema } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { audit, notify, parse, requireUser, requireWorkspaceCap, type AppContext } from "../context";
import { conflict, notFound } from "../errors";
import { getOrgPeriod, getQuotaStatus } from "../services/quota";

export async function requestRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  /** A member asks for more tokens. Workspace admins and org admins are notified. */
  app.post("/api/token-requests", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(tokenRequestSchema, req.body);
    await requireWorkspaceCap(ctx, u, body.workspaceId, "workspace.use");

    const [pending] = await db
      .select({ id: tokenRequest.id })
      .from(tokenRequest)
      .where(
        and(
          eq(tokenRequest.workspaceId, body.workspaceId),
          eq(tokenRequest.userId, u.id),
          eq(tokenRequest.status, "pending"),
        ),
      );
    if (pending) throw conflict("You already have a pending request in this workspace.");

    const [created] = await db
      .insert(tokenRequest)
      .values({ ...body, userId: u.id })
      .returning();

    const [ws] = await db.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, body.workspaceId));
    const approvers = await db
      .select({ id: user.id })
      .from(user)
      .leftJoin(
        workspaceMember,
        and(eq(workspaceMember.userId, user.id), eq(workspaceMember.workspaceId, body.workspaceId)),
      )
      .where(
        and(
          eq(user.status, "active"),
          or(inArray(user.orgRole, ["owner", "admin"]), eq(workspaceMember.role, "admin")),
        ),
      );
    await notify(
      db,
      approvers.map((a) => a.id).filter((id) => id !== u.id),
      {
        type: "token_request.created",
        title: `${u.name} requested ${formatTokens(body.amount)} more tokens`,
        body: `${ws?.name ?? "Workspace"}${body.reason ? ` · "${body.reason}"` : ""}`,
        link: "/admin/requests",
      },
    );
    await audit(ctx, {
      actor: u,
      action: "token_request.created",
      workspaceId: body.workspaceId,
      targetType: "token_request",
      targetId: created!.id,
      meta: { amount: body.amount, duration: body.duration },
    });
    return created;
  });

  /**
   * ?scope=mine → the caller's own requests.
   * ?scope=review → requests the caller can decide (org admins: all; workspace admins: their workspaces).
   */
  app.get<{ Querystring: { scope?: "mine" | "review"; status?: "pending" | "approved" | "denied" } }>(
    "/api/token-requests",
    async (req) => {
      const u = await requireUser(ctx, req);
      const conds = [];
      if (req.query.scope !== "review") {
        conds.push(eq(tokenRequest.userId, u.id));
      } else if (!isOrgAdmin(u.orgRole)) {
        const adminOf = await db
          .select({ id: workspaceMember.workspaceId })
          .from(workspaceMember)
          .where(and(eq(workspaceMember.userId, u.id), eq(workspaceMember.role, "admin")));
        if (adminOf.length === 0) return [];
        conds.push(inArray(tokenRequest.workspaceId, adminOf.map((w) => w.id)));
      }
      if (req.query.status) conds.push(eq(tokenRequest.status, req.query.status));

      return db
        .select({
          request: tokenRequest,
          userName: user.name,
          userEmail: user.email,
          workspaceName: workspace.name,
        })
        .from(tokenRequest)
        .innerJoin(user, eq(user.id, tokenRequest.userId))
        .innerJoin(workspace, eq(workspace.id, tokenRequest.workspaceId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tokenRequest.createdAt))
        .limit(200)
        .then((rows) =>
          Promise.all(
            rows.map(async (r) => ({
              ...r.request,
              userName: r.userName,
              userEmail: r.userEmail,
              workspaceName: r.workspaceName,
              quota:
                req.query.scope === "review" && r.request.status === "pending"
                  ? await getQuotaStatus(db, r.request.workspaceId, r.request.userId)
                  : undefined,
            })),
          ),
        );
    },
  );

  app.post<{ Params: { id: string } }>("/api/token-requests/:id/decide", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(decideRequestSchema, req.body);
    const [r] = await db.select().from(tokenRequest).where(eq(tokenRequest.id, req.params.id));
    if (!r) throw notFound("Request not found");
    await requireWorkspaceCap(ctx, u, r.workspaceId, "workspace.requests.decide");
    if (r.status !== "pending") throw conflict("This request was already decided.");

    const amount = body.amount ?? r.amount;
    const period = await getOrgPeriod(db);
    const start = periodStart(period);

    if (body.decision === "approved" && r.duration === "permanent") {
      // Permanent: raise the member's own limit by `amount` over their current effective limit.
      const q = await getQuotaStatus(db, r.workspaceId, r.userId);
      const newLimit = (q.user.limit ?? 0) + amount;
      await db
        .update(workspaceMember)
        .set({ tokenLimit: newLimit })
        .where(and(eq(workspaceMember.workspaceId, r.workspaceId), eq(workspaceMember.userId, r.userId)));
    }

    const [updated] = await db
      .update(tokenRequest)
      .set({
        status: body.decision,
        decidedAmount: body.decision === "approved" ? amount : null,
        decidedBy: u.id,
        decidedAt: new Date(),
        note: body.note ?? null,
        periodStart: body.decision === "approved" && r.duration === "period" ? start : null,
      })
      .where(and(eq(tokenRequest.id, r.id), eq(tokenRequest.status, "pending")))
      .returning();
    if (!updated) throw conflict("This request was already decided.");

    await notify(db, [r.userId], {
      type: `token_request.${body.decision}`,
      title:
        body.decision === "approved"
          ? `Your request was approved: +${formatTokens(amount)} tokens`
          : "Your token request was declined",
      body: body.note ?? undefined,
      link: "/app/settings#usage",
    });
    await audit(ctx, {
      actor: u,
      action: `token_request.${body.decision}`,
      workspaceId: r.workspaceId,
      targetType: "token_request",
      targetId: r.id,
      meta: { requested: r.amount, decided: amount, duration: r.duration },
    });
    return updated;
  });
}
