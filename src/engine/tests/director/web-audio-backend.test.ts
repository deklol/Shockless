import { describe, expect, it } from "vitest";
import { WebAudioBackend } from "../../src/director/audio/WebAudioBackend";
import type { DirectorSoundEntry, DirectorSoundPlaybackRequest } from "../../src/director/audio/types";
import { CastMember } from "../../src/director/members";
import { LingoPropList } from "../../src/director/values";

describe("WebAudioBackend", () => {
  it("starts the active sound without waiting for future playlist decoding", async () => {
    const context = new FakeAudioContext();
    const futureBytes = deferred<ArrayBuffer>();
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const future = soundEntry("future", 1_000, "/future.wav", 2);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: (url) => url === future.media.assetUrl ? futureBytes.promise : Promise.resolve(encodedBuffer(1)),
    });

    backend.play(playbackRequest(current, [future], events));
    await flushAsync();

    expect(events).toEqual(["started"]);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.starts).toEqual([{ when: 0, offset: 0, duration: 1 }]);

    futureBytes.resolve(encodedBuffer(2));
    await flushAsync();
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1]?.starts).toEqual([{ when: 1, offset: 0, duration: 1 }]);
  });

  it("keeps the Director queue timeline when future decoding finishes after its boundary", async () => {
    const context = new FakeAudioContext();
    const futureBytes = deferred<ArrayBuffer>();
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const future = soundEntry("future", 1_000, "/future.wav", 2);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: (url) => url === future.media.assetUrl ? futureBytes.promise : Promise.resolve(encodedBuffer(1)),
    });

    backend.play(playbackRequest(current, [future], events));
    await flushAsync();
    expect(context.sources[0]?.onended).toBeNull();

    context.currentTime = 1.25;
    futureBytes.resolve(encodedBuffer(2));
    await flushAsync();

    expect(events).toEqual(["started"]);
    expect(context.sources[1]?.starts).toEqual([{ when: 1.25, offset: 0.25, duration: 0.75 }]);
    expect(context.sources[1]?.onended).toBeTypeOf("function");
  });

  it("reports a failed future entry without stopping the active sound", async () => {
    const context = new FakeAudioContext();
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const future = soundEntry("broken", 1_000, "/broken.wav", 2);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: (url) => url === future.media.assetUrl
        ? Promise.reject(new Error("decode failed"))
        : Promise.resolve(encodedBuffer(1)),
    });

    backend.play(playbackRequest(current, [future], events));
    await flushAsync();

    expect(events).toEqual(["started", "queue-error:broken"]);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.stopped).toBe(false);
  });

  it("ignores a stale asynchronous start after the channel is stopped", async () => {
    const context = new FakeAudioContext();
    const currentBytes = deferred<ArrayBuffer>();
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: () => currentBytes.promise,
    });

    backend.play(playbackRequest(current, [], events));
    backend.stop(1);
    currentBytes.resolve(encodedBuffer(1));
    await flushAsync();

    expect(events).toEqual([]);
    expect(context.sources).toHaveLength(0);
  });

  it("deduplicates concurrent preload and playback decoding by asset identity", async () => {
    const context = new FakeAudioContext();
    const bytes = deferred<ArrayBuffer>();
    let fetchCount = 0;
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: () => {
        fetchCount += 1;
        return bytes.promise;
      },
    });

    const preloadA = backend.preload(current);
    const preloadB = backend.preload(current);
    backend.play(playbackRequest(current, [], events));
    expect(fetchCount).toBe(1);

    bytes.resolve(encodedBuffer(1));
    await Promise.all([preloadA, preloadB]);
    await flushAsync();
    expect(events).toEqual(["started"]);
    expect(fetchCount).toBe(1);
  });

  it("replaces future scheduling without interrupting the active source", async () => {
    const context = new FakeAudioContext();
    const events: string[] = [];
    const current = soundEntry("current", 1_000, "/current.wav", 1);
    const firstFuture = soundEntry("first-future", 1_000, "/first-future.wav", 2);
    const replacement = soundEntry("replacement", 1_000, "/replacement.wav", 3);
    const backend = new WebAudioBackend({
      contextFactory: () => context.asAudioContext(),
      fetchBytes: async (url) => encodedBuffer(url.includes("replacement") ? 3 : url.includes("first-future") ? 2 : 1),
    });

    const request = playbackRequest(current, [firstFuture], events);
    backend.play(request);
    await flushAsync();
    expect(context.sources).toHaveLength(2);

    backend.syncQueue(request.channelNumber, request.token, [replacement]);
    await flushAsync();

    expect(context.sources).toHaveLength(3);
    expect(context.sources[0]?.stopped).toBe(false);
    expect(context.sources[1]?.stopped).toBe(true);
    expect(context.sources[2]?.buffer?.label).toBe(3);
    expect(context.sources[2]?.starts).toEqual([{ when: 1, offset: 0, duration: 1 }]);
  });
});

