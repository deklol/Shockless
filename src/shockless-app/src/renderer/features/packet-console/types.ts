export interface PacketConsoleEntry {
  readonly id: string;
  readonly time: string;
  readonly kind: "command" | "success" | "warning" | "error" | "info";
  readonly text: string;
}
