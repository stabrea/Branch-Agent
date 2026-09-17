import type { Completion, Provider } from "../contracts.js";

/**
 * What a saved connection becomes when its service has ended the route Branch used. It is kept on
 * the list so the owner sees a plain note instead of the connection quietly disappearing, and every
 * use answers with that note rather than a network error.
 */
export class RetiredProvider implements Provider {
  readonly name: string;
  readonly retired = true;
  constructor(readonly catalogId: string, readonly note: string) {
    this.name = `retired:${catalogId}`;
  }
  async complete(): Promise<Completion> {
    throw Object.assign(new Error(this.note), { retired: true });
  }
  audio(): null { return null; }
  modelsList(): null { return null; }
}
