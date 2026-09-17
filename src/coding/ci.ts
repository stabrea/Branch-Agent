import { z } from "zod";

/**
 * R17-038: Branch in CI. The GitHub Action (`extras/ci/github/action.yml`) and the GitLab CI/CD
 * component (`extras/ci/gitlab/branch.yml`) run `branch headless` on the checked-out project. This
 * file writes the few lines the owner pastes into their own workflow, filled in from the card, so
 * nobody has to learn either format. The model key is never in the snippet: only the name of the
 * secret variable that holds it. (Claude Code documents the same two integrations; Codex's
 * `docs/exec.md`, Apache-2.0, is the non-interactive model. The files are written for Branch.)
 */
export const CiSnippetSchema = z.object({
  kind: z.enum(["github", "gitlab"]),
  provider: z.enum(["openai", "anthropic"]).default("anthropic"),
  model: z.string().trim().min(1).max(200).regex(/^[\w.:/@-]+$/, "A model name uses letters, digits and . : / @ -"),
  endpoint: z.string().url().max(500),
  keyVariable: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/, "The key's variable name uses capitals, digits and _"),
  prompt: z.string().trim().min(1).max(2000).default("Review the changes in this pull request and list anything risky."),
  preset: z.enum(["read-only", "ask-before-changes", "workspace"]).default("read-only"),
}).strict();

/** A YAML double-quoted scalar: nothing in the text can end the string or start a new key. */
const quoted = (text: string): string => JSON.stringify(text);

export function ciSnippet(input: unknown): { file: string; text: string } {
  const value = CiSnippetSchema.parse(input);
  if (value.kind === "github") {
    return { file: ".github/workflows/branch.yml", text: [
      "name: Branch", "on: [pull_request]", "jobs:", "  branch:", "    runs-on: ubuntu-latest",
      "    permissions:", "      contents: read", "    steps:", "      - uses: actions/checkout@v4",
      "      - uses: stabrea/Branch-Agent/extras/ci/github@main", "        with:",
      `          prompt: ${quoted(value.prompt)}`, `          preset: ${value.preset}`,
      `          provider: ${value.provider}`, `          model: ${quoted(value.model)}`, `          endpoint: ${quoted(value.endpoint)}`,
      `          api-key-variable: ${value.keyVariable}`, "        env:",
      `          ${value.keyVariable}: \${{ secrets.${value.keyVariable} }}`, "",
    ].join("\n") };
  }
  return { file: ".gitlab-ci.yml", text: [
    "include:", "  - component: $CI_SERVER_FQDN/<your group>/branch-agent/branch@main", "    inputs:",
    `      prompt: ${quoted(value.prompt)}`, `      preset: ${value.preset}`, `      provider: ${value.provider}`,
    `      model: ${quoted(value.model)}`, `      endpoint: ${quoted(value.endpoint)}`,
    `      api-key-variable: ${value.keyVariable}   # a masked CI/CD variable`, "",
  ].join("\n") };
}
