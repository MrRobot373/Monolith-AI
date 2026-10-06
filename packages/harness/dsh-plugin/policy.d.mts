export function classifyRisk(
  call: { name: string; args: unknown },
  policy: { approvals: "risky" | "always" | "never"; askForNetwork: boolean; connectors: { name: string; approveTools: string[] }[] },
): string | null;
