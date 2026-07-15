import type { StagePoint } from "../room/wallPlacement";

export interface PendingStageClickRequest {
  readonly pluginId: string;
  readonly createdAt: number;
  readonly resolve: (point: StagePoint & { readonly clientId: number }) => void;
  readonly reject: (error: Error) => void;
  timeout: number | null;
}
