/** Owns the user-selected visibility state for Habbo UI channels. */
export class UiVisibilityController {
  private hidden = false;

  constructor(private readonly collectUiChannels: (channels: Set<number>) => void) {}

  setHidden(value: boolean): boolean {
    this.hidden = Boolean(value);
    return this.hidden;
  }

  collectHiddenChannels(channels: Set<number>): void {
    if (this.hidden) this.collectUiChannels(channels);
  }
}
