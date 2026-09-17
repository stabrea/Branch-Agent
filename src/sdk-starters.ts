import { z } from "zod";
import { apiRoutes, type ApiRoute } from "./api-openapi.js";

/**
 * Bucket 21 (app-building): the code another program needs to call Branch, in each language the
 * repository has a client for. Worked out from the same route list the OpenAPI description is made
 * of (src/api-openapi.ts), so a snippet can never name a route the app does not describe.
 */
export const sdkLanguages = ["python", "typescript", "go", "react"] as const;
export type SdkLanguage = (typeof sdkLanguages)[number];
export const SdkLanguageSchema = z.enum(sdkLanguages);

/** Where each client lives in the repository, and how a program gets it (none is on a package index). */
export const sdkPackages: Record<SdkLanguage, { folder: string; install: string }> = {
  python: { folder: "packages/sdk-python", install: "pip install ./packages/sdk-python" },
  typescript: { folder: "packages/sdk", install: "npm install ./packages/sdk" },
  go: { folder: "packages/sdk-go", install: "go mod edit -replace github.com/stabrea/Branch-Agent/packages/sdk-go=./packages/sdk-go" },
  react: { folder: "packages/sdk-react", install: "npm install ./packages/sdk ./packages/sdk-react" },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; enum?: Json[]; default?: Json };

/** A stand-in value for one field, of the right type. */
function sample(schema: JsonSchema | undefined): Json {
  if (!schema) return "";
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0]!;
  switch (schema.type) {
    case "number": case "integer": return 1;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "...";
  }
}

/** An example body with only the fields a route insists on, so the snippet is the smallest real call. */
export function exampleBody(route: ApiRoute): Record<string, Json> | undefined {
  if (!route.body) return route.bodyNote ? {} : undefined;
  const schema = z.toJSONSchema(route.body, { io: "input", unrepresentable: "any" }) as JsonSchema;
  return Object.fromEntries((schema.required ?? []).map((name) => [name, sample(schema.properties?.[name])]));
}

/** A path with each {placeholder} replaced by a variable the snippet sets first. */
const pathWith = (path: string, variable: (name: string) => string): string =>
  path.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => variable(name));

const goValue = (value: Json): string => {
  if (value === null) return "nil";
  if (Array.isArray(value)) return `[]any{${value.map(goValue).join(", ")}}`;
  if (typeof value === "object")
    return `branch.Object{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${goValue(item)}`).join(", ")}}`;
  return JSON.stringify(value);
};
/** A Go string expression for a path, with each id variable escaped and joined in. */
const goPath = (path: string): string =>
  `"${pathWith(path, (name) => `" + url.PathEscape(${name}) + "`)}"`.replace(/ \+ ""$/, "");
const pyValue = (value: Json): string => {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pyValue).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyValue(item)}`).join(", ")}}`;
  return JSON.stringify(value);
};

/** One route called from each language, through that language's client. */
export function routeSnippets(route: ApiRoute): Record<SdkLanguage, string> {
  const method = route.method.toUpperCase();
  const body = exampleBody(route);
  const js = body === undefined ? "" : `, ${JSON.stringify(body)}`;
  const tsPath = pathWith(route.path, (name) => `\${encodeURIComponent(${name})}`);
  return {
    python: `branch.request(${JSON.stringify(method)}, f${JSON.stringify(pathWith(route.path, (name) => `{${name.replace(/Id$/, "_id")}}`))}${body === undefined ? "" : `, ${pyValue(body)}`})`,
    typescript: `await branch.request(${JSON.stringify(method)}, \`${tsPath}\`${js});`,
    go: `client.Request(ctx, ${JSON.stringify(method)}, ${goPath(route.path)}, ${body === undefined ? "nil" : goValue(body)})`,
    react: route.method === "get"
      ? `const { data, error, loading } = useBranchGet(\`${tsPath}\`);`
      : `const branch = useBranch();\nawait branch.request(${JSON.stringify(method)}, \`${tsPath}\`${js});`,
  };
}

/** The routes, narrowed by group or by words in the address or the summary. */
export function findRoutes(filter: { tag?: string | undefined; search?: string | undefined }): ApiRoute[] {
  const words = (filter.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return apiRoutes.filter((route) => (!filter.tag || route.tag === filter.tag)
    && words.every((word) => `${route.path} ${route.summary}`.toLowerCase().includes(word)));
}

const starters: Record<SdkLanguage, { file: string; text: string }> = {
  python: { file: "start_task.py", text: `from branch_agent import from_data_dir

branch = from_data_dir("<Branch data folder>")  # reads the session key the app wrote
run = branch.runs.start("Summarise notes/meeting-notes.md in three lines")
for event in branch.runs.stream(run["id"]):
    print(event["kind"])
print(branch.runs.get(run["id"])["run"]["output"])
` },
  typescript: { file: "start-task.mjs", text: `import { readFile } from "node:fs/promises";
import { fromDataDir } from "@branch-agent/sdk";

const branch = await fromDataDir("<Branch data folder>", { readFile });
const run = await branch.runs.start({ prompt: "Summarise notes/meeting-notes.md in three lines" });
for await (const event of branch.runs.stream(run.id)) console.log(event.kind);
console.log((await branch.runs.get(run.id)).run.output);
` },
  go: { file: "main.go", text: `package main

import (
	"context"
	"fmt"
	"log"

	"github.com/stabrea/Branch-Agent/packages/sdk-go/branch"
)

func main() {
	ctx := context.Background()
	client, err := branch.FromDataDir("<Branch data folder>", 0)
	if err != nil {
		log.Fatal(err)
	}
	run, err := client.Runs.Start(ctx, "Summarise notes/meeting-notes.md in three lines", nil)
	if err != nil {
		log.Fatal(err)
	}
	for event, err := range client.Runs.Stream(ctx, run["id"].(string), 0) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(event.Kind)
	}
}
` },
  react: { file: "Task.jsx", text: `import { BranchClient } from "@branch-agent/sdk";
import { BranchProvider, useBranchRun } from "@branch-agent/sdk-react";

const client = new BranchClient({ url: "http://127.0.0.1:3210", token: sessionKey });

function Task() {
  const { start, events, output, status } = useBranchRun();
  return (
    <div>
      <button onClick={() => start("Summarise my meeting notes")}>Start</button>
      <p>{status}: {events.length} steps</p>
      <pre>{output}</pre>
    </div>
  );
}

export const App = () => <BranchProvider client={client}><Task /></BranchProvider>;
` },
};

/** A whole small program that starts a task, watches it, and prints what it did. */
export function starterProgram(language: SdkLanguage): { language: SdkLanguage; file: string; text: string; folder: string; install: string } {
  return { language, ...starters[language], ...sdkPackages[language] };
}
