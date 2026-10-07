/**
 * Which tool calls need a person's approval. Shared by the DSH plugin (runtime side) and tests.
 * Plain JavaScript on purpose: it is loaded directly by the harness runtime.
 *
 * Modes: "never" (sandbox only), "risky" (default: destructive, privileged, network, outbound
 * messages and connector tools), "always" (every action that changes something).
 */

const RISKY_COMMANDS = [
  [/(^|[\s;&|(])(rm|rmdir|shred|unlink)\s/, "Deletes files"],
  [/\bfind\b[^|;]*\s-delete\b/, "Deletes files"],
  [/(^|[\s;&|(])(truncate)\s/, "Empties files"],
  [/(^|[\s;&|(])mv\s/, "Moves or renames files"],
  [/(^|[\s;&|(])(chmod|chown|chgrp)\s/, "Changes file permissions"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|tag\s+-d)\b/, "Changes a git repository's history or its remote"],
  [/(^|[\s;&|(])(sudo|su|doas|kill|pkill|killall|shutdown|reboot|mkfs[.\w]*|dd|mount|umount|systemctl|crontab)\b/, "Runs a system-level command"],
  [/(^|[\s;&|(])(sendmail|mail|mailx|mutt)\b/, "Sends an email"],
];

const NETWORK_COMMANDS = [
  [/(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp|ping)\b/, "Uses the network"],
  [/\b(pip3?|npm|pnpm|yarn|gem|cargo|go)\s+(install|add|i|get|publish)\b/, "Downloads or publishes packages"],
  [/\b(apt|apt-get|apk|yum|dnf|brew)\s+(install|add|update|upgrade)\b/, "Installs system packages"],
  [/\bgit\s+(clone|fetch|pull)\b/, "Downloads from a git server"],
];

const CHANGING_TOOLS = new Set(["bash", "pwsh", "write", "edit", "str_replace_editor", "run_code", "web_fetch"]);

function globToRegExp(glob) {
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * @param {{ name: string, args: any }} call
 * @param {{ approvals: "risky"|"always"|"never", askForNetwork: boolean, connectors: { name: string, approveTools: string[] }[] }} policy
 * @returns {string | null} the reason to ask, or null to let it run
 */
export function classifyRisk(call, policy) {
  if (policy.approvals === "never") return null;
  const name = call.name;
  const mcp = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(name);
  if (mcp) {
    const conn = policy.connectors.find((c) => c.name === mcp[1]);
    if (policy.approvals === "always") return `Uses the ${mcp[1]} connector (${mcp[2]})`;
    // "*,!get_*": ask before every tool except those matching a !pattern.
    const globs = conn?.approveTools ?? ["*"];
    const never = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    const ask = globs.filter((g) => !g.startsWith("!"));
    const asks = ask.some((g) => globToRegExp(g).test(mcp[2])) && !never.some((g) => globToRegExp(g).test(mcp[2]));
    return asks ? `Uses the ${mcp[1]} connector (${mcp[2]})` : null;
  }
  if (policy.approvals === "always") return CHANGING_TOOLS.has(name) ? "Every action is reviewed in this organization" : null;
  if (name === "bash" || name === "pwsh") {
    const cmd = String(call.args?.command ?? "");
    for (const [re, reason] of RISKY_COMMANDS) if (re.test(cmd)) return reason;
    if (policy.askForNetwork) for (const [re, reason] of NETWORK_COMMANDS) if (re.test(cmd)) return reason;
  }
  return null;
}
