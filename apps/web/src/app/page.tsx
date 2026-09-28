import { redirect } from "next/navigation";
import { Landing } from "@/components/marketing/landing";

export const dynamic = "force-dynamic";

/**
 * The public landing page. Customer deployments set SHOW_MARKETING=false so "/" goes straight to the app.
 */
export default function Home() {
  if (process.env.SHOW_MARKETING === "false") redirect("/app");
  return <Landing />;
}
