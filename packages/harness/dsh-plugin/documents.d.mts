export interface DocumentPassage {
  documentId: string;
  name: string;
  page: number | null;
  label: "confirmed" | "assumption" | "tbd" | null;
  text: string;
}
export function formatResults(query: string, results: DocumentPassage[]): string;
export function documentTools(defineTool: (def: unknown) => unknown, call: (path: string, init?: RequestInit) => Promise<any>): unknown[];
