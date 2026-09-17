import { execFile } from "node:child_process";
import { blankNoise, noiseStyleOf } from "./code-tags.js";
import type { Validation, ValidationProblem } from "./code-edit.js";

/**
 * Syntax checks that need nothing installed (A0537, the "syntax validation" half).
 *
 * - TypeScript: Node's own type stripper reads the file. It refuses a file that does not parse, so a
 *   missing brace or a broken generic is caught without the TypeScript compiler. It runs in a child
 *   Node so its "experimental" notice never reaches the app's log. A few TypeScript-only forms
 *   (enums, namespaces, parameter properties) are outside what it reads; those files get the
 *   bracket check below and say so.
 * - Every other language the project map reads: brackets, braces and parentheses must pair up once
 *   comments and strings are set aside. That catches the commonest broken edit — a half-applied
 *   change that leaves a block open — and names the line.
 */
const stripScript = [
  "import { stripTypeScriptTypes } from 'node:module';",
  "let text = ''; process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { text += c; });",
  "process.stdin.on('end', () => { try { stripTypeScriptTypes(text, { mode: 'strip' }); process.stdout.write('ok'); }",
  "catch (e) { process.stdout.write(JSON.stringify({ code: e.code ?? '', message: String(e.message ?? e) })); } });",
].join("\n");

type Runner = (input: string) => Promise<string>;
const nodeRunner: Runner = (input) => new Promise((resolve) => {
  const child = execFile(process.execPath, ["--no-warnings", "--input-type=module", "-e", stripScript],
    { timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    (error, stdout) => resolve(error && !stdout ? JSON.stringify({ code: "RUN", message: error.message }) : String(stdout)));
  child.stdin?.end(input);
});

export async function typeScriptValidation(path: string, text: string, run: Runner = nodeRunner): Promise<Validation> {
  const answer = (await run(text)).trim();
  if (answer === "ok") return { path, language: "TypeScript", checked: true, ok: true, problems: [] };
  let parsed: { code?: string; message?: string } = {};
  try { parsed = JSON.parse(answer) as typeof parsed; } catch { parsed = { code: "RUN", message: answer }; }
  if (parsed.code === "ERR_INVALID_TYPESCRIPT_SYNTAX") {
    const brackets = bracketProblems(path, text);
    const line = brackets[0]?.line;
    return { path, language: "TypeScript", checked: true, ok: false,
      problems: [{ message: `SyntaxError: ${String(parsed.message).split("\n")[0]!.slice(0, 400)}`, ...(line ? { line } : {}) }] };
  }
  const fallback = bracketValidation(path, text, "TypeScript");
  const why = parsed.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"
    ? "This file uses a TypeScript form Node's reader does not cover"
    : "Node's TypeScript reader was not available";
  return { ...fallback, note: `${why}, so only brackets were checked; a full check needs the TypeScript compiler, which this app does not carry at run time.` };
}

/** The bracket check as a whole answer, for a language with no other built-in check. */
export function bracketValidation(path: string, text: string, language: string): Validation {
  const problems = bracketProblems(path, text);
  return { path, language, checked: true, ok: problems.length === 0, problems,
    note: "Only brackets, braces and parentheses were checked; the language's own tools can say more." };
}
export const canCheckBrackets = (path: string): boolean => noiseStyleOf(path) !== undefined;

const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
/** Every bracket that does not pair up, first one first (at most five). */
export function bracketProblems(path: string, text: string): ValidationProblem[] {
  const style = noiseStyleOf(path);
  if (!style) return [];
  const clean = blankNoise(text, style.family, style.lifetimes);
  const open: { char: string; line: number }[] = [];
  const problems: ValidationProblem[] = [];
  let line = 1;
  for (const char of clean) {
    if (char === "\n") line++;
    else if (char === "(" || char === "[" || char === "{") open.push({ char, line });
    else if (char in pairs) {
      const top = open[open.length - 1];
      if (top?.char === pairs[char]) open.pop();
      else problems.push({ message: top ? `"${char}" on line ${line} does not close the "${top.char}" opened on line ${top.line}` : `"${char}" on line ${line} closes nothing`, line });
      if (problems.length >= 5) return problems;
    }
  }
  for (const left of open.slice(0, 5 - problems.length))
    problems.push({ message: `"${left.char}" opened on line ${left.line} is never closed`, line: left.line });
  return problems;
}
