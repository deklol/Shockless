import { describe, expect, it } from "vitest";
import { ManualDirectorAudioClock } from "../../src/director/audio/clock";
import { DirectorSoundSystem } from "../../src/director/audio/DirectorSoundSystem";
import type { DirectorSoundEntry } from "../../src/director/audio/types";
import { VirtualAudioBackend } from "../../src/director/audio/VirtualAudioBackend";
import { CastMember } from "../../src/director/members";
import { LingoList, LingoPropList, symbol } from "../../src/director/values";

describe("Director sound channels", () => {
  it("exposes exactly eight stable channels", () => {
    const { system } = createSoundSystem();

    expect(system.channel(1)).toBe(system.channel(1));
    expect(system.channel(8).number).toBe(8);
    expect(() => system.channel(0)).toThrow(/1-8/);
    expect(() => system.channel(9)).toThrow(/1-8/);
  });

  it("runs all eight Director channels concurrently and completes them independently", () => {
    const { system, backend, clock } = createSoundSystem();
    for (let channelNumber = 1; channelNumber <= 8; channelNumber += 1) {
      const channel = system.channel(channelNumber);
      expect(channel.play(soundMember(`channel-${channelNumber}`, channelNumber * 100))).toBe(1);
      expect(channel.status).toBe(3);
    }
    expect(backend.active.size).toBe(8);

    clock.advance(450);
    system.update();
    expect([...backend.active.keys()].sort()).toEqual([5, 6, 7, 8]);

    clock.advance(400);
    system.update();
    expect(backend.active.size).toBe(0);
    expect(system.snapshot().every((channel) => channel.status === 0)).toBe(true);
  });

  it("preloads a playlist and advances without stopping the scheduled backend", async () => {
    const { system, backend, clock } = createSoundSystem();
    const channel = system.channel(1);
    const first = soundMember("first", 1_000);
    const second = soundMember("second", 750);

    expect(channel.queue(soundEntry(first))).toBe(1);
    expect(channel.queue(soundEntry(second))).toBe(1);
    expect(channel.status).toBe(1);
    await flushPromises();
    expect(channel.status).toBe(2);

    expect(channel.play()).toBe(1);
    expect(channel.status).toBe(3);
    expect(channel.member).toBe(first);
    expect(backend.queueSnapshots.get(1)).toHaveLength(1);
    const stopCountBeforeBoundary = operations(backend, "stop").length;

    clock.advance(1_000);
    channel.update();

    expect(channel.member).toBe(second);
    expect(channel.elapsedTime).toBe(0);
    expect(channel.getPlayList().items).toHaveLength(0);
    expect(operations(backend, "stop")).toHaveLength(stopCountBeforeBoundary);

    clock.advance(750);
    channel.update();
    expect(channel.status).toBe(0);
    expect(operations(backend, "stop").length).toBeGreaterThan(stopCountBeforeBoundary);
  });

  it("preserves overrun when one runtime tick crosses multiple queue boundaries", async () => {
    const { system, clock } = createSoundSystem();
    const channel = system.channel(2);
    const first = soundMember("first", 100);
    const second = soundMember("second", 100);
    const third = soundMember("third", 100);
    channel.setPlayList(new LingoList([soundEntry(first), soundEntry(second), soundEntry(third)]));
    await flushPromises();
    channel.play();

    clock.advance(250);
    channel.update();

    expect(channel.member).toBe(third);
    expect(channel.elapsedTime).toBe(50);
    expect(channel.getPlayList().items).toHaveLength(0);
  });

  it("keeps the future playlist when direct play interrupts the current sound", async () => {
    const { system, clock } = createSoundSystem();
    const channel = system.channel(2);
    const queued = soundMember("queued-after-direct", 600);
    const direct = soundMember("direct", 400);
    channel.queue(soundEntry(queued));
    await flushPromises();

    expect(channel.play(direct)).toBe(1);
    expect(channel.member).toBe(direct);
    expect(channel.getPlayList().items).toHaveLength(1);

    clock.advance(400);
    channel.update();
    expect(channel.member).toBe(queued);
    expect(channel.getPlayList().items).toHaveLength(0);
  });

  it("playNext interrupts once and preserves the remaining queue order", async () => {
    const { system, backend } = createSoundSystem();
    const channel = system.channel(2);
    const first = soundMember("next-first", 500);
    const second = soundMember("next-second", 500);
    const third = soundMember("next-third", 500);
    channel.setPlayList(new LingoList([soundEntry(first), soundEntry(second), soundEntry(third)]));
    await flushPromises();
    channel.play();

    const stopCount = operations(backend, "stop").length;
    expect(channel.playNext()).toBe(1);
    expect(channel.member).toBe(second);
    expect(channel.getPlayList().items).toHaveLength(1);
    expect(operations(backend, "stop")).toHaveLength(stopCount + 2);

    expect(channel.playNext()).toBe(1);
    expect(channel.member).toBe(third);
    expect(channel.getPlayList().items).toHaveLength(0);
    expect(channel.playNext()).toBe(0);
    expect(channel.status).toBe(0);
  });

  it("setPlayList replaces only future sounds while one is playing", async () => {
    const { system } = createSoundSystem();
    const channel = system.channel(2);
    const current = soundMember("playlist-current", 1_000);
    const removed = soundMember("playlist-removed", 1_000);
    const replacement = soundMember("playlist-replacement", 1_000);
    channel.setPlayList(new LingoList([soundEntry(current), soundEntry(removed)]));
    await flushPromises();
    channel.play();

    expect(channel.setPlayList(new LingoList([soundEntry(replacement)]))).toBe(1);
    expect(channel.member).toBe(current);
    const list = channel.getPlayList();
    expect(list.items).toHaveLength(1);
    expect((list.items[0] as LingoPropList).values[0]).toBe(replacement);
  });

  it("returns a detached playlist copy that cannot mutate channel state", async () => {
    const { system } = createSoundSystem();
    const channel = system.channel(2);
    const queued = soundMember("detached-copy", 1_000);
    channel.queue(soundEntry(queued));
    await flushPromises();

    const returned = channel.getPlayList();
    (returned.items[0] as LingoPropList).values[0] = soundMember("mutated-copy", 1_000);
    returned.items.length = 0;

    const fresh = channel.getPlayList();
    expect(fresh.items).toHaveLength(1);
    expect((fresh.items[0] as LingoPropList).values[0]).toBe(queued);
  });

  it("ignores completion and errors from superseded backend requests", () => {
    const { system, backend, errors } = createSoundSystem();
    const channel = system.channel(2);
    const first = soundMember("stale-first", 1_000);
    const second = soundMember("stale-second", 1_000);
    channel.play(first);
    const stale = backend.active.get(2)!;

    channel.play(second);
    stale.onEnded();
    stale.onError(new Error("stale failure"));

    expect(channel.member).toBe(second);
    expect(channel.status).toBe(3);
    expect(errors).toHaveLength(0);
  });

  it("implements finite loops, loop regions, and breakLoop timing", () => {
    const { system, clock } = createSoundSystem();
    const channel = system.channel(3);
    const member = soundMember("loop", 1_000);
    channel.play(
      soundEntry(member, {
        startTime: 100,
        endTime: 900,
        loopCount: 3,
        loopStartTime: 300,
        loopEndTime: 600,
      }),
    );

    expect(channel.loopCount).toBe(3);
    expect(channel.loopsRemaining).toBe(2);
    clock.advance(550);
    expect(channel.elapsedTime).toBe(550);
    expect(channel.loopsRemaining).toBe(1);

    expect(channel.breakLoop()).toBe(1);
    clock.advance(550);
    channel.update();
    expect(channel.status).toBe(0);
  });

  it("breakLoop exits an infinite loop through its remaining authored tail", () => {
    const { system, clock } = createSoundSystem();
    const channel = system.channel(3);
    const member = soundMember("infinite-loop", 1_000);
    channel.play(
      soundEntry(member, {
        startTime: 100,
        endTime: 900,
        loopCount: 0,
        loopStartTime: 300,
        loopEndTime: 600,
      }),
    );

    clock.advance(750);
    expect(channel.breakLoop()).toBe(1);
    expect(channel.status).toBe(3);
    clock.advance(450);
    channel.update();
    expect(channel.status).toBe(0);
  });

  it("pauses, resumes, and rewinds without dropping the playlist", async () => {
    const { system, clock } = createSoundSystem();
    const channel = system.channel(4);
    const current = soundMember("current", 1_000);
    const queued = soundMember("queued", 1_000);
    channel.queue(soundEntry(current));
    channel.queue(soundEntry(queued));
    await flushPromises();
    channel.play();
    clock.advance(320);

    expect(channel.pause()).toBe(1);
    expect(channel.status).toBe(4);
    expect(channel.isBusy()).toBe(0);
    expect(channel.elapsedTime).toBe(320);
    clock.advance(500);
    expect(channel.elapsedTime).toBe(320);
    expect(channel.getPlayList().items).toHaveLength(1);

    expect(channel.rewind()).toBe(1);
    expect(channel.status).toBe(4);
    expect(channel.elapsedTime).toBe(0);
    expect(channel.play()).toBe(1);
    clock.advance(100);
    expect(channel.elapsedTime).toBe(100);
  });

  it("uses a sound member's authored loop setting and embedded loop region", () => {
    const { system } = createSoundSystem();
    const channel = system.channel(4);
    const member = soundMember("authored-loop", 1_000);
    member.soundLoop = true;
    member.sound!.loopStart = 4_410;
    member.sound!.loopEnd = 35_280;

    channel.play(member);

    expect(channel.loopCount).toBe(0);
    expect(channel.loopStartTime).toBe(100);
    expect(channel.loopEndTime).toBe(800);
    expect(channel.loopsRemaining).toBe(0);
  });

  it("lets an explicit play loopCount override the member loop property", () => {
    const { system } = createSoundSystem();
    const channel = system.channel(4);
    const member = soundMember("loop-override", 1_000);
    member.soundLoop = true;

    channel.play(soundEntry(member, { loopCount: 2 }));

    expect(channel.loopCount).toBe(2);
    expect(channel.loopsRemaining).toBe(1);
  });

  it("resets the format lock on stop while retaining future playlist entries", async () => {
    const { system } = createSoundSystem();
    const channel = system.channel(4);
    const current = soundMember("eight-bit", 1_000);
    current.sound!.sampleSize = 8;
    const queued = soundMember("unknown-depth", 1_000);
    queued.sound!.sampleSize = null;
    channel.queue(soundEntry(current));
    channel.queue(soundEntry(queued));
    await flushPromises();
    channel.play();

    expect(channel.sampleSize).toBe(8);
    channel.stop();
    expect(channel.getPlayList().items).toHaveLength(1);
    expect(channel.sampleRate).toBe(0);
    expect(channel.channelCount).toBe(0);
    expect(channel.sampleSize).toBe(0);

    channel.play();
    expect(channel.sampleRate).toBe(44_100);
    expect(channel.sampleSize).toBe(0);
  });

  it("keeps channel volume independent from global sound controls", () => {
    const { system, backend } = createSoundSystem();
    const channel = system.channel(5);
    channel.volume = 123;

    system.soundLevel = 3;
    expect(backend.masterGain).toBeCloseTo(3 / 7);
    expect(channel.volume).toBe(123);
    expect(backend.volumes.get(5)).toBe(123);

    system.soundEnabled = 0;
    expect(backend.masterGain).toBe(0);
    expect(channel.volume).toBe(123);
    system.soundEnabled = 1;
    expect(backend.masterGain).toBeCloseTo(3 / 7);
  });

  it("defers pan writes until a running fade finishes", () => {
    const { system, backend, clock } = createSoundSystem();
    const channel = system.channel(6);
    channel.volume = 200;
    channel.pan = -25;
    channel.fadeTo(100, 1_000);
    channel.pan = 75;

    expect(operations(backend, "volume").at(-1)).toMatchObject({
      channelNumber: 6,
      value: 100,
      durationMs: 1_000,
    });
    expect(backend.pans.get(6)).toBe(-25);
    clock.advance(500);
    expect(channel.volume).toBe(150);
    expect(backend.pans.get(6)).toBe(-25);
    clock.advance(500);
    expect(channel.volume).toBe(100);
    expect(backend.pans.get(6)).toBe(75);
  });

  it("ignores stale preload completions after setPlayList replaces the queue", async () => {
    const backend = new DeferredPreloadBackend();
    const { system } = createSoundSystem(backend);
    const channel = system.channel(7);
    const stale = soundMember("stale", 500);
    const current = soundMember("current", 500);

    channel.queue(soundEntry(stale));
    channel.setPlayList(new LingoList([soundEntry(current)]));
    expect(channel.status).toBe(1);

    backend.resolve("stale");
    await flushPromises();
    expect(channel.status).toBe(1);

    backend.resolve("current");
    await flushPromises();
    expect(channel.status).toBe(2);
  });

  it("delegates resume and disposes every active or queued channel", async () => {
    const backend = new LifecycleAudioBackend();
    const { system } = createSoundSystem(backend);
    const staleCallbacks: Array<() => void> = [];

    for (let channelNumber = 1; channelNumber <= 8; channelNumber += 1) {
      const channel = system.channel(channelNumber);
      channel.play(soundMember(`active-${channelNumber}`, 1_000));
      staleCallbacks.push(backend.active.get(channelNumber)!.onEnded);
      channel.queue(soundEntry(soundMember(`queued-${channelNumber}`, 500)));
    }

    await system.resume();
    expect(backend.resumeCount).toBe(1);

    system.dispose();
    expect(backend.disposeCount).toBe(1);
    expect(backend.active.size).toBe(0);
    expect(system.snapshot().every((channel) => channel.status === 0 && channel.queued === 0)).toBe(true);

    for (const callback of staleCallbacks) callback();
    expect(system.snapshot().every((channel) => channel.status === 0 && channel.queued === 0)).toBe(true);
  });
});

