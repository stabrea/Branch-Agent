import { z } from "zod";
import type { RetrievedPassage } from "./retrieval.js";

/**
 * The retrievers Branch already has — your documents, your saved notes, one hop through the map of
 * a knowledge base, and text pasted in for this job alone — put in an order the owner chooses,
 * each with a ceiling on how much it may bring back, and the pass that puts the best first at the
 * end. That is all a "pipeline" is here: a name, a list of steps, and a number on each step.
 *
 * The point of naming it is that different questions want different orders. Asking about a contract
 * pasted in a minute ago wants the pasted text first and a ceiling of two on everything else;
 * asking what a supplier has ever sent wants the map of a knowledge base first. Without names the
 * owner would have to choose one order for every question they will ever ask.
 *
 * Nothing changes unless the owner makes a pipeline. With none made, a search runs exactly the way
 * it ran before this existed: every retriever asked at once, their answers merged, the best put
 * first. `tests/retrieval-2.test.mjs` asserts that the two give the identical result.
 */
export const rerankStage = "rerank";

export const RetrievalStageSchema = z.object({
  /** A retriever's id, or `rerank` for the pass that puts the best first. */
  retriever: z.string().trim().min(1).max(60),
  /** The most this step may bring back, or for `rerank` the most it may keep. */
  cap: z.number().int().min(1).max(50).default(10),
}).strict();
export const NamedPipelineSchema = z.object({
  name: z.string().trim().min(1).max(60),
  stages: z.array(RetrievalStageSchema).min(1).max(8),
}).strict();
export type NamedPipeline = z.infer<typeof NamedPipelineSchema>;
/**
 * `pipelines` are the orders the owner has written down. `byCollection` says which of them a search
 * aimed at one knowledge base uses, keyed by that knowledge base's name or id; anything not named
 * here uses the way Branch has always worked.
 */
export const RetrievalPipelineSettingsSchema = z.object({
  pipelines: z.array(NamedPipelineSchema).max(8).default([]),
  byCollection: z.record(z.string().min(1).max(120), z.string().min(1).max(60)).default({}),
}).strict();
export type RetrievalPipelineSettings = z.infer<typeof RetrievalPipelineSettingsSchema>;

/** How one step of a run went, so the owner can see where the answers actually came from. */
export interface StageReport { retriever: string; cap: number; found: number; note: string }

/**
 * The stages as they will really run: the rerank forced to the end, and added with `keep` when the
 * owner did not write one, because every pipeline finishes by putting the best first.
 */
export function orderedStages(pipeline: NamedPipeline, keep: number): { retriever: string; cap: number }[] {
  const steps = pipeline.stages.filter((stage) => stage.retriever !== rerankStage);
  const written = pipeline.stages.find((stage) => stage.retriever === rerankStage);
  return [...steps, { retriever: rerankStage, cap: written?.cap ?? keep }];
}

/**
 * Passages gathered so far plus what one step found, kept in the same order the merged search uses:
 * best score first, and the first passage with a given key wins so no passage is counted twice.
 */
export function mergePassages(gathered: RetrievedPassage[], limit: number): RetrievedPassage[] {
  const merged = new Map<string, RetrievedPassage>();
  for (const passage of [...gathered].sort((a, b) => b.score - a.score))
    if (!merged.has(passage.key)) merged.set(passage.key, passage);
  return [...merged.values()].slice(0, limit);
}

/** The pipeline a search should use, by explicit name or by the knowledge base it is aimed at. */
export function pipelineFor(
  settings: RetrievalPipelineSettings, wanted: { pipeline?: string; collection?: string },
): NamedPipeline | null {
  const name = wanted.pipeline
    ?? (wanted.collection ? settings.byCollection[wanted.collection] : undefined);
  if (!name || name === "default") return null;
  return settings.pipelines.find((entry) => entry.name === name) ?? null;
}

/** What to say when a pipeline names a step Branch has no retriever for. */
export const noSuchRetriever = (id: string, known: string[]): string =>
  `Your pipeline asks for "${id}", which is not one of the places Branch can look (${known.join(", ")}). `
  + "That step was skipped and the rest of the pipeline ran.";
