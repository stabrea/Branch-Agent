/**
 * The examples family (an MCP example, a Notion MCP example): ready-to-copy entries for the "mcp"
 * list of the integrations file, each one a real entry that `McpConfigSchema` accepts (the test
 * checks). They are shown on the Connections card with a Copy button. Nothing here connects to
 * anything: the owner copies an entry, puts the token in the environment variable it names, and
 * tries the server from Settings first, which also shows the version the server really reports.
 *
 * A server's tools are an allowlist: only the names listed are ever offered to the assistant, and
 * the version pins the server so an update is reviewed before it is used.
 */
export interface McpExample {
  id: string;
  title: string;
  /** One or two sentences for the owner: what it gives the assistant, and what to set first. */
  about: string;
  entry: Record<string, unknown>;
}

export const mcpExamples: readonly McpExample[] = [
  {
    id: "notion",
    title: "Notion (Notion's own MCP server)",
    about: "Lets the assistant search your Notion, read pages and add new ones. Make an internal integration in Notion, share the pages it may use with it, and put its token in NOTION_TOKEN before starting Branch.",
    entry: {
      id: "notion", transport: "stdio", command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server@2.0.0"],
      envKeys: ["NOTION_TOKEN"],
      expectedVersion: "2.0.0",
      tools: ["API-post-search", "API-retrieve-a-page", "API-get-block-children", "API-post-database-query", "API-post-page", "API-patch-block-children"],
    },
  },
  {
    id: "notion-hosted",
    title: "Notion (hosted, over the web)",
    about: "The same, reached at Notion's own address instead of a program on this computer. Put a Notion access token in NOTION_MCP_TOKEN.",
    entry: {
      id: "notion-hosted", transport: "http", url: "https://mcp.notion.com/mcp",
      bearerEnv: "NOTION_MCP_TOKEN", expectedVersion: "1.0.0",
      tools: ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"],
    },
  },
  {
    id: "fetch",
    title: "Reading web pages (the reference fetch server)",
    about: "The smallest useful MCP server: one tool that reads a web page. Needs Python's uvx on this computer and nothing else.",
    entry: {
      id: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch==2025.4.7"],
      expectedVersion: "1.9.4", tools: ["fetch"],
    },
  },
];

/** The integrations file as a whole, with one example in it, for the Copy button. */
export function exampleFile(id: string): string {
  const example = mcpExamples.find((e) => e.id === id);
  if (!example) throw new Error("There is no example with that name");
  return `${JSON.stringify({ mcp: [example.entry] }, null, 2)}\n`;
}
