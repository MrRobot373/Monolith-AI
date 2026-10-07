import { NextResponse, type NextRequest } from "next/server";

/**
 * With IDE_URL, the IDE's own host serves only the IDE (proxied to the API): none of Aatmiq's pages
 * load there, so nothing of Aatmiq runs on the origin the IDE's extensions share.
 */
export function proxy(req: NextRequest) {
  const ideUrl = process.env.IDE_URL;
  if (!ideUrl) return NextResponse.next();
  let ideHost: string;
  try {
    ideHost = new URL(ideUrl).host.toLowerCase();
  } catch {
    return NextResponse.next();
  }
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
  if (host !== ideHost) return NextResponse.next();
  const p = req.nextUrl.pathname;
  if (p === "/code/ide" || p.startsWith("/code/ide/") || p === "/api/health") return NextResponse.next();
  return new NextResponse("Not found", { status: 404, headers: { "content-type": "text/plain" } });
}
