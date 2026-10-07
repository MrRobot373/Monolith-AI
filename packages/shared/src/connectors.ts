/**
 * Connector catalog: official remote MCP servers people commonly connect, with how each signs in.
 * Admins add one in Admin → Work AI → Connectors; for `oauth` entries each person then connects
 * their own account (Work AI → Connections).
 *
 *  - oauth + client "dynamic": nothing to set up; Aatmiq registers itself with the service.
 *  - oauth + client "admin":   the admin creates an OAuth app at the service and enters its id/secret.
 *  - token:                    the admin enters a shared API key or token.
 *  - none:                     an open server.
 */

export type ConnectorAuth = "none" | "token" | "oauth";

export interface CatalogConnector {
  id: string;
  name: string;
  category: CatalogCategory;
  description: string;
  url: string;
  auth: ConnectorAuth;
  /** For oauth: register automatically, or the admin brings an OAuth app. */
  client?: "dynamic" | "admin";
  /** Scopes to request (space-separated). Empty: let the server decide. */
  scopes?: string;
  /** For token auth: the header to send and how its value is built from the token. */
  tokenHeader?: { name: string; prefix: string; label: string };
  /** What the admin has to do first, in plain words. */
  setup?: string;
  docsUrl?: string;
  /** Default approval rule (comma-separated globs over tool names; `!glob` never asks). */
  approveTools?: string;
}

export type CatalogCategory = "Email & calendar" | "Files & docs" | "Design" | "Chat & meetings" | "Projects & tasks" | "CRM & support" | "Payments & commerce" | "Developer" | "Data" | "Knowledge";

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  "Email & calendar",
  "Files & docs",
  "Design",
  "Chat & meetings",
  "Projects & tasks",
  "CRM & support",
  "Payments & commerce",
  "Developer",
  "Data",
  "Knowledge",
];