function playbackRequest(
  entry: DirectorSoundEntry,
  queuedEntries: readonly DirectorSoundEntry[],
  events: string[],
): DirectorSoundPlaybackRequest {
  return {
    channelNumber: 1,
    token: 17,
    entry,
    queuedEntries,
    elapsedMs: 0,
    volume: 255,
    pan: 0,
    onStarted: () => events.push("started"),
    onEnded: () => events.push("ended"),
    onError: () => events.push("error"),
    onQueueError: (failed) => events.push(`queue-error:${failed.member.name}`),
  };
}

function soundEntry(
  name: string,
  durationMs: number,
  assetUrl: string,
  assetLabel: number,
): DirectorSoundEntry {
  const sampleRate = 44_100;
  const member = new CastMember("sound-test", 1, assetLabel, name, "sound", {
    sound: {
      container: "wav",
      codec: "pcm",
      sampleRate,
      channels: 2,
      sampleSize: 16,
      sampleCount: Math.round((durationMs / 1_000) * sampleRate),
      durationMs,
      loopStart: null,
      loopEnd: null,
      assetPath: assetUrl.slice(1),
      assetUrl,
      assetSha256: `asset-${assetLabel}`,
    },
  });
  return {
    source: LingoPropList.fromPairs([]),
    member,
    media: member.sound!,
    startTimeMs: 0,
    endTimeMs: durationMs,
    loopCount: 1,
    loopStartTimeMs: 0,
    loopEndTimeMs: durationMs,
    preloadTimeMs: 1_500,
  };
}

function encodedBuffer(label: number): ArrayBuffer {
  return Uint8Array.of(label).buffer;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

class FakeAudioParam {
  value = 1;

  cancelScheduledValues(_time: number): this {
    return this;
  }

  setValueAtTime(value: number, _time: number): this {
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, _time: number): this {
    this.value = value;
    return this;
  }
}

class FakeAudioBuffer {
  readonly duration = 1;

  constructor(readonly label: number) {}
}

class FakeAudioBufferSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  readonly starts: Array<{ when: number; offset: number; duration?: number }> = [];
  stopped = false;

  connect(_node: unknown): unknown {
    return _node;
  }

  disconnect(): void {}

  start(when = 0, offset = 0, duration?: number): void {
    this.starts.push(duration === undefined ? { when, offset } : { when, offset, duration });
  }

  stop(_when?: number): void {
    this.stopped = true;
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();

  connect(_node: unknown): unknown {
    return _node;
  }

  disconnect(): void {}
}

class FakeStereoPannerNode {
  readonly pan = new FakeAudioParam();

  connect(_node: unknown): unknown {
    return _node;
  }

  disconnect(): void {}
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = "running";
  readonly destination = {};
  readonly sources: FakeAudioBufferSource[] = [];

  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }

  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }

  createStereoPanner(): StereoPannerNode {
    return new FakeStereoPannerNode() as unknown as StereoPannerNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  async decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return new FakeAudioBuffer(new Uint8Array(bytes)[0] ?? 0) as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}
