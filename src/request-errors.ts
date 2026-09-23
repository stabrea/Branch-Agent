import { z } from "zod";
import { errorText } from "./contracts.js";

const sentence = (message: string): string => {
  const plain = message.replace(/^Invalid input:\s*/i, "").replace(/[\s.]+$/g, "").replace(/\s+/g, " ");
  return `${plain}.`;
};

const fieldName = (path: PropertyKey[]): string => path.reduce<string>((name, part) =>
  typeof part === "number" ? `${name}[${part}]` : name ? `${name}.${String(part)}` : String(part), "");

export const isRequestShapeError = (error: unknown): error is z.ZodError => error instanceof z.ZodError;

/** One owner-readable sentence for a malformed request; never Zod's JSON issue dump. */
export function requestErrorText(error: unknown): string {
  if (!isRequestShapeError(error)) return errorText(error);
  const issue = error.issues[0];
  if (!issue) return "The request is not in the expected shape.";
  if (issue.code === "unrecognized_keys") {
    const field = issue.keys[0] ?? "unknown";
    return `"${field}" is not an accepted field.`;
  }
  const field = fieldName(issue.path);
  return field
    ? `"${field}" is not valid: ${sentence(issue.message)}`
    : `The request is not valid: ${sentence(issue.message)}`;
}
