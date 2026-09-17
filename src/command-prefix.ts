/**
 * "Always allow" for one kind of command, not for a whole program (wave mac3, tool-safety).
 *
 * Saying yes for good to `git status` should not also say yes to `git push`, and `npm run dev`
 * should stay separate from `npm install`. How many words name a program's action differs from
 * program to program, so the table below says it: `git` takes two (`git status`), `npm run` takes
 * three (`npm run dev`), `ls` takes one. The table is OpenCode's
 * `packages/opencode/src/permission/arity.ts` (MIT; see THIRD_PARTY_NOTICES.md).
 *
 * Two rules keep this from ever widening what a remembered yes covers:
 *  - A command that is not a plain list of words — anything with `;`, `&`, `|`, `<`, `>`, `$`, a
 *    backtick, a bracket or a line break — is never narrowed to a prefix, and a standing yes only
 *    covers it word for word. `git status && rm -rf ~` is not `git status`.
 *  - A program the table does not know, a flag or quote where the action's words should be, and a
 *    one-word action that can change things (`rm`, `mv`, `chmod`) are remembered word for word, as
 *    every remembered command was before this.
 */
import { globMatches } from "./policy-resources.js";

const ARITY: Record<string, number> = {
  cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1, grep: 1, kill: 1, killall: 1,
  ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1,
  touch: 1, unset: 1, which: 1,
  aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3, cargo: 2, "cargo add": 3,
  "cargo run": 3, cdk: 2, cf: 2, cmake: 2, composer: 2, consul: 2, "consul kv": 3, crictl: 2, deno: 2,
  "deno task": 3, doctl: 3, docker: 2, "docker builder": 3, "docker compose": 3, "docker container": 3,
  "docker image": 3, "docker network": 3, "docker volume": 3, eksctl: 2, "eksctl create": 3,
  firebase: 2, flyctl: 2, gcloud: 3, gh: 3, git: 2, "git config": 3, "git remote": 3, "git stash": 3,
  go: 2, gradle: 2, helm: 2, heroku: 2, hugo: 2, ip: 2, "ip addr": 3, "ip link": 3, "ip netns": 3,
  "ip route": 3, kind: 2, "kind create": 3, kubectl: 2, "kubectl kustomize": 3, "kubectl rollout": 3,
  kustomize: 2, make: 2, mc: 2, "mc admin": 3, minikube: 2, mongosh: 2, mysql: 2, mvn: 2, ng: 2,
  npm: 2, "npm exec": 3, "npm init": 3, "npm run": 3, "npm view": 3, nvm: 2, nx: 2, openssl: 2,
  "openssl req": 3, "openssl x509": 3, pip: 2, pipenv: 2, pnpm: 2, "pnpm dlx": 3, "pnpm exec": 3,
  "pnpm run": 3, poetry: 2, podman: 2, "podman container": 3, "podman image": 3, psql: 2, pulumi: 2,
  "pulumi stack": 3, pyenv: 2, python: 2, rake: 2, rbenv: 2, "redis-cli": 2, rustup: 2,
  serverless: 2, sfdx: 3, skaffold: 2, sls: 2, sst: 2, swift: 2, systemctl: 2, terraform: 2,
  "terraform workspace": 3, tmux: 2, turbo: 2, ufw: 2, vault: 2, "vault auth": 3, "vault kv": 3,
  vercel: 2, volta: 2, wp: 2, yarn: 2, "yarn dlx": 3, "yarn run": 3,
};

/**
 * One-word actions that only look at things, so a standing yes to one of them may cover every use.
 * `env`, `source`, `export` and the rest of the one-word list can run or change something, so they
 * are remembered word for word.
 */
const lookOnly = new Set(["cat", "cd", "echo", "grep", "ls", "ps", "pwd", "sleep", "tail", "which"]);

/**
 * Shell syntax that joins, redirects or substitutes commands. A backslash is left out on purpose:
 * it is how a Windows program's folder is written, and a Windows command must read as it always has.
 */
const shellSyntax = /[;&|<>`$()\r\n]/;

/** The program's own name without its folder: `/usr/bin/git` is `git`. */
const programName = (word: string): string => word.replace(/^.*[\\/]/, "");

/** The command's words, or null when it is not a plain list of words. */
export function plainWords(command: string): string[] | null {
  if (shellSyntax.test(command)) return null;
  const words = command.trim().split(/\s+/).filter(Boolean);
  return words.length ? [programName(words[0]!), ...words.slice(1)] : null;
}

/** A command as rules compare it: the program's name without its folder, single spaces between words. */
export function tidyCommand(command: string): string {
  const words = plainWords(command);
  if (words) return words.join(" ");
  const trimmed = command.trim();
  const first = /^\S+/.exec(trimmed)?.[0] ?? "";
  return programName(first) + trimmed.slice(first.length);
}

/** OpenCode's lookup: the longest known prefix decides how many words name the action. */
function arityPrefix(words: string[]): string[] | null {
  for (let length = Math.min(words.length, 3); length > 0; length--) {
    const arity = ARITY[words.slice(0, length).join(" ").toLowerCase()];
    if (arity !== undefined) return words.slice(0, arity);
  }
  return null;
}

/**
 * The words a standing answer to this command should cover — `git status` for
 * `git status --short` — or null when it can only be remembered word for word.
 */
export function commandPrefix(command: string): string | null {
  const words = plainWords(command);
  if (!words) return null;
  const prefix = arityPrefix(words);
  if (!prefix) return null;
  if (prefix.some((word) => /^-|["'*?=]/.test(word))) return null;
  if (prefix.length === 1 && !lookOnly.has(prefix[0]!.toLowerCase())) return null;
  return prefix.join(" ");
}

/** The pieces of a joined command (`a && b; c | d`), each tidied, for rules that can only tighten. */
function pieces(command: string): string[] {
  return command.split(/&&|\|\||[;&|\r\n]|\$\(|`/).map((piece) => tidyCommand(piece.replace(/[()]/g, " "))).filter(Boolean);
}

/** Whether a rule's command words cover a plain command: `git` covers `git push`, `git status` does not. */
const wordsCover = (pattern: string, command: string): boolean =>
  globMatches(pattern, command) || globMatches(pattern + " *", command);

/**
 * Whether a rule about a command covers this one. A plain command is covered by a rule naming its
 * first words. A joined or redirected command is covered by an "allow" only word for word, and by
 * an "ask" or "deny" when any piece of it is, so joining commands can make a rule stricter but
 * never looser.
 */
export function commandCovers(pattern: string, command: string, decision: "allow" | "ask" | "deny"): boolean {
  const tidy = tidyCommand(command);
  if (plainWords(command)) return wordsCover(pattern, tidy);
  if (decision === "allow") return !pattern.includes("*") && pattern.trim().toLowerCase() === tidy.toLowerCase();
  return globMatches(pattern, tidy) || pieces(command).some((piece) => wordsCover(pattern, piece));
}