function createSoundSystem(backend = new VirtualAudioBackend()) {
  const clock = new ManualDirectorAudioClock();
  const errors: string[] = [];
  const system = new DirectorSoundSystem({
    backend,
    clock,
    findMember: () => null,
    reportError: (message) => errors.push(message),
  });
  return { system, backend, clock, errors };
}

function soundMember(name: string, durationMs: number): CastMember {
  const sampleRate = 44_100;
  return new CastMember("sounds", 5, Math.max(1, name.length), name, "sound", {
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
      assetPath: `${name}.wav`,
      assetUrl: `/assets/${name}.wav`,
      assetSha256: name,
    },
  });
}

function soundEntry(
  member: CastMember,
  options: Partial<Record<"startTime" | "endTime" | "loopCount" | "loopStartTime" | "loopEndTime", number>> = {},
): LingoPropList {
  return LingoPropList.fromPairs([
    [symbol("member"), member],
    ...Object.entries(options).map(([key, value]) => [symbol(key), value] as [ReturnType<typeof symbol>, number]),
  ]);
}

function operations(backend: VirtualAudioBackend, operation: string) {
  return backend.trace.filter((entry) => entry.operation === operation);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class DeferredPreloadBackend extends VirtualAudioBackend {
  private readonly pending = new Map<string, () => void>();

  override preload(entry: DirectorSoundEntry): Promise<void> {
    return new Promise((resolve) => this.pending.set(entry.member.name, resolve));
  }

  resolve(name: string): void {
    const resolve = this.pending.get(name);
    if (!resolve) throw new Error(`No pending preload for ${name}`);
    this.pending.delete(name);
    resolve();
  }
}

class LifecycleAudioBackend extends VirtualAudioBackend {
  resumeCount = 0;
  disposeCount = 0;

  override async resume(): Promise<void> {
    this.resumeCount += 1;
  }

  override dispose(): void {
    this.disposeCount += 1;
    super.dispose();
  }
}
