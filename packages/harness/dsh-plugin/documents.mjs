/**
 * The documents_* tools: the organization's documents in Aatmiq (the person's library, documents
 * shared with the workspace, and the sources of projects they can open). Searching uses Aatmiq's
 * keyword and meaning search (embeddings); the agent only ever sees what the task's person may
 * open. Every call goes to Aatmiq's internal API with the task's token.
 * Plain JavaScript on purpose: loaded directly by the harness runtime.
 */

const LABEL = { confirmed: "Confirmed", assumption: "Assumption, not confirmed", tbd: "TBD, not confirmed" };

/** Search results as the agent reads them. */
export function formatResults(query, results) {
  if (!results.length) return `No passages in the organization's documents match "${query}". Try other words, or ask the person to upload the document.`;
  const lines = [`${results.length} passage${results.length === 1 ? "" : "s"} for "${query}" (most relevant first):`];
  results.forEach((r, i) => {
    const where = [r.name, r.page ? `page ${r.page}` : null, r.label ? LABEL[r.label] : null].filter(Boolean).join(", ");
    lines.push("", `[${i + 1}] ${where} (document_id: ${r.documentId})`, r.text);
  });
  lines.push("", "Quote or cite the document name when you use these. documents_read gives a whole document.");
  return lines.join("\n");
}

/**
 * @param {Function} defineTool DSH's defineTool
 * @param {(path: string, init?: object) => Promise<any>} call Aatmiq's internal API
 */
export function documentTools(defineTool, call) {
  const output = {
    schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
    render: (_args, value) => [{ type: "text", text: value.text }],
  };
  const tool = (name, description, parameters, run) =>
    defineTool({ name, description, parameters, output, timeoutMs: 60_000, execute: (args, exec) => run(args ?? {}, exec.signal) });

  return [
    tool(
      "documents_search",
      "Search the organization's documents in Aatmiq (the person's own, ones shared with the workspace, and project files they can open) for passages about something. Finds passages by meaning, not only exact words. Use it when the person asks about company information, policies, contracts, reports or anything that may be written down.",
      {
        query: { type: "string", required: true, description: "What to look for, in plain words (a question works well)." },
        limit: { type: "integer", description: "How many passages (1–12, default 6)." },
      },
      async (a, signal) => {
        const query = String(a.query ?? "").trim();
        const r = await call("/documents/search", { method: "POST", body: JSON.stringify({ query, limit: a.limit }), signal });
        return { text: formatResults(query, r.results ?? []) };
      },
    ),
    tool(
      "documents_read",
      "Read a whole document from the organization's documents, by the document_id that documents_search gave. Long documents come in parts: continue with the offset it suggests.",
      {
        document_id: { type: "string", required: true },
        offset: { type: "integer", description: "Where to continue, in characters (default 0)." },
      },
      async (a, signal) => {
        const r = await call(`/documents/${encodeURIComponent(String(a.document_id ?? ""))}?offset=${Math.max(0, Number(a.offset ?? 0) || 0)}`, { signal });
        const head = [`Document: ${r.name}${r.label ? ` (${LABEL[r.label]})` : ""}`];
        if (r.status !== "ready") head.push(`(still being read by Aatmiq: ${r.status})`);
        const more = r.more ? `\n\n(more: call documents_read with offset ${r.next} — ${r.total.toLocaleString()} characters in all)` : "";
        return { text: `${head.join("\n")}\n\n${r.text || "(no readable text)"}${more}` };
      },
    ),
    tool(
      "documents_save",
      "Save a file from your working folder to the person's documents in Aatmiq (their private library), so it can be searched and used in chats later. Supported: PDF, Word (.docx), Excel (.xlsx), text, Markdown, CSV, HTML, JSON, code and images (up to 25 MB).",
      {
        path: { type: "string", required: true, description: "The file, relative to the working folder (e.g. report.docx)." },
        name: { type: "string", description: "The name to show in Documents (default: the file's name)." },
      },
      async (a, signal) => {
        const r = await call("/documents/save", { method: "POST", body: JSON.stringify({ path: String(a.path ?? ""), name: a.name ? String(a.name) : undefined }), signal });
        return { text: `Saved ${r.name} to the person's documents (document_id: ${r.documentId}). Aatmiq is reading it now; it can be searched in a minute.` };
      },
    ),
  ];
}
