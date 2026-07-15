
export type GardeningPhase = "idle" | "move_out" | "compost" | "water" | "harvest" | "return" | "complete" | "failed";

export interface GardeningJobState {
  readonly plantKey: string;
  readonly objectId: number;
  readonly originalX: number;
  readonly originalY: number;
  readonly originalDirection: number;
  readonly workingX: number;
  readonly workingY: number;
  readonly phase: GardeningPhase;
  readonly mode: "cycle" | "compost";
  readonly queue: readonly string[];
  readonly sentAt: number;
  readonly moveAttempts: number;
  readonly actionAttempts: number;
  readonly completed: number;
  readonly note: string;
  readonly baselineState: string;
}
