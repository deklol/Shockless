import { describe, expect, it, vi } from "vitest";
import { ManualDirectorAudioClock } from "../../src/director/audio/clock";
import {
  DirectorAudioTraceBuffer,
  TracingAudioBackend,
} from "../../src/director/audio/TracingAudioBackend";
import type { DirectorSoundEntry, DirectorSoundPlaybackRequest } from "../../src/director/audio/types";
import { VirtualAudioBackend } from "../../src/director/audio/VirtualAudioBackend";
import { CastMember } from "../../src/director/members";
import { LingoPropList } from "../../src/director/values";

describe("Director audio trace", () => {
  it("is inert until explicitly enabled", async () => {
    const clock = new ManualDirectorAudioClock(25);
    const trace = new DirectorAudioTraceBuffer(clock);
    const backend = new TracingAudioBackend(new VirtualAudioBackend(), trace);

    await backend.preload(soundEntry());
    backend.setMasterGain(0.5);

    expect(trace.snapshot()).toEqual([]);
  });

  it("records bounded source provenance and both clocks without changing callbacks", () => {
    const clock = new ManualDirectorAudioClock(100);
    const trace = new DirectorAudioTraceBuffer(clock, 3);
    trace.setContext({ profileId: "release331-test" });
    trace.setEnabled(true);
    const base = new VirtualAudioBackend();
    const backend = new TracingAudioBackend(base, trace);
    const entry = soundEntry();
    const onStarted = vi.fn();
    const onEnded = vi.fn();
    const request = playbackRequest(entry, onStarted, onEnded);

    backend.play(request);
    clock.advance(15);
    backend.setChannelPan(2, -40);
    backend.setChannelVolume(2, 128, 250);

    expect(onStarted).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
    expect(base.active.get(2)?.token).toBe(7);
    const events = trace.snapshot();
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.operation)).toEqual(["started", "pan", "volume"]);
    expect(events[0]).toMatchObject({
      monotonicMs: 100,
      backendTimeMs: null,
      profileId: "release331-test",
      backend: "virtual",
      channelNumber: 2,
      token: 7,
      entry: {
        castName: "hh_soundmachine",
        castNumber: 12,
        memberNumber: 45,
        memberName: "trax_sample_1",
        container: "director-snd-pcm",
        codec: "pcm",
        sourceFourCC: "snd ",
      },
    });
    expect(events[2]).toMatchObject({ monotonicMs: 115, volume: 128, rampMs: 250 });
    expect(JSON.parse(trace.exportJson()).events).toHaveLength(3);
  });

  it("delegates resume and disposal exactly once", async () => {
    const clock = new ManualDirectorAudioClock();
    const trace = new DirectorAudioTraceBuffer(clock);
    trace.setEnabled(true);
    const base = new VirtualAudioBackend();
    const resume = vi.spyOn(base, "resume");
    const dispose = vi.spyOn(base, "dispose");
    const backend = new TracingAudioBackend(base, trace);

    await backend.resume();
    backend.dispose();

    expect(resume).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(trace.snapshot().map((event) => event.operation)).toEqual([
      "resume",
      "resume-complete",
      "dispose",
    ]);
  });
});

function soundEntry(): DirectorSoundEntry {
  const member = new CastMember("hh_soundmachine", 12, 45, "trax_sample_1", "sound", {
    sound: {
      container: "director-snd-pcm",
      codec: "pcm",
      sampleRate: 22_050,
      channels: 1,
      sampleSize: 16,
      sampleCount: 22_050,
      durationMs: 1_000,
      loopStart: null,
      loopEnd: null,
      assetPath: "release331/hh_soundmachine/0045-trax-sample-1.wav",
      assetUrl: "/assets/release331/hh_soundmachine/0045-trax-sample-1.wav",
      assetSha256: "a".repeat(64),
      sourceFourCC: "snd ",
    },
  });
  return {
    source: LingoPropList.fromPairs([]),
    member,
    media: member.sound!,
    startTimeMs: 0,
    endTimeMs: 1_000,
    loopCount: 1,
    loopStartTimeMs: 0,
    loopEndTimeMs: 1_000,
    preloadTimeMs: 0,
  };
}

function playbackRequest(
  entry: DirectorSoundEntry,
  onStarted: () => void,
  onEnded: () => void,
): DirectorSoundPlaybackRequest {
  return {
    channelNumber: 2,
    token: 7,
    entry,
    queuedEntries: [],
    elapsedMs: 125,
    volume: 255,
    pan: 0,
    onStarted,
    onEnded,
    onError: () => {},
    onQueueError: () => {},
  };
}
