import type { Container, Graphics, Sprite, Text, TilingSprite } from "pixi.js";

type InterpolatedNode = Sprite | Graphics | TilingSprite | Text | Container;

interface ChannelInterpolationState {
  readonly node: InterpolatedNode;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly startedAtMs: number;
  readonly durationMs: number;
}

export interface AvatarInterpolationSettings {
  readonly enabled: boolean;
  readonly channels: ReadonlySet<number>;
  readonly frameTempo: number;
}

export interface AvatarInterpolationDiagnostics {
  readonly enabled: boolean;
  readonly channels: number;
  readonly active: number;
  readonly durationMs: number;
  readonly snapped: number;
}

// Booster, roller, and scripted air movement can advance by more than one
// tile between source ticks. Room loads, zoom, and presentation changes reset
// interpolation separately, so this guard should only catch true same-channel
// teleports instead of normal large room motion.
const MAX_INTERPOLATED_JUMP_PX = 384;

export class AvatarInterpolationPresenter {
  private enabled = true;
  private channels = new Set<number>();
  private states = new Map<number, ChannelInterpolationState>();
  private nowMs = 0;
  private durationMs = 42;
  private snapped = 0;

  configure(settings: AvatarInterpolationSettings): boolean {
    const nextEnabled = Boolean(settings.enabled);
    const nextChannels = new Set(settings.channels);
    const nextDurationMs = this.durationFromTempo(settings.frameTempo);
    const changed =
      this.enabled !== nextEnabled ||
      this.durationMs !== nextDurationMs ||
      !sameNumberSet(this.channels, nextChannels);

    this.enabled = nextEnabled;
    this.channels = nextChannels;
    this.durationMs = nextDurationMs;

    for (const channel of [...this.states.keys()]) {
      if (!this.enabled || !this.channels.has(channel)) this.states.delete(channel);
    }

    return changed;
  }

  reset(): void {
    this.states.clear();
  }

  forget(channelNumber: number): void {
    this.states.delete(channelNumber);
  }

  tracks(channelNumber: number): boolean {
    return this.enabled && this.channels.has(channelNumber);
  }

  beginFrame(nowMs: number): void {
    this.nowMs = Number.isFinite(nowMs) ? nowMs : performance.now();
    this.update(this.nowMs);
  }

  applyPosition(channelNumber: number, node: InterpolatedNode, targetX: number, targetY: number): void {
    if (!this.enabled || !this.channels.has(channelNumber)) {
      this.snap(channelNumber, node, targetX, targetY);
      return;
    }

    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      this.snap(channelNumber, node, targetX, targetY);
      return;
    }

    setRoundPixels(node, false);
    const previous = this.states.get(channelNumber);
    if (!previous || previous.node !== node) {
      node.x = targetX;
      node.y = targetY;
      this.states.set(channelNumber, {
        node,
        fromX: targetX,
        fromY: targetY,
        toX: targetX,
        toY: targetY,
        startedAtMs: this.nowMs,
        durationMs: this.durationMs,
      });
      return;
    }

    if (previous.toX === targetX && previous.toY === targetY) {
      const point = this.positionAt(previous, this.nowMs);
      node.x = point.x;
      node.y = point.y;
      return;
    }

    const current = this.positionAt(previous, this.nowMs);
    const distance = Math.hypot(targetX - current.x, targetY - current.y);
    if (distance > MAX_INTERPOLATED_JUMP_PX) {
      this.snapped += 1;
      node.x = targetX;
      node.y = targetY;
      this.states.set(channelNumber, {
        node,
        fromX: targetX,
        fromY: targetY,
        toX: targetX,
        toY: targetY,
        startedAtMs: this.nowMs,
        durationMs: this.durationMs,
      });
      return;
    }

    node.x = current.x;
    node.y = current.y;
    this.states.set(channelNumber, {
      node,
      fromX: current.x,
      fromY: current.y,
      toX: targetX,
      toY: targetY,
      startedAtMs: this.nowMs,
      durationMs: this.durationMs,
    });
  }

  hasActive(): boolean {
    if (!this.enabled) return false;
    for (const state of this.states.values()) {
      if (this.interpolationT(state, this.nowMs) < 1) return true;
    }
    return false;
  }

  diagnostics(): AvatarInterpolationDiagnostics {
    let active = 0;
    for (const state of this.states.values()) {
      if (this.interpolationT(state, this.nowMs) < 1) active += 1;
    }
    return {
      enabled: this.enabled,
      channels: this.channels.size,
      active,
      durationMs: Math.round(this.durationMs * 100) / 100,
      snapped: this.snapped,
    };
  }

  private snap(channelNumber: number, node: InterpolatedNode, targetX: number, targetY: number): void {
    node.x = targetX;
    node.y = targetY;
    setRoundPixels(node, true);
    this.states.delete(channelNumber);
  }

  private update(nowMs: number): void {
    for (const [channelNumber, state] of this.states) {
      if ("destroyed" in state.node && state.node.destroyed) {
        this.states.delete(channelNumber);
        continue;
      }
      const point = this.positionAt(state, nowMs);
      state.node.x = point.x;
      state.node.y = point.y;
      if (this.interpolationT(state, nowMs) >= 1) {
        this.states.set(channelNumber, {
          ...state,
          fromX: state.toX,
          fromY: state.toY,
          startedAtMs: nowMs,
        });
      }
    }
  }

  private positionAt(state: ChannelInterpolationState, nowMs: number): { readonly x: number; readonly y: number } {
    const t = smoothStep(this.interpolationT(state, nowMs));
    return {
      x: state.fromX + (state.toX - state.fromX) * t,
      y: state.fromY + (state.toY - state.fromY) * t,
    };
  }

  private interpolationT(state: ChannelInterpolationState, nowMs: number): number {
    if (state.durationMs <= 0) return 1;
    return Math.max(0, Math.min(1, (nowMs - state.startedAtMs) / state.durationMs));
  }

  private durationFromTempo(frameTempo: number): number {
    const tempo = Number.isFinite(frameTempo) && frameTempo > 0 ? frameTempo : 24;
    return Math.max(18, Math.min(90, (1000 / tempo) * 0.92));
  }
}

function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

function setRoundPixels(node: InterpolatedNode, value: boolean): void {
  if ("roundPixels" in node) node.roundPixels = value;
}
