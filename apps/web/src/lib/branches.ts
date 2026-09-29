/**
 * Chats are trees: editing a message or regenerating an answer adds a sibling.
 * The chat remembers which branch is shown by its last message (the "leaf").
 */
export interface TreeNode {
  id: string;
  parentId: string | null;
}

/** Messages from the first one down to `leafId`. */
export function pathTo<T extends TreeNode>(nodes: T[], leafId: string | null): T[] {
  if (!leafId) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: T[] = [];
  let cur = byId.get(leafId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out.reverse();
}

/** Messages that share this one's parent, oldest first (order of the array is creation order). */
export function siblingsOf<T extends TreeNode>(nodes: T[], node: T): T[] {
  return nodes.filter((n) => n.parentId === node.parentId);
}

/** The newest end of the branch that starts at `id`: follow the latest child each step. */
export function latestLeaf<T extends TreeNode>(nodes: T[], id: string): string {
  let cur = id;
  for (let guard = 0; guard < 10_000; guard++) {
    const kids = nodes.filter((n) => n.parentId === cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1]!.id;
  }
  return cur;
}
