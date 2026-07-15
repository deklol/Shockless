export type DirectorSoundCodec = "mp3" | "pcm";

/** Extracted media facts for one Director sound cast member. */
export interface DirectorSoundMedia {
  container: string;
  codec: DirectorSoundCodec;
  sampleRate: number;
  channels: number;
  /** Source PCM depth when the Director resource records it. MP3/ediM media
   * does not expose a trustworthy original depth, so that case stays null. */
  sampleSize: number | null;
  sampleCount: number;
  durationMs: number;
  loopStart: number | null;
  loopEnd: number | null;
  assetPath: string;
  assetUrl: string;
  assetSha256: string;
  /** Original Director resource container identity from the KEY graph. */
  sourceFourCC?: "ediM" | "snd ";
}

export interface DirectorSoundManifestMedia extends Omit<DirectorSoundMedia, "assetUrl"> {
  assetUrl?: string;
}