/** Tool-name prefixes that only read. Under the default rule these run without asking. */
export const READ_TOOL_PREFIXES = ["get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "lookup", "retrieve", "show", "check"];

/** Approval presets for connector tools. */
export const APPROVAL_PRESETS = {
  /** Ask before every tool call. */
  all: "*",
  /** Ask before anything that changes something; reading tools run freely. */
  changes: ["*", ...READ_TOOL_PREFIXES.flatMap((p) => [`!${p}_*`, `!${p}`])].join(","),
  /** Never ask (open, read-only servers). */
  none: "",
} as const;

const GOOGLE_SETUP =
  "In Google Cloud: enable the product's API and its MCP API (for example gmail.googleapis.com and gmailmcp.googleapis.com), configure the OAuth consent screen (choose “Internal” if everyone is in your Google Workspace: then Google needs no app verification), then create an OAuth client of type “Web application” with the redirect URI shown here. One client works for all Google connectors.";
const GOOGLE_DOCS = "https://developers.google.com/workspace/guides/configure-mcp-servers";

export const CONNECTOR_CATALOG: CatalogConnector[] = [
  /* Email & calendar */
  {
    id: "gmail",
    name: "Gmail",
    category: "Email & calendar",
    description: "Search and read email, and draft replies, in each person's own mailbox.",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
    setup: GOOGLE_SETUP,
    docsUrl: GOOGLE_DOCS,
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    category: "Email & calendar",
    description: "See calendars, events and free/busy times.",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes:
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly",
    setup: GOOGLE_SETUP,
    docsUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
  },
  {
    id: "calendly",
    name: "Calendly",
    category: "Email & calendar",
    description: "Event types, scheduled meetings and booking links.",
    url: "https://mcp.calendly.com",
    auth: "oauth",
    client: "dynamic",
  },

  /* Files & docs */
  {
    id: "google-drive",
    name: "Google Drive",
    category: "Files & docs",
    description: "Find and read files in Drive, and create new ones.",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
    setup: GOOGLE_SETUP,
    docsUrl: GOOGLE_DOCS,
  },
  {
    id: "google-docs",
    name: "Google Docs",
    category: "Files & docs",
    description: "Read and write Google Docs.",
    url: "https://docsmcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/documents",
    setup: GOOGLE_SETUP,
    docsUrl: GOOGLE_DOCS,
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    category: "Files & docs",
    description: "Read and update spreadsheets.",
    url: "https://sheetsmcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/spreadsheets",
    setup: GOOGLE_SETUP,
    docsUrl: GOOGLE_DOCS,
  },
  {
    id: "google-slides",
    name: "Google Slides",
    category: "Files & docs",
    description: "Read and build presentations.",
    url: "https://slidesmcp.googleapis.com/mcp/v1",
    auth: "oauth",
    client: "admin",
    scopes:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/presentations.readonly https://www.googleapis.com/auth/presentations",
    setup: GOOGLE_SETUP,
    docsUrl: GOOGLE_DOCS,
  },
  { id: "notion", name: "Notion", category: "Files & docs", description: "Search, read and edit Notion pages and databases.", url: "https://mcp.notion.com/mcp", auth: "oauth", client: "dynamic" },
  {
    id: "dropbox",
    name: "Dropbox",
    category: "Files & docs",
    description: "Find, read and organize files in Dropbox.",
    url: "https://mcp.dropbox.com/mcp",
    auth: "oauth",
    client: "dynamic",
  },
  {
    id: "box",
    name: "Box",
    category: "Files & docs",
    description: "Search and read files in Box.",
    url: "https://mcp.box.com",
    auth: "oauth",
    client: "admin",
    setup: "In the Box Developer Console, create an OAuth 2.0 app with the redirect URI shown here, then enter its client ID and secret.",
    docsUrl: "https://developer.box.com/guides/box-mcp/",
  },

  /* Design */
  {
    id: "canva",
    name: "Canva",
    category: "Design",
    description: "Find, create and export Canva designs, and use brand templates.",
    url: "https://mcp.canva.com/mcp",
    auth: "oauth",
    client: "dynamic",
    docsUrl: "https://www.canva.dev/docs/mcp",
  },
  { id: "figma", name: "Figma", category: "Design", description: "Read Figma files, frames and design tokens.", url: "https://mcp.figma.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "miro", name: "Miro", category: "Design", description: "Read and add to Miro boards.", url: "https://mcp.miro.com/", auth: "oauth", client: "dynamic" },
  { id: "gamma", name: "Gamma", category: "Design", description: "Generate presentations, documents and web pages.", url: "https://mcp.gamma.app/mcp", auth: "oauth", client: "dynamic" },

  /* Chat & meetings */
  {
    id: "slack",
    name: "Slack",
    category: "Chat & meetings",
    description: "Search messages and channels, read threads and post messages.",
    url: "https://mcp.slack.com/mcp",
    auth: "oauth",
    client: "admin",
    scopes: "search:read channels:history channels:read groups:history groups:read im:history mpim:history users:read chat:write",
    setup: "Create a Slack app (api.slack.com/apps), add the redirect URI shown here under OAuth & Permissions, and enable it for MCP. Then enter its client ID and secret.",
    docsUrl: "https://docs.slack.dev/ai/mcp-server",
  },
  {
    id: "zoom",
    name: "Zoom",
    category: "Chat & meetings",
    description: "Meetings, recordings and summaries.",
    url: "https://mcp.zoom.us/mcp/zoom/streamable",
    auth: "oauth",
    client: "admin",
    setup: "In the Zoom App Marketplace, create a general OAuth app with the redirect URI shown here, then enter its client ID and secret.",
  },
  { id: "fireflies", name: "Fireflies.ai", category: "Chat & meetings", description: "Meeting transcripts and notes.", url: "https://api.fireflies.ai/mcp", auth: "oauth", client: "dynamic" },

  /* Projects & tasks */
  { id: "linear", name: "Linear", category: "Projects & tasks", description: "Issues, projects and cycles.", url: "https://mcp.linear.app/mcp", auth: "oauth", client: "dynamic" },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    category: "Projects & tasks",
    description: "Jira issues and Confluence pages (Atlassian Cloud).",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
    client: "dynamic",
  },
  {
    id: "asana",
    name: "Asana",
    category: "Projects & tasks",
    description: "Tasks, projects and portfolios.",
    url: "https://mcp.asana.com/v2/mcp",
    auth: "oauth",
    client: "admin",
    setup: "In the Asana developer console, create an app with the redirect URI shown here, then enter its client ID and secret.",
    docsUrl: "https://developers.asana.com/docs/using-asanas-mcp-server",
  },
  { id: "monday", name: "monday.com", category: "Projects & tasks", description: "Boards, items and updates.", url: "https://mcp.monday.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "clickup", name: "ClickUp", category: "Projects & tasks", description: "Tasks, lists and docs.", url: "https://mcp.clickup.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "todoist", name: "Todoist", category: "Projects & tasks", description: "Personal and team to-dos.", url: "https://ai.todoist.net/mcp", auth: "oauth", client: "dynamic" },

  /* CRM & support */
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM & support",
    description: "Contacts, companies, deals and tickets.",
    url: "https://mcp.hubspot.com",
    auth: "oauth",
    client: "admin",
    setup: "In HubSpot, create an MCP auth app (Development → MCP Auth Apps) with the redirect URI shown here, then enter its client ID and secret.",
    docsUrl: "https://developers.hubspot.com/mcp",
  },
  { id: "intercom", name: "Intercom", category: "CRM & support", description: "Conversations, contacts and help articles.", url: "https://mcp.intercom.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "attio", name: "Attio", category: "CRM & support", description: "CRM records, lists and notes.", url: "https://mcp.attio.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "close", name: "Close", category: "CRM & support", description: "Leads, opportunities and activities.", url: "https://mcp.close.com/mcp", auth: "oauth", client: "dynamic" },

  /* Payments & commerce */
  { id: "stripe", name: "Stripe", category: "Payments & commerce", description: "Customers, payments, invoices and subscriptions.", url: "https://mcp.stripe.com", auth: "oauth", client: "dynamic" },
  { id: "paypal", name: "PayPal", category: "Payments & commerce", description: "Invoices, orders and transactions.", url: "https://mcp.paypal.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "square", name: "Square", category: "Payments & commerce", description: "Payments, orders, catalog and customers.", url: "https://mcp.squareup.com/mcp", auth: "oauth", client: "dynamic" },

  /* Developer */
  {
    id: "github",
    name: "GitHub",
    category: "Developer",
    description: "Repositories, issues, pull requests and Actions.",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "oauth",
    client: "admin",
    scopes: "repo read:org read:user",
    setup: "In GitHub (Settings → Developer settings → OAuth Apps), create an OAuth app with the redirect URI shown here as its callback URL, then enter its client ID and a client secret.",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "github-token",
    name: "GitHub (shared token)",
    category: "Developer",
    description: "GitHub with one fine-grained token for the whole organization.",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    tokenHeader: { name: "Authorization", prefix: "Bearer ", label: "Personal access token" },
    setup: "Create a fine-grained personal access token with access to the repositories the agent may use.",
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  { id: "sentry", name: "Sentry", category: "Developer", description: "Errors, issues and releases.", url: "https://mcp.sentry.dev/mcp", auth: "oauth", client: "dynamic" },
  { id: "vercel", name: "Vercel", category: "Developer", description: "Projects, deployments and logs.", url: "https://mcp.vercel.com/", auth: "oauth", client: "dynamic" },
  { id: "netlify", name: "Netlify", category: "Developer", description: "Sites, deploys and forms.", url: "https://netlify-mcp.netlify.app/mcp", auth: "oauth", client: "dynamic" },
  { id: "cloudflare", name: "Cloudflare Workers", category: "Developer", description: "Workers, KV, R2 and D1.", url: "https://bindings.mcp.cloudflare.com/mcp", auth: "oauth", client: "dynamic" },

  /* Data */
  { id: "supabase", name: "Supabase", category: "Data", description: "Projects, tables, SQL and edge functions.", url: "https://mcp.supabase.com/mcp", auth: "oauth", client: "dynamic" },
  { id: "neon", name: "Neon", category: "Data", description: "Serverless Postgres projects, branches and queries.", url: "https://mcp.neon.tech/mcp", auth: "oauth", client: "dynamic" },
  { id: "airtable", name: "Airtable", category: "Data", description: "Bases, tables and records.", url: "https://mcp.airtable.com/mcp", auth: "oauth", client: "dynamic" },

  /* Knowledge */
  {
    id: "deepwiki",
    name: "DeepWiki",
    category: "Knowledge",
    description: "Ask questions about public GitHub repositories.",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "none",
    approveTools: APPROVAL_PRESETS.none,
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    category: "Knowledge",
    description: "Search Microsoft's official documentation.",
    url: "https://learn.microsoft.com/api/mcp",
    auth: "none",
    approveTools: APPROVAL_PRESETS.none,
  },
  {
    id: "aws-knowledge",
    name: "AWS Knowledge",
    category: "Knowledge",
    description: "AWS documentation, guidance and regional availability.",
    url: "https://knowledge-mcp.global.api.aws",
    auth: "none",
    approveTools: APPROVAL_PRESETS.none,
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    category: "Knowledge",
    description: "Search models, datasets, papers and Spaces.",
    url: "https://hf.co/mcp",
    auth: "none",
    approveTools: APPROVAL_PRESETS.none,
  },
  {
    id: "zapier",
    name: "Zapier",
    category: "Knowledge",
    description: "Run actions in the thousands of apps your Zapier MCP server exposes.",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: "oauth",
    client: "dynamic",
  },
];

export function catalogEntry(id: string | null | undefined): CatalogConnector | undefined {
  return id ? CONNECTOR_CATALOG.find((c) => c.id === id) : undefined;
}
