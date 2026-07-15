export type CommandStatus = "ready" | "mapped" | "blocked";

export type CommandRisk = "read-only" | "source-routed-action" | "automation" | "advanced";

export type CommandRouteKind =
  | "local-shell"
  | "shockless-webcontents"
  | "shockless-dev-api"
  | "habbpy-v3-port"
  | "blocked";

export interface CommandRoute {
  readonly kind: CommandRouteKind;
  readonly sourcePaths: readonly string[];
  readonly notes?: string;
}

export interface CommandDefinition {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly summary: string;
  readonly status: CommandStatus;
  readonly risk: CommandRisk;
  readonly route: CommandRoute;
}
