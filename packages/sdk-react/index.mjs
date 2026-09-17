// The hooks, built on the React the page already imports. A page that has React under another
// name, or several copies, calls createBranchHooks itself with the one it renders with.
import * as React from "react";
import { createBranchHooks } from "./hooks.mjs";

export { createBranchHooks, createRunStore } from "./hooks.mjs";
export const { BranchContext, BranchProvider, useBranch, useBranchGet, useBranchRun } = createBranchHooks(React);
