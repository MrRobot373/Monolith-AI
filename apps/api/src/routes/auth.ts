import {
  and,
  eq,
  gte,
  invitation,
  isNull,
  model,
  modelProvider,
  organization,
  sql,
  user,
  workspace,
  workspaceMember,
  workspaceModel,
} from "@aatmiq/db";
import { acceptInviteSchema, DEFAULT_ACCENT, PRODUCT_NAME, setupSchema } from "@aatmiq/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import { audit, getOrg, parse, type AppContext } from "../context";
import { sha256 } from "../crypto";
import { badRequest, conflict, HttpError, notFound } from "../errors";

function forwardCookies(reply: FastifyReply, headers: Headers) {
  const cookies = headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, cfg } = ctx;

  /** Better Auth endpoints (sign-in, sign-out, session…). Public sign-up is disabled: accounts come from setup or invites. */
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    async handler(req, reply) {
      if (req.url.startsWith("/api/auth/sign-up")) {
        throw new HttpError(403, "Accounts are created by invitation. Ask your admin for an invite.", "signup_disabled");
      }
      const url = new URL(req.url, cfg.appUrl);
      const res = await auth.handler(
        new Request(url, {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body: req.method === "GET" || req.body === undefined ? undefined : JSON.stringify(req.body),
        }),
      );
      reply.status(res.status);
      res.headers.forEach((v, k) => {
        if (k !== "set-cookie" && k !== "content-length") reply.header(k, v);
      });
      forwardCookies(reply, res.headers);
      return reply.send(res.body ? await res.text() : null);
    },
  });

  /** Public: install status + branding for the login page. */
  app.get("/api/public/status", async () => {
    const org = await getOrg(db);
    return {
      setupRequired: !org,
      org: org
        ? {
            name: org.name,
            productName: org.productName ?? PRODUCT_NAME,
            accentColor: org.accentColor ?? DEFAULT_ACCENT,
            loginMessage: org.loginMessage,
          }
        : { name: null, productName: PRODUCT_NAME, accentColor: DEFAULT_ACCENT, loginMessage: null },
    };
  });

  /** First-run setup: org + owner + default workspace (+ demo model in dev). */
  app.post("/api/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(setupSchema, req.body);
    if (await getOrg(db)) throw conflict("Aatmiq is already set up on this server.");

    const [org] = await db
      .insert(organization)
      .values({ name: body.orgName, accentColor: body.accentColor ?? DEFAULT_ACCENT, licenseKey: body.licenseKey ?? null })
      .returning();

    const { headers, response } = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
      returnHeaders: true,
    });
    const ownerId = response.user.id;
    await db.update(user).set({ orgRole: "owner", emailVerified: true }).where(eq(user.id, ownerId));

    const [ws] = await db.insert(workspace).values({ name: "General", icon: "✦" }).returning();
    await db.insert(workspaceMember).values({
      workspaceId: ws!.id,
      userId: ownerId,
      role: "admin",
      sections: ["chat", "work", "code"],
    });

    if (cfg.allowMockProvider) {
      const [p] = await db.insert(modelProvider).values({ name: "Aatmiq Demo", type: "mock" }).returning();
      const [m] = await db
        .insert(model)
        .values({ providerId: p!.id, modelKey: "aatmiq-demo", displayName: "Aatmiq Demo", contextLength: 32768 })
        .returning();
      await db.insert(workspaceModel).values({ workspaceId: ws!.id, modelId: m!.id });
      await db.update(workspace).set({ defaultModelId: m!.id }).where(eq(workspace.id, ws!.id));
    }

    await audit(ctx, {
      actor: { id: ownerId, email: body.email, name: body.name, image: null, orgRole: "owner" },
      action: "org.setup",
      targetType: "organization",
      targetId: org!.id,
      ip: req.ip,
    });
    forwardCookies(reply, headers);
    return { ok: true };
  });

  async function findInvite(token: string) {
    const [inv] = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.tokenHash, sha256(token)),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          gte(invitation.expiresAt, new Date()),
        ),
      );
    if (!inv) throw notFound("This invitation link is invalid or has expired.");
    return inv;
  }

  app.get<{ Params: { token: string } }>("/api/invites/:token", async (req) => {
    const inv = await findInvite(req.params.token);
    const org = await getOrg(db);
    return { email: inv.email, orgName: org?.name ?? "", productName: org?.productName ?? PRODUCT_NAME };
  });

  app.post<{ Params: { token: string } }>(
    "/api/invites/:token/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parse(acceptInviteSchema, req.body);
      const inv = await findInvite(req.params.token);
      const [existing] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(user)
        .where(eq(sql`lower(${user.email})`, inv.email.toLowerCase()));
      if (existing && existing.n > 0) throw conflict("An account with this email already exists. Please sign in.");

      const { headers, response } = await auth.api
        .signUpEmail({ body: { email: inv.email, password: body.password, name: body.name }, returnHeaders: true })
        .catch((e: unknown) => {
          throw badRequest(e instanceof Error ? e.message : "Could not create account");
        });
      const uid = response.user.id;
      await db.update(user).set({ orgRole: inv.orgRole, emailVerified: true }).where(eq(user.id, uid));
      for (const w of inv.workspaces) {
        await db
          .insert(workspaceMember)
          .values({ workspaceId: w.workspaceId, userId: uid, role: w.role, sections: ["chat", "work", "code"] })
          .onConflictDoNothing();
      }
      await db.update(invitation).set({ acceptedAt: new Date() }).where(eq(invitation.id, inv.id));
      await audit(ctx, {
        actor: { id: uid, email: inv.email, name: body.name, image: null, orgRole: inv.orgRole },
        action: "user.invite_accepted",
        targetType: "user",
        targetId: uid,
        ip: req.ip,
      });
      forwardCookies(reply, headers);
      return { ok: true };
    },
  );
}
