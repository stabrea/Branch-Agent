import type { ActivityChain } from "./activity-chain.js";

/**
 * mac7/r17-g (R17-066): `branch activity verify [--tip <hash>] [--json]`. Prints whether the
 * tamper-evident chain is unbroken and answers with the exit code: 0 unbroken, 1 broken, 2 misused.
 */
export function activityCommand(chain: ActivityChain, owner: string, args: readonly string[], print: (text: string) => void = console.log): number {
  if (args[0] !== "verify") {
    print("Use: branch activity verify [--tip <hash>] [--json]");
    return 2;
  }
  const at = args.indexOf("--tip");
  const tip = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !/^[a-f0-9]{64}$/i.test(tip ?? "")) {
    print("Give --tip the 64-character hash you wrote down earlier.");
    return 2;
  }
  const check = chain.verify(owner, tip);
  if (args.includes("--json")) print(JSON.stringify(check));
  else if (check.ok) print(`The activity record is unbroken: ${check.entries} entries. Latest hash: ${check.tip}`);
  else print(`The activity record is broken${check.brokenAt !== null ? ` at entry ${check.brokenAt}` : ""}: ${check.reason}.`);
  return check.ok ? 0 : 1;
}
