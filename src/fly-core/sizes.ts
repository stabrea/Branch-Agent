/**
 * The sizes and rates of Branch's learning core, and where each number comes from.
 *
 * The core is modelled on the fruit fly's mushroom body, the part of the fly brain where
 * associative learning is known to happen. Every size below is either taken from a published
 * anatomy paper (cited next to it) or marked plainly as a choice made for Branch. No code, weights
 * or data from any connectome model are used; only the published proportions.
 *
 * Sources:
 * - Li F, et al. (2020) "The connectome of the adult Drosophila mushroom body provides insights into
 *   function." eLife 9:e62576. https://elifesciences.org/articles/62576 — about 2,000 Kenyon cells
 *   in the hemibrain, 21 typical output-neuron (MBON) types plus 14 "atypical" ones.
 * - Schlegel P, et al. (2024) "Whole-brain annotation and multi-connectome cell typing of
 *   Drosophila." Nature. https://www.nature.com/articles/s41586-024-07686-5 — FlyWire counts
 *   2,597 Kenyon cells in the right hemisphere and 2,580 in the left.
 * - Caron SJC, Ruta V, Abbott LF, Axel R (2013) "Random convergence of olfactory inputs in the
 *   Drosophila mushroom body." Nature 497:113–117. https://www.nature.com/articles/nature12063 —
 *   each Kenyon cell has 2 to 11 dendritic claws, each taking input from an apparently random
 *   projection neuron.
 * - Lin AC, Bygrave AM, de Calignon A, Lee T, Miesenböck G (2014) "Sparse, decorrelated odor coding
 *   in the mushroom body enhances learned odor discrimination." Nat Neurosci 17:559–568.
 *   https://www.nature.com/articles/nn.3660 — feedback inhibition from the APL neuron keeps only a
 *   small fraction (on the order of 5%) of Kenyon cells active for any one odour.
 * - Hige T, Aso Y, Modi MN, Rubin GM, Turner GC (2015) "Heterosynaptic plasticity underlies aversive
 *   olfactory learning in Drosophila." Neuron 88:985–998 — Kenyon-cell activity paired with dopamine
 *   causes long-term depression of the Kenyon-cell → output-neuron synapse.
 * - Owald D, Felsenberg J, Talbot CB, Das G, Perisse E, Huetteroth W, Waddell S (2015) "Activity of
 *   defined mushroom body output neurons underlies learned olfactory behavior in Drosophila." Neuron
 *   86(2):417–427. https://doi.org/10.1016/j.neuron.2015.03.025 — reward training lowers the
 *   conditioned odour's drive to the M4/6 output neurons, whose activity steers the fly away, and
 *   punishment training raises it: reward depresses the "avoid" pathway.
 * - Aso Y, Rubin GM (2016) "Dopaminergic neurons write and update memories with cell-type-specific
 *   rules." eLife 5:e16135 — compartments learn and forget at different rates.
 */

/**
 * Kenyon cells. The hemibrain's ~2,000 (Li et al. 2020). Checked against Schlegel et al. 2024 on
 * 2026-09-17: FlyWire counts 2,597 (right) and 2,580 (left), about 30% more per side than the
 * hemibrain. Branch keeps 2,000 on purpose: the wiring is derived from this number and the owner's
 * seed, so changing it would make every weight already learned unreadable. Both counts are the same
 * order of magnitude, which is all the sparse code depends on.
 */
export const kenyonCells = 2000;
/** Share of Kenyon cells left active after feedback inhibition (Lin et al. 2014: sparse, ~5%). */
export const activeShare = 0.05;
export const activeCells = Math.round(kenyonCells * activeShare);
/** Claws per Kenyon cell: Caron et al. (2013) report 2 to 11; Branch uses a mid value. */
export const clawsPerCell = 7;
/**
 * Input channels ("projection neurons"). The fly has roughly fifty olfactory glomeruli; Branch's
 * context is larger than a smell, so this is a Branch choice, not an anatomical number.
 */
export const inputChannels = 256;
/** How many input channels one context feature drives (Branch choice). */
export const channelsPerFeature = 8;

/**
 * Most learned synapses kept per output neuron (per side of an action). A Branch choice, not anatomy:
 * the weakest changes are dropped first, so storage stays bounded however many situations an action
 * is used in. It is above `activeCells`, so one whole situation always fits. At `maximumActions`
 * (state.ts) the tables hold at most 5,000 × 2 × 120 entries × 8 base64 characters, about 9.6 MB of
 * weights, and the in-memory index at most 5,000 × 240 × 6 bytes, about 7.2 MB.
 */
export const maximumWeightsPerSide = 120;
/** A synapse starts at full strength; learning moves it between 0 and this. */
export const baselineWeight = 1;
/**
 * Learning rates. Depression is the documented effect of dopamine on active synapses (Hige et al.
 * 2015 for punishment, Owald et al. 2015 for reward depressing the avoid pathway); recovery of the opposite pathway is kept slower. Different rates per pathway follow the
 * idea of compartment-specific rules (Aso & Rubin 2016). The values themselves are Branch choices.
 */
export const depressionRate = 0.35;
export const recoveryRate = 0.15;
/** Forgetting: learned changes relax back to baseline with this half-life (Branch choice). */
export const forgetHalfLifeDays = 45;
/** How much credit an action gets per step it came before the outcome (eligibility trace). */
export const traceDecayPerStep = 0.9;
export const traceFloor = 0.3;
/** A correction in the next task reaches back to the previous one with this time constant. */
export const correctionTraceMinutes = 60;
