/**
 * w911 (A1452): reading a site's robots.txt the way RFC 9309 describes it.
 *
 * - Consecutive `User-agent` lines share one group. The groups naming Branch's own agent are used
 *   (all of them, merged); only when none does are the `*` groups used.
 * - The longest matching `Allow`/`Disallow` pattern wins; on a tie, `Allow` wins.
 * - `*` matches any run of characters and a final `$` pins the end of the path.
 * - An empty `Disallow:` is no rule at all. No robots.txt means everything is allowed.
 */
interface Rule { allow: boolean; length: number; pattern: RegExp }
interface Group { agents: string[]; rules: Rule[] }

function compile(value: string): RegExp {
  const anchored = value.endsWith("$");
  const body = (anchored ? value.slice(0, -1) : value)
    .split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((key === "allow" || key === "disallow") && current && value)
      current.rules.push({ allow: key === "allow", length: value.length, pattern: compile(value) });
  }
  return groups;
}

const productToken = (agent: string): string => agent.split("/")[0]!.trim().toLowerCase();

/** A question "may this path be read?" for one agent, from the text of a robots.txt. */
export function robotsRules(text: string, agent: string): (pathAndQuery: string) => boolean {
  const groups = parseGroups(text), token = productToken(agent);
  const named = groups.filter((group) => group.agents.some((name) => name !== "*" && productToken(name) === token));
  const chosen = named.length ? named : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  return (path) => {
    if (path === "/robots.txt") return true;
    let best: Rule | null = null;
    for (const rule of rules) {
      if (!rule.pattern.test(path)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
    }
    return best ? best.allow : true;
  };
}

/** Nothing may be read: what a site whose robots.txt fails with a server error is taken to say. */
export const nothingAllowed = (): boolean => false;
export const everythingAllowed = (): boolean => true;
