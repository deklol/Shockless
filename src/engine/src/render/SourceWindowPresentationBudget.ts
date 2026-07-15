export interface SourceWindowPresentationBudgetSettings {
  readonly enabled: boolean;
  readonly channels: ReadonlySet<number>;
  readonly maxTextPreparationsPerFrame?: number;
  readonly maxSpriteUpdatesPerFrame?: number;
}

export interface SourceWindowPresentationBudgetDiagnostics {
  readonly enabled: boolean;
  readonly channels: number;
  readonly textLimit: number;
  readonly spriteLimit: number;
  readonly preparedText: number;
  readonly appliedSprites: number;
  readonly deferredText: number;
  readonly deferredSprites: number;
  readonly frame: number;
}

export class SourceWindowPresentationBudget {
  private enabled = true;
  private channels = new Set<number>();
  private textLimit = 18;
  private spriteLimit = 28;
  private preparedText = 0;
  private appliedSprites = 0;
  private deferredText = 0;
  private deferredSprites = 0;
  private deferredWork = false;
  private frame = 0;

  configure(settings: SourceWindowPresentationBudgetSettings): boolean {
    const nextEnabled = Boolean(settings.enabled);
    const nextChannels = new Set(settings.channels);
    const nextTextLimit = normalizeLimit(settings.maxTextPreparationsPerFrame, 18);
    const nextSpriteLimit = normalizeLimit(settings.maxSpriteUpdatesPerFrame, 28);
    const changed =
      this.enabled !== nextEnabled ||
      this.textLimit !== nextTextLimit ||
      this.spriteLimit !== nextSpriteLimit ||
      !sameNumberSet(this.channels, nextChannels);

    this.enabled = nextEnabled;
    this.channels = nextChannels;
    this.textLimit = nextTextLimit;
    this.spriteLimit = nextSpriteLimit;
    if (!this.enabled || this.channels.size === 0) this.deferredWork = false;
    return changed;
  }

  beginFrame(): void {
    this.preparedText = 0;
    this.appliedSprites = 0;
    this.deferredText = 0;
    this.deferredSprites = 0;
    this.deferredWork = false;
    this.frame += 1;
  }

  shouldPrepareTextChannel(channelNumber: number, focused: boolean): boolean {
    if (!this.activeFor(channelNumber) || focused) return true;
    if (this.preparedText < this.textLimit) {
      this.preparedText += 1;
      return true;
    }
    this.deferredText += 1;
    this.deferredWork = true;
    return false;
  }

  /**
   * Source-window sprite channels carry live Director state such as loc,
   * width, height, rotation, and member changes. Those changes must stay
   * frame-synchronous; only expensive text preparation is allowed to be
   * spread over multiple modern frames.
   */
  recordSpriteChannelPresentation(channelNumber: number): void {
    if (this.activeFor(channelNumber)) this.appliedSprites += 1;
  }

  hasDeferredWork(): boolean {
    return this.deferredWork;
  }

  diagnostics(): SourceWindowPresentationBudgetDiagnostics {
    return {
      enabled: this.enabled,
      channels: this.channels.size,
      textLimit: this.textLimit,
      spriteLimit: this.spriteLimit,
      preparedText: this.preparedText,
      appliedSprites: this.appliedSprites,
      deferredText: this.deferredText,
      deferredSprites: this.deferredSprites,
      frame: this.frame,
    };
  }

  private activeFor(channelNumber: number): boolean {
    return this.enabled && this.channels.has(channelNumber);
  }
}

function normalizeLimit(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(200, Math.trunc(numeric)));
}

function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
