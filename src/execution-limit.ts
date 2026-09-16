/**
 * One count of how much work is going on at once, shared by everything that starts a task: the web
 * routes the app's own screen uses, and the waiting line. Before this was shared, the waiting line
 * kept its own count, so the two together could have twice as much running as this computer is
 * meant to handle. How many the waiting line itself starts is still its own setting; this is the
 * ceiling neither of them may go past.
 */
export const maximumActiveExecutions = 8;

export class ExecutionLimit {
  private active = 0;
  /** Everyone asleep waiting for a place, woken the moment one comes back. */
  private readonly waiting = new Set<() => void>();
  /**
   * Called each time a place comes back, so whatever is waiting for one can take it. Without this
   * a task in the waiting line would sit there until somebody happened to add another.
   */
  onRoom: () => void = () => undefined;
  constructor(readonly limit = maximumActiveExecutions) {}
  /** How many pieces of work are going on right now. */
  get count(): number {
    return this.active;
  }
  /** How many more would fit before the limit is reached. */
  get room(): number {
    return Math.max(0, this.limit - this.active);
  }
  /**
   * Takes a place, and hands back the one way to give it up again; null when there is no room.
   * Giving the same place up twice counts only once, so a mistake cannot invent room.
   */
  take(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active++;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      this.active--;
      // Everyone asleep is woken before the waiting line is looked at, so neither can be starved
      // by the other: whoever asks first gets the place, and the rest go back to sleep.
      const sleepers = [...this.waiting];
      this.waiting.clear();
      for (const wake of sleepers) try { wake(); } catch { /* a sleeper must never break a finish */ }
      this.onRoom();
    };
  }
  /**
   * Waits until a place comes back, or until `withinMs` has passed, whichever is first. The timeout
   * is what makes it safe to wait at all: something that holds a place without ever giving it up
   * can slow a waiter down but can never hold it for ever.
   */
  roomSoon(withinMs = 200): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.waiting.delete(wake); resolve(); }, withinMs);
      timer.unref?.();
      this.waiting.add(wake);
    });
  }
}
