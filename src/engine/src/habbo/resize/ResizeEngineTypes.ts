/** Public diagnostics emitted by the optional resize presentation subsystem. */
export interface ResizeEngineAnchor {
  readonly id: string;
  readonly kind: "stage" | "manager" | "window" | "visualizer" | "sprite" | "room";
  readonly action: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly note?: string;
}

export interface ResizeEngineSnapshot {
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly anchors: ResizeEngineAnchor[];
  readonly errors: string[];
}
