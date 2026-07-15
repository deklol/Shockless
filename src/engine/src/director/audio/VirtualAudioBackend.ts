import type { DirectorSoundBackend, DirectorSoundEntry, DirectorSoundPlaybackRequest } from "./types";

/** Silent but stateful backend for Node, headless sessions, and deterministic tests. */
export class VirtualAudioBackend implements DirectorSoundBackend {
  readonly kind = "virtual";
  readonly deviceName = "Virtual Director Sound";
  readonly volumes = new Map<number, number>();
  readonly pans = new Map<number, number>();
  readonly active = new Map<number, DirectorSoundPlaybackRequest>();
  readonly queueSnapshots = new Map<number, readonly DirectorSoundEntry[]>();
  readonly trace: Array<{
    operation: string;
    channelNumber?: number;
    token?: number;
    value?: number;
    durationMs?: number;
  }> = [];
  masterGain = 1;

  async preload(_entry: DirectorSoundEntry): Promise<void> {
    this.trace.push({ operation: "preload" });
  }

  play(request: DirectorSoundPlaybackRequest): void {
    this.active.set(request.channelNumber, request);
    this.queueSnapshots.set(request.channelNumber, [...request.queuedEntries]);
    this.trace.push({ operation: "play", channelNumber: request.channelNumber, token: request.token });
    request.onStarted();
  }

  syncQueue(channelNumber: number, token: number, queuedEntries: readonly DirectorSoundEntry[]): void {
    const active = this.active.get(channelNumber);
    if (!active || active.token !== token) return;
    this.queueSnapshots.set(channelNumber, [...queuedEntries]);
    this.trace.push({ operation: "syncQueue", channelNumber, token, value: queuedEntries.length });
  }

  stop(channelNumber: number): void {
    this.active.delete(channelNumber);
    this.queueSnapshots.delete(channelNumber);
    this.trace.push({ operation: "stop", channelNumber });
  }

  setChannelVolume(channelNumber: number, volume: number, rampMs = 0): void {
    this.volumes.set(channelNumber, volume);
    this.trace.push({ operation: "volume", channelNumber, value: volume, durationMs: rampMs });
  }

  setChannelPan(channelNumber: number, pan: number): void {
    this.pans.set(channelNumber, pan);
    this.trace.push({ operation: "pan", channelNumber, value: pan });
  }

  setMasterGain(gain: number): void {
    this.masterGain = gain;
    this.trace.push({ operation: "masterGain", value: gain });
  }

  async resume(): Promise<void> {}

  dispose(): void {
    this.active.clear();
    this.queueSnapshots.clear();
    this.volumes.clear();
    this.pans.clear();
    this.trace.push({ operation: "dispose" });
  }
}
