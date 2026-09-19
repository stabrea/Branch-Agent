/**
 * mac7/learn: grouping a graph before anything is spent on a model.
 *
 * This is the first of the three ideas taken from Understand Anything (MIT; see
 * THIRD_PARTY_NOTICES.md): cluster the graph first, so a model is asked few, well-shaped questions
 * instead of one question per file. Their version runs Louvain community detection through two npm
 * packages; Branch's rule is that a new dependency has to be justified, and two packages for one
 * modularity pass over a graph already held in memory is not, so the pass is written here.
 *
 * It is label propagation with every tie broken the same way twice: nodes are walked in a fixed
 * order and a tie goes to the label that sorts first, so the same graph always gives the same
 * groups. That matters more than squeezing out the last of the modularity — a map that regroups
 * itself between two looks is a map nobody trusts.
 *
 * No model is called from this file, and none can be: it takes plain nodes and weighted edges and
 * knows nothing about where they came from.
 */

export interface ClusterNode { id: string; weight: number }
export interface ClusterEdge { from: string; to: string; weight: number }
export interface Cluster { id: string; members: string[] }

/** The sizes the groups are shaped to, in the owner's terms: eight to twelve groups a person can hold. */
export const groupLimits = { maxGroups: 12, maxMembers: 60, minMembers: 2, rounds: 20 } as const;

/** Who each node is joined to, and how strongly. Self-links are dropped; both directions count. */
function neighbours(nodes: readonly ClusterNode[], edges: readonly ClusterEdge[]): Map<string, Map<string, number>> {
  const known = new Set(nodes.map((node) => node.id));
  const out = new Map<string, Map<string, number>>();
  for (const node of nodes) out.set(node.id, new Map());
  for (const edge of edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    const weight = Number.isFinite(edge.weight) && edge.weight > 0 ? edge.weight : 0;
    if (!weight) continue;
    out.get(edge.from)!.set(edge.to, (out.get(edge.from)!.get(edge.to) ?? 0) + weight);
    out.get(edge.to)!.set(edge.from, (out.get(edge.to)!.get(edge.from) ?? 0) + weight);
  }
  return out;
}

/**
 * The groups, largest first. Everything is deterministic: the walk order is the node order given,
 * a tie goes to the label that sorts first, and the passes stop as soon as nothing moves.
 */
export function cluster(nodes: readonly ClusterNode[], edges: readonly ClusterEdge[]): Cluster[] {
  if (!nodes.length) return [];
  const near = neighbours(nodes, edges);
  const order = nodes.map((node) => node.id);
  const label = new Map(order.map((id) => [id, id]));
  for (let round = 0; round < groupLimits.rounds; round += 1) {
    let moved = false;
    for (const id of order) {
      const scores = new Map<string, number>();
      for (const [other, weight] of near.get(id) ?? [])
        scores.set(label.get(other)!, (scores.get(label.get(other)!) ?? 0) + weight);
      if (!scores.size) continue;
      let best = label.get(id)!, bestScore = scores.get(best) ?? 0;
      for (const [candidate, score] of [...scores].sort((a, b) => a[0].localeCompare(b[0])))
        if (score > bestScore) { best = candidate; bestScore = score; }
      if (best !== label.get(id)) { label.set(id, best); moved = true; }
    }
    if (!moved) break;
  }
  const byLabel = new Map<string, string[]>();
  for (const id of order) byLabel.set(label.get(id)!, [...(byLabel.get(label.get(id)!) ?? []), id]);
  const heaviest = new Map(nodes.map((node) => [node.id, node.weight]));
  const rank = (members: string[]): number => members.reduce((sum, id) => sum + (heaviest.get(id) ?? 0), 0);
  const groups = [...byLabel.entries()]
    .map(([id, members]) => ({ id, members: members.slice(0, groupLimits.maxMembers) }))
    .sort((a, b) => rank(b.members) - rank(a.members) || b.members.length - a.members.length || a.id.localeCompare(b.id));
  return fold(groups, rank);
}

/**
 * Groups too small to be worth a heading, and groups past the twelfth, folded into one. Label
 * propagation on a graph with few links leaves a long tail of single nodes; a map with sixty
 * headings of one thing each is the hairball the picture exists to avoid.
 */
function fold(groups: Cluster[], rank: (members: string[]) => number): Cluster[] {
  const kept: Cluster[] = [], rest: string[] = [];
  for (const group of groups) {
    if (kept.length < groupLimits.maxGroups && group.members.length >= groupLimits.minMembers) kept.push(group);
    else rest.push(...group.members);
  }
  if (!rest.length) return kept;
  if (!kept.length) return [{ id: rest[0]!, members: rest.slice(0, groupLimits.maxMembers) }];
  kept.push({ id: rest[0]!, members: rest.slice(0, groupLimits.maxMembers) });
  return kept.sort((a, b) => rank(b.members) - rank(a.members) || a.id.localeCompare(b.id));
}
