import type { PluginPermission } from "./plugin.js";

export type PluginRelayDirection = "client" | "server";

export interface PluginRelayGrant {
  readonly pluginId: string;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginRelayPolicy {
  readonly version: 1;
  readonly generatedAt: string;
  readonly grants: readonly PluginRelayGrant[];
  readonly sensitiveClientHeaders: readonly number[];
}

export interface PluginRelayPacketContext {
  readonly direction: PluginRelayDirection;
  readonly header: number;
}

export interface PluginRelayDecision {
  readonly allowed: boolean;
  readonly sensitive: boolean;
  readonly readPluginIds: readonly string[];
  readonly interceptPluginIds: readonly string[];
  readonly injectPluginIds: readonly string[];
  readonly reason: string | null;
}

const DEFAULT_SENSITIVE_CLIENT_HEADERS: readonly number[] = [4, 6, 202];

export function defaultSensitiveClientHeaders(): readonly number[] {
  return DEFAULT_SENSITIVE_CLIENT_HEADERS;
}

export function emptyPluginRelayPolicy(): PluginRelayPolicy {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    grants: [],
    sensitiveClientHeaders: DEFAULT_SENSITIVE_CLIENT_HEADERS,
  };
}

export function normalizePluginRelayPolicy(value: unknown): PluginRelayPolicy {
  if (!value || typeof value !== "object") return emptyPluginRelayPolicy();
  const record = value as Partial<PluginRelayPolicy>;
  const sensitiveClientHeaders = cleanHeaderList(record.sensitiveClientHeaders);
  return {
    version: 1,
    generatedAt: typeof record.generatedAt === "string" && record.generatedAt ? record.generatedAt : new Date(0).toISOString(),
    grants: Array.isArray(record.grants) ? record.grants.map(normalizeGrant).filter((grant): grant is PluginRelayGrant => Boolean(grant)) : [],
    sensitiveClientHeaders: sensitiveClientHeaders.length > 0 ? sensitiveClientHeaders : DEFAULT_SENSITIVE_CLIENT_HEADERS,
  };
}

export function decidePluginRelayPacket(policy: PluginRelayPolicy | null | undefined, packet: PluginRelayPacketContext): PluginRelayDecision {
  const normalized = normalizePluginRelayPolicy(policy);
  const sensitive = isSensitivePluginRelayPacket(packet, normalized.sensitiveClientHeaders);
  const usableGrants = normalized.grants.filter((grant) => !sensitive || grant.permissions.includes("packet.intercept.sensitive"));
  return {
    allowed: true,
    sensitive,
    readPluginIds: idsWithPermission(usableGrants, "packet.read"),
    interceptPluginIds: idsWithPermission(usableGrants, "packet.intercept"),
    injectPluginIds: idsWithPermission(usableGrants, "packet.inject"),
    reason: sensitive ? "Sensitive packet hidden from plugins without packet.intercept.sensitive." : null,
  };
}

export function isSensitivePluginRelayPacket(packet: PluginRelayPacketContext, sensitiveClientHeaders = DEFAULT_SENSITIVE_CLIENT_HEADERS): boolean {
  return packet.direction === "client" && sensitiveClientHeaders.includes(packet.header);
}

function normalizeGrant(value: unknown): PluginRelayGrant | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PluginRelayGrant>;
  const pluginId = typeof record.pluginId === "string" ? record.pluginId.trim() : "";
  if (!pluginId) return null;
  return {
    pluginId,
    permissions: Array.isArray(record.permissions) ? record.permissions.filter(isPluginPermission) : [],
  };
}

function cleanHeaderList(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 0))];
}

function idsWithPermission(grants: readonly PluginRelayGrant[], permission: PluginPermission): readonly string[] {
  return grants.filter((grant) => grant.permissions.includes(permission)).map((grant) => grant.pluginId);
}

function isPluginPermission(value: unknown): value is PluginPermission {
  return (
    value === "ui.panel" ||
    value === "ui.status" ||
    value === "ui.overlay" ||
    value === "console.commands" ||
    value === "engine.snapshot" ||
    value === "engine.control" ||
    value === "notifications.show" ||
    value === "client.rights" ||
    value === "events.room" ||
    value === "events.chat" ||
    value === "events.packet" ||
    value === "events.session" ||
    value === "actions.avatar" ||
    value === "actions.social" ||
    value === "actions.fishing" ||
    value === "actions.furni" ||
    value === "actions.plants" ||
    value === "actions.wallItems" ||
    value === "chat.send" ||
    value === "storage" ||
    value === "packet.read" ||
    value === "packet.inject" ||
    value === "packet.intercept" ||
    value === "packet.intercept.sensitive"
  );
}
