/** Keeps the install claimed until hand-over starts, even after file staging has finished. */
export class UpdateInstallClaim {
  private claimed = false;

  get active(): boolean {
    return this.claimed;
  }

  async run<T>(status: () => T, inProgress: () => boolean, install: () => Promise<T>): Promise<T> {
    if (this.claimed || inProgress()) return status();
    this.claimed = true;
    try {
      return await install();
    } catch (error) {
      this.claimed = false;
      throw error;
    }
  }
}
