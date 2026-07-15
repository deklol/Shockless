export type PacketInjectionCommand =
  | { readonly ok: true; readonly target: "server" | "client"; readonly packetText: string }
  | { readonly ok: false; readonly message: string };

/** Parses raw packet console aliases without tokenizing or truncating packet data. */
export function parsePacketInjectionCommand(input: string): PacketInjectionCommand {
  const normalized = input.trim().replace(/^\//, "").replace(/^@\S+\s+/, "");
  const match = /^(?:inject|sendpacket|rawpacket)\s+(server|client)\s+([\s\S]+)$/i.exec(normalized);
  if (!match) return { ok: false, message: "usage: inject server|client <packet>" };
  const packetText = match[2]!.trim();
  if (!packetText) return { ok: false, message: "Packet input is empty." };
  return {
    ok: true,
    target: match[1]!.toLowerCase() as "server" | "client",
    packetText,
  };
}
