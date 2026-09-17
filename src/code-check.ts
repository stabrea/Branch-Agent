import { z } from "zod";

/**
 * A quick read of a script before anything is started. It is not a security boundary and does not
 * pretend to be one — a determined script can spell anything it likes. It is the cheap check that
 * catches the ordinary mistake: a script that was asked for a sum and instead deletes a folder,
 * reaches the internet, or starts another program.
 *
 * It runs before the sandbox backend is even prepared, so a refusal costs nothing.
 */
export const codeCheckLanguages = ["javascript", "python"] as const;
export type CodeCheckLanguage = (typeof codeCheckLanguages)[number];

/** The most a script may weigh. Anything longer is a program, and belongs in a file. */
export const maxScriptBytes = 16384;

interface Forbidden { pattern: RegExp; what: string }

/** Things a small script has no business doing, per language, each with the sentence it refuses in. */
const forbidden: Record<CodeCheckLanguage, Forbidden[]> = {
  javascript: [
    { pattern: /\bchild_process\b|\bspawnSync\b|\bexecSync\b/, what: "start another program" },
    { pattern: /\bprocess\s*\.\s*(binding|dlopen)\b/, what: "reach into Node itself" },
    { pattern: /\bnode:v8\b|\bvm\s*\.\s*runIn/, what: "run code it built at the last moment" },
    { pattern: /\brmSync\b|\brm\s*\(\s*[^)]*recursive/, what: "delete a folder and everything in it" },
  ],
  python: [
    { pattern: /\b(subprocess|multiprocessing)\b|\bos\s*\.\s*(system|popen|exec|spawn)/, what: "start another program" },
    { pattern: /\bshutil\s*\.\s*rmtree\b/, what: "delete a folder and everything in it" },
    { pattern: /\b(eval|exec|compile)\s*\(/, what: "run code it built at the last moment" },
    { pattern: /\bctypes\b|\b__import__\s*\(/, what: "load something outside Python" },
    // Reading the settings a script was handed is not on this list: the sandbox already decides
    // what those are, and the proxy address a "no internet" rule sets is read exactly this way.
  ],
};

/** Ways of reaching the internet. Allowed only when the owner's rule says the script may. */
const networkReach: Record<CodeCheckLanguage, RegExp[]> = {
  javascript: [/\bnode:(https?|net|tls|dgram|dns)\b/, /\brequire\s*\(\s*["'](https?|net|tls|dgram|dns)["']/, /\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bXMLHttpRequest\b/],
  python: [/^\s*(import|from)\s+(requests|urllib|http|socket|httpx|aiohttp|ftplib|smtplib)\b/m, /\bsocket\s*\.\s*socket\s*\(/],
};

export interface CodeCheckOptions {
  language: CodeCheckLanguage;
  /** Whether the owner's rule lets this script reach the internet. */
  network: boolean;
  maxBytes?: number;
}
export interface CodeCheckVerdict {
  ok: boolean;
  /** The one sentence the person is shown when it is refused. */
  reason: string;
  /** What was found, for the record: "start another program", "reach the internet". */
  found: string[];
}

/**
 * Reads the script and says whether it may be started. Comment lines and blank lines are read like
 * any other, deliberately: a forbidden call hidden in a comment is still worth a question, and
 * pretending otherwise would invite exactly that trick.
 */
export function checkCodeBlock(source: string, options: CodeCheckOptions): CodeCheckVerdict {
  const limit = options.maxBytes ?? maxScriptBytes;
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > limit)
    return { ok: false, found: ["too long"],
      reason: `That script is ${Math.round(bytes / 1024)} KB, and Branch runs scripts up to ${Math.round(limit / 1024)} KB. Put it in a file and run that instead.` };
  const found: string[] = [];
  for (const rule of forbidden[options.language]) if (rule.pattern.test(source)) found.push(rule.what);
  if (!options.network && networkReach[options.language].some((pattern) => pattern.test(source)))
    found.push("reach the internet");
  if (!found.length) return { ok: true, reason: "", found: [] };
  const list = [...new Set(found)];
  return { ok: false, found: list,
    reason: `That script would ${list.join(", and ")}, which is not what running a small script is for. Ask the person to change your settings if that is really what you need.` };
}

export const CodeCheckInputSchema = z.object({
  language: z.enum(codeCheckLanguages),
  source: z.string().min(1).max(maxScriptBytes),
}).strict();
