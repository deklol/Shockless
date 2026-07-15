import { ScriptInstance } from "./Runtime";
import * as ops from "./ops";
import { LINGO_VOID, LingoObjectLike, LingoPropList, LingoSymbol, LingoValue } from "./values";
import { latin1BytesFromString, stringFromLatin1Bytes } from "./byteStrings";
import { decodeMusMessages, encodeMusLogonMessage, encodeMusMessage } from "./mus";

export { latin1BytesFromString, stringFromLatin1Bytes } from "./byteStrings";
export { decodeMusMessages, decodeMusPropList, encodeMusLogonMessage, encodeMusMessage, MUS_TYPES, type DecodedMusMessage } from "./mus";

const ORIGINS_MACHINE_ID_STORAGE_KEY = "director.origins.machineId";
const ORIGINS_MACHINE_ID_PATTERN = /^BX1(?:-[A-Z0-9]{4}){5}$/;
let fallbackMachineId: string | undefined;

export interface DirectorWebSocketLike {
  binaryType?: BinaryType;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void;
}

export type DirectorWebSocketFactory = (url: string) => DirectorWebSocketLike;

export interface DirectorNetworkBridgeOptions {
  readonly enabled?: boolean;
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly secure?: boolean;
  readonly defaultPort?: number;
  readonly webSocketFactory?: DirectorWebSocketFactory;
  readonly bobbaPublicKey?: string;
  readonly tracePackets?: boolean;
  readonly release306VersionCheckBuild?: number;
  readonly release306VersionCheckClientType?: string;
  readonly release306VersionCheckExternalVariablesUrl?: string;
  readonly machineId?: string;
  readonly onConnect?: () => void;
  readonly beforeMessage?: () => void;
}

export interface DirectorNetworkHost {
  readonly bridgeUrl: string;
  createXtra(name: string): LingoValue | undefined;
  createXtraInstance(ref: LingoValue): LingoValue | undefined;
  callMethod(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue | undefined;
}

export function createDirectorNetworkHost(
  options: DirectorNetworkBridgeOptions | undefined,
  invokeHandler: (target: ScriptInstance, handlerName: string) => void,
  log: (message: string) => void = () => {},
): DirectorNetworkHost {
  const normalized = normalizeNetworkOptions(options);
  return new DirectorNetworkHostImpl(normalized, invokeHandler, log);
}

export function resolveBridgeUrl(options: DirectorNetworkBridgeOptions | undefined = {}): string {
  const params = currentSearchParams();
  const serverWs = params.get("serverWs")?.trim();
  if (serverWs) {
    return serverWs;
  }
  if (options.url && options.url.trim().length > 0) {
    return options.url.trim();
  }

  const loc = currentLocation();
  const secure = options.secure ?? loc.protocol === "https:";
  const protocol = secure ? "wss" : "ws";
  const host =
    options.host ??
    params.get("bridgeHost")?.trim() ??
    params.get("serverWsHost")?.trim() ??
    loc.hostname ??
    "127.0.0.1";
  const port =
    options.port ??
    parsePort(params.get("bridgePort")) ??
    parsePort(params.get("serverWsPort")) ??
    options.defaultPort ??
    12326;

  return `${protocol}://${host}:${port}`;
}

export function formatOutgoingPacketTrace(payload: string): string {
  if (payload.length < 5) {
    return `[packet out] rawLen=${payload.length}`;
  }
  const length =
    ((payload.charCodeAt(0) & 63) * 4096) +
    ((payload.charCodeAt(1) & 63) * 64) +
    (payload.charCodeAt(2) & 63);
  const commandId = ((payload.charCodeAt(3) & 63) * 64) + (payload.charCodeAt(4) & 63);
  const commandName = release306OutgoingCommandName(commandId);
  const paramText = outgoingPacketParamTrace(commandId, payload.slice(5));
  return `[packet out] id=${commandId}${commandName ? ` ${commandName}` : ""} len=${length} rawLen=${payload.length}${paramText}`;
}

export function formatIncomingPacketTrace(payload: string): string {
  if (payload.length < 3) {
    return `[packet in] rawLen=${payload.length}`;
  }
  const commandId = ((payload.charCodeAt(0) & 63) * 64) + (payload.charCodeAt(1) & 63);
  const terminator = payload.indexOf(String.fromCharCode(1), 2);
  const length = terminator >= 0 ? terminator + 1 : payload.length;
  const sample = payload
    .slice(2, Math.min(length, 180))
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\x01/g, "\\x01");
  return `[packet in] id=${commandId} len=${length} rawLen=${payload.length} sample=${sample}`;
}

function release306OutgoingCommandName(commandId: number): string | null {
  switch (commandId) {
    case 2:
      return "ROOM_DIRECTORY";
    case 4:
      return "TRY_LOGIN";
    case 5:
      return "VERSIONCHECK";
    case 6:
      return "UNIQUEID";
    case 7:
      return "GET_CREDITS";
    case 11:
      return "GETAVAILABLESETS";
    case 21:
      return "GETFLATINFO";
    case 59:
      return "GOTOFLAT";
    case 60:
      return "G_HMAP";
    case 61:
      return "G_USRS";
    case 62:
      return "G_OBJS";
    case 64:
      return "G_STAT";
    case 88:
      return "STOP";
    case 126:
      return "GETROOMAD";
    case 150:
      return "NAVIGATE";
    case 151:
      return "GETUSERFLATCATS";
    case 157:
      return "GET_USER_HABBOCLUB";
    case 181:
      return "GET_SESSION_PARAMETERS";
    case 182:
      return "GETINTERST";
    case 191:
      return "GET_FRIEND_REQUESTS";
    case 196:
      return "PONG";
    case 202:
      return "GENERATEKEY";
    case 206:
      return "INIT_CRYPTO";
    default:
      return null;
  }
}

function decodeStringParamLengths(body: string): number[] {
  const lengths: number[] = [];
  let offset = 0;
  while (offset + 2 <= body.length) {
    const length = ((body.charCodeAt(offset) & 63) * 64) + (body.charCodeAt(offset + 1) & 63);
    if (offset + 2 + length > body.length) {
      break;
    }
    lengths.push(length);
    offset += 2 + length;
  }
  return lengths;
}

export function encodeHabboBase64(value: number, width: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Base64 value must be a non-negative integer: ${value}`);
  }
  let remaining = value;
  const chars = new Array<string>(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    chars[index] = String.fromCharCode(64 + (remaining & 0x3f));
    remaining = Math.floor(remaining / 64);
  }
  if (remaining > 0) {
    throw new Error(`Base64 value ${value} does not fit in ${width} bytes`);
  }
  return chars.join("");
}

export function decodeHabboBase64(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = value * 64 + (text.charCodeAt(index) & 0x3f);
  }
  return value;
}

export function encodeVl64(value: number): string {
  if (!Number.isInteger(value)) {
    throw new Error(`VL64 value must be an integer: ${value}`);
  }
  const negative = value < 0;
  let remaining = Math.abs(value);
  const bytes: number[] = [64 + (remaining & 0x03)];
  remaining = Math.floor(remaining / 4);
  while (remaining > 0) {
    bytes.push(64 + (remaining & 0x3f));
    remaining = Math.floor(remaining / 64);
  }
  if (bytes.length > 6) {
    throw new Error(`VL64 value uses ${bytes.length} bytes; max supported is 6`);
  }
  bytes[0] = bytes[0]! | (bytes.length << 3) | (negative ? 0x04 : 0);
  return String.fromCharCode(...bytes);
}

export function decodeVl64Text(text: string): { value: number; bytesRead: number } {
  const first = text.charCodeAt(0);
  if (!Number.isFinite(first)) {
    throw new Error("Cannot decode empty VL64 input");
  }
  const totalBytes = (first >> 3) & 0x07;
  if (totalBytes <= 0 || totalBytes > 6) {
    throw new Error(`Invalid VL64 byte count: ${totalBytes}`);
  }
  if (text.length < totalBytes) {
    throw new Error(`VL64 input needs ${totalBytes} bytes but only has ${text.length}`);
  }
  let value = first & 0x03;
  let shift = 2;
  for (let index = 1; index < totalBytes; index += 1) {
    value += (text.charCodeAt(index) & 0x3f) * 2 ** shift;
    shift += 6;
  }
  return { value: (first & 0x04) === 0x04 ? -value : value, bytesRead: totalBytes };
}

export function rewriteRelease306VersionCheckPayload(payload: string, build: number | undefined): string {
  if (!build || !Number.isSafeInteger(build) || build <= 0 || payload.length < 5) {
    return payload;
  }
  return rewriteRelease306VersionCheckPacket(payload, { build });
}

export function rewriteRelease306VersionCheckPacket(
  payload: string,
  config: {
    readonly build: number | undefined;
    readonly clientType?: string;
    readonly externalVariablesUrl?: string;
  },
): string {
  const build = config.build;
  if (!build || !Number.isSafeInteger(build) || build <= 0 || payload.length < 2) return payload;
  const rewriteConfig = { ...config, build };

  if (payload.length >= 5) {
    const bodyLength = decodeHabboBase64(payload.slice(0, 3));
    if (payload.length - 3 === bodyLength && decodeHabboBase64(payload.slice(3, 5)) === 5) {
      try {
        const rewrittenBody = rewriteVersionCheckBody(payload.slice(3), rewriteConfig);
        return encodeHabboBase64(rewrittenBody.length, 3) + rewrittenBody;
      } catch {
        return payload;
      }
    }
  }

  if (decodeHabboBase64(payload.slice(0, 2)) === 5) {
    try {
      return rewriteVersionCheckBody(payload, rewriteConfig);
    } catch {
      return payload;
    }
  }

  return payload;
}

function rewriteVersionCheckBody(
  body: string,
  config: {
    readonly build: number;
    readonly clientType?: string;
    readonly externalVariablesUrl?: string;
  },
): string {
  const command = body.slice(0, 2);
  const params = body.slice(2);
  const decodedBuild = decodeVl64Text(params);
  const preservedParams = params.slice(decodedBuild.bytesRead);
  if (config.clientType === undefined && config.externalVariablesUrl === undefined) {
    return command + encodeVl64(config.build) + preservedParams;
  }

  const first = readOutgoingStringParam(preservedParams, 0);
  const second = readOutgoingStringParam(preservedParams, first.offset);
  const clientType = config.clientType ?? first.value;
  const externalVariablesUrl = config.externalVariablesUrl ?? second.value;
  return (
    command +
    encodeVl64(config.build) +
    encodeOutgoingString(clientType) +
    encodeOutgoingString(externalVariablesUrl) +
    preservedParams.slice(second.offset)
  );
}

function encodeOutgoingString(value: string): string {
  return encodeHabboBase64(value.length, 2) + value;
}

function outgoingPacketParamTrace(commandId: number, body: string): string {
  if (commandId === 4) {
    const params = decodeStringParamLengths(body);
    return params.length === 0
      ? ""
      : ` params=${params
          .map((length, index) => (index === 1 ? `string[${index + 1}]=<redacted len=${length}>` : `string[${index + 1}] len=${length}`))
          .join(",")}`;
  }
  if (commandId === 5) {
    try {
      const build = decodeVl64Text(body);
      const first = readOutgoingStringParam(body, build.bytesRead);
      const second = readOutgoingStringParam(body, first.offset);
      return ` params=build=${build.value},clientType=${JSON.stringify(first.value)},externalVariables=${JSON.stringify(second.value)}`;
    } catch {
      return "";
    }
  }
  if (commandId === 6) {
    try {
      const uniqueId = readOutgoingStringParam(body, 0);
      return ` params=machineIdLen=${uniqueId.value.length},machineIdPrefix=${JSON.stringify(uniqueId.value.slice(0, 4))}`;
    } catch {
      return "";
    }
  }
  return "";
}

function readOutgoingStringParam(body: string, offset: number): { value: string; offset: number } {
  if (offset + 2 > body.length) throw new Error("Missing outgoing string length");
  const length = decodeHabboBase64(body.slice(offset, offset + 2));
  const start = offset + 2;
  const end = start + length;
  if (end > body.length) throw new Error("Outgoing string exceeds packet body");
  return { value: body.slice(start, end), offset: end };
}

class DirectorNetworkHostImpl implements DirectorNetworkHost {
  readonly bridgeUrl: string;
  private readonly loginIdentifierState = new Release306LoginIdentifierState();

  constructor(
    private readonly options: RequiredNormalizedNetworkOptions,
    private readonly invokeHandler: (target: ScriptInstance, handlerName: string) => void,
    private readonly log: (message: string) => void,
  ) {
    this.bridgeUrl = options.url;
  }

  createXtra(name: string): LingoValue | undefined {
    const key = name.toLowerCase();
    if (key === "multiuser") {
      return new MultiuserXtraRef();
    }
    if (key === "bobbaxtra") {
      return new RelayTerminatedBobbaXtraRef();
    }
    return undefined;
  }

  createXtraInstance(ref: LingoValue): LingoValue | undefined {
    if (ref instanceof MultiuserXtraRef) {
      return new MultiuserXtraInstance(this.options, this.loginIdentifierState, this.invokeHandler, this.log);
    }
    if (ref instanceof RelayTerminatedBobbaXtraRef) {
      return new RelayTerminatedBobbaXtra(this.options.bobbaPublicKey, this.options.machineId);
    }
    return undefined;
  }

  callMethod(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue | undefined {
    if (receiver instanceof MultiuserXtraInstance) {
      return receiver.callMethod(method, args);
    }
    if (receiver instanceof RelayTerminatedBobbaXtra) {
      return receiver.callMethod(method, args);
    }
    return undefined;
  }
}

class Release306LoginIdentifierState {
  private reusableIdentifier: { identifier: string; passwordLength: number | null } | undefined;

  rewriteTryLoginPayload(payload: string): { payload: string; rewritten: boolean; fromLength?: number; toLength?: number } {
    const parsed = parseRelease306TryLoginPayload(payload);
    if (!parsed) {
      return { payload, rewritten: false };
    }

    const identifier = parsed.identifier.value;
    const passwordLength = parsed.password?.value.length ?? null;
    if (isReusableLoginIdentifier(identifier)) {
      this.reusableIdentifier = { identifier, passwordLength };
      return { payload, rewritten: false };
    }

    const reusable = this.reusableIdentifier;
    if (!reusable || reusable.identifier === identifier || !shouldReuseLoginIdentifier(reusable, identifier, passwordLength)) {
      return { payload, rewritten: false };
    }

    return {
      payload: replaceRelease306TryLoginIdentifier(payload, parsed, reusable.identifier),
      rewritten: true,
      fromLength: identifier.length,
      toLength: reusable.identifier.length,
    };
  }
}

type OutgoingStringParam = { value: string; offset: number; valueStart: number };

type ParsedTryLoginPayload = {
  readonly bodyStart: number;
  readonly bodyLength: number;
  readonly identifier: OutgoingStringParam;
  readonly password?: OutgoingStringParam;
};

function parseRelease306TryLoginPayload(payload: string): ParsedTryLoginPayload | null {
  if (payload.length < 5) return null;
  let bodyLength: number;
  let commandId: number;
  try {
    bodyLength = decodeHabboBase64(payload.slice(0, 3));
    commandId = decodeHabboBase64(payload.slice(3, 5));
  } catch {
    return null;
  }
  if (payload.length - 3 !== bodyLength || commandId !== 4) return null;
  try {
    const identifier = readOutgoingStringParamWithStart(payload, 5);
    const password = identifier.offset < payload.length ? readOutgoingStringParamWithStart(payload, identifier.offset) : undefined;
    return { bodyStart: 3, bodyLength, identifier, ...(password ? { password } : {}) };
  } catch {
    return null;
  }
}

function readOutgoingStringParamWithStart(body: string, offset: number): OutgoingStringParam {
  const param = readOutgoingStringParam(body, offset);
  return { ...param, valueStart: offset + 2 };
}

function replaceRelease306TryLoginIdentifier(
  payload: string,
  parsed: ParsedTryLoginPayload,
  identifier: string,
): string {
  const body =
    payload.slice(parsed.bodyStart, parsed.identifier.valueStart - 2) +
    encodeOutgoingString(identifier) +
    payload.slice(parsed.identifier.offset);
  return encodeHabboBase64(body.length, 3) + body;
}

function isReusableLoginIdentifier(identifier: string): boolean {
  const trimmed = identifier.trim();
  return trimmed.length > 0 && trimmed.includes("@");
}

function shouldReuseLoginIdentifier(
  reusable: { identifier: string; passwordLength: number | null },
  candidate: string,
  passwordLength: number | null,
): boolean {
  if (candidate.trim().length === 0 || candidate.includes("@")) return false;
  if (reusable.passwordLength !== null && passwordLength !== null && reusable.passwordLength !== passwordLength) return false;
  return true;
}

type MultiuserConnectTarget = {
  readonly host: string;
  readonly port: number;
};

function connectTargetFromArgs(args: LingoValue[]): MultiuserConnectTarget | null {
  const host = ops.stringOf(args[2] ?? "").trim();
  const port = parsePortFromValue(args[3]);
  if (!host || host === "*" || !port) return null;
  return { host, port };
}

function shouldUseMusBridge(target: MultiuserConnectTarget | null): boolean {
  if (!target) return false;
  const params = currentSearchParams();
  const gameHost =
    params.get("connection.info.host")?.trim() ??
    params.get("connectionHost")?.trim() ??
    params.get("gameHost")?.trim() ??
    params.get("tcpHost")?.trim() ??
    "game-ous.habbo.com";
  const gamePort =
    parsePort(params.get("connection.info.port")) ??
    parsePort(params.get("connectionPort")) ??
    parsePort(params.get("gamePort")) ??
    parsePort(params.get("tcpPort")) ??
    40001;
  return target.host.toLowerCase() !== gameHost.toLowerCase() || target.port !== gamePort;
}

function isGameConnectionFlag(value: LingoValue): boolean {
  if (value === LINGO_VOID) return false;
  if (typeof value === "number") return value !== 0;
  return ops.stringOf(value).trim() === "1";
}

function resolveRawBridgeUrl(baseUrl: string, target: MultiuserConnectTarget): string {
  const url = new URL(baseUrl);
  url.searchParams.set("mode", "raw");
  url.searchParams.set("targetHost", target.host);
  url.searchParams.set("targetPort", String(target.port));
  return url.toString();
}

class MultiuserXtraRef implements LingoObjectLike {
  readonly lingoType = "xtraRef";

  lingoToString(): string {
    return `xtra("Multiuser")`;
  }
}

class MultiuserXtraInstance implements LingoObjectLike {
  readonly lingoType = "xtra";
  private socket: DirectorWebSocketLike | undefined;
  private handlerName: string | undefined;
  private handlerTarget: ScriptInstance | undefined;
  private readonly messages: LingoPropList[] = [];
  private bridgeMode: "game" | "mus" = "game";
  private musReceiveBuffer = new Uint8Array();

  constructor(
    private readonly options: RequiredNormalizedNetworkOptions,
    private readonly loginIdentifierState: Release306LoginIdentifierState,
    private readonly invokeHandler: (target: ScriptInstance, handlerName: string) => void,
    private readonly log: (message: string) => void,
  ) {}

  lingoToString(): string {
    return `<Multiuser Xtra ${this.options.url}>`;
  }

  callMethod(method: string, args: LingoValue[]): LingoValue {
    switch (method.toLowerCase()) {
      case "setnetbufferlimits":
        return 1;
      case "setnetmessagehandler":
        return this.setNetMessageHandler(args[0] ?? LINGO_VOID, args[1] ?? LINGO_VOID);
      case "connecttonetserver":
        return this.connectToNetServer(args);
      case "sendnetmessage":
        return this.sendNetMessage(args[0] ?? LINGO_VOID, args[1] ?? LINGO_VOID, args[2] ?? LINGO_VOID);
      case "getnetmessage":
        return this.messages.shift() ?? LINGO_VOID;
      case "getnumberwaitingnetmessages":
        return this.messages.length;
      case "checknetmessages":
        return this.checkNetMessages(Number(args[0] ?? 1) || 1);
      default:
        return LINGO_VOID;
    }
  }

  private setNetMessageHandler(handler: LingoValue, target: LingoValue): number {
    if (handler === LINGO_VOID || target === LINGO_VOID) {
      this.handlerName = undefined;
      this.handlerTarget = undefined;
      return 0;
    }
    if (!(target instanceof ScriptInstance)) {
      return 1;
    }

    this.handlerName = handler instanceof LingoSymbol ? handler.name : ops.stringOf(handler);
    this.handlerTarget = target;
    return 0;
  }

  private connectToNetServer(args: LingoValue[] = []): number {
    if (!this.options.enabled) {
      this.log(`network bridge disabled for ${this.options.url}`);
      return 1;
    }
    if (this.socket && (this.socket.readyState === WebSocketReadyState.Open || this.socket.readyState === WebSocketReadyState.Connecting)) {
      return 1;
    }

    const target = connectTargetFromArgs(args);
    this.bridgeMode = isGameConnectionFlag(args[5] ?? LINGO_VOID) || !shouldUseMusBridge(target) ? "game" : "mus";
    this.musReceiveBuffer = new Uint8Array();
    const bridgeUrl = this.bridgeMode === "mus" && target ? resolveRawBridgeUrl(this.options.url, target) : this.options.url;

    let socket: DirectorWebSocketLike;
    try {
      socket = this.options.webSocketFactory(bridgeUrl);
    } catch (error) {
      this.enqueueMessage("error", LINGO_VOID, 1);
      this.triggerHandler();
      this.log(`network bridge unavailable ${bridgeUrl}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      if (!this.targetStillOwnsThisXtra()) {
        this.closeStaleSocket(socket, "open");
        return;
      }
      this.options.onConnect();
      if (this.bridgeMode === "mus") {
        socket.send(encodeMusLogonMessage());
      }
      this.enqueueMessage("ConnectToNetServer", LINGO_VOID, 0);
      this.triggerHandler();
      this.log(`network bridge connected ${bridgeUrl}`);
    });
    socket.addEventListener("message", (event) => {
      void this.readSocketMessage(event.data)
        .then((content) => {
          if (!this.targetStillOwnsThisXtra()) {
            this.closeStaleSocket(socket, "message");
            return;
          }
          if (this.bridgeMode === "mus") {
            const decoded = decodeMusMessages(latin1BytesFromString(content), this.musReceiveBuffer);
            this.musReceiveBuffer = new Uint8Array(decoded.remaining);
            this.options.beforeMessage();
            for (const message of decoded.messages) {
              this.enqueueMessage(message.subject, message.content, message.errorCode);
              this.triggerHandler();
            }
            return;
          }
          if (this.options.tracePackets) {
            let offset = 0;
            while (offset < content.length) {
              const terminator = content.indexOf(String.fromCharCode(1), offset + 2);
              const end = terminator >= 0 ? terminator + 1 : content.length;
              this.log(formatIncomingPacketTrace(content.slice(offset, end)));
              if (terminator < 0) break;
              offset = end;
            }
          }
          this.options.beforeMessage();
          this.enqueueMessage("", content, 0);
          this.triggerHandler();
        })
        .catch((error) => {
          this.log(`network bridge message decode failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
    socket.addEventListener("error", () => {
      if (!this.targetStillOwnsThisXtra()) {
        this.closeStaleSocket(socket, "error");
        return;
      }
      this.enqueueMessage("error", LINGO_VOID, 1);
      this.triggerHandler();
      this.log(`network bridge socket error ${bridgeUrl}`);
    });
    socket.addEventListener("close", () => {
      this.log(`network bridge closed ${bridgeUrl}`);
    });
    return 1;
  }

  private sendNetMessage(_session: LingoValue, subject: LingoValue, content: LingoValue): number {
    if (this.bridgeMode === "mus") {
      const subjectText = subject === LINGO_VOID ? "" : ops.stringOf(subject);
      const contentText = content === LINGO_VOID ? "" : ops.stringOf(content);
      if (contentText.length === 1 && contentText.charCodeAt(0) === 0) {
        this.socket?.close();
        return 1;
      }
      if (!this.socket || this.socket.readyState !== WebSocketReadyState.Open) {
        this.log(`MUS bridge send skipped before open (${subjectText || "message"})`);
        return 0;
      }
      this.socket.send(encodeMusMessage(subjectText || "msg", content));
      return 1;
    }

    const versionCheckedPayload = rewriteRelease306VersionCheckPacket(this.payloadForMessage(subject, content), {
      build: this.options.release306VersionCheckBuild,
      clientType: this.options.release306VersionCheckClientType,
      externalVariablesUrl: this.options.release306VersionCheckExternalVariablesUrl,
    });
    const loginPayload = this.loginIdentifierState.rewriteTryLoginPayload(versionCheckedPayload);
    const payload = loginPayload.payload;
    if (payload.length === 1 && payload.charCodeAt(0) === 0) {
      this.socket?.close();
      return 1;
    }
    if (!this.socket || this.socket.readyState !== WebSocketReadyState.Open) {
      this.log(`network bridge send skipped before open (${payload.length} bytes)`);
      return 0;
    }

    if (this.options.tracePackets) {
      if (loginPayload.rewritten) {
        this.log(
          `network bridge restored login identifier for TRY_LOGIN string[1] len=${loginPayload.fromLength} -> ${loginPayload.toLength}`,
        );
      }
      this.log(formatOutgoingPacketTrace(payload));
    }
    this.socket.send(latin1BytesFromString(payload));
    return 1;
  }

  private payloadForMessage(subject: LingoValue, content: LingoValue): string {
    const body = content === LINGO_VOID ? "" : ops.stringOf(content);
    const subjectText = subject === LINGO_VOID ? "" : ops.stringOf(subject);
    if (subjectText === "" || subjectText === "0") {
      return body;
    }
    if (subjectText === "BINDATA") {
      return body;
    }
    return `${subjectText}\r${body}`;
  }

  private checkNetMessages(count: number): number {
    const targetCount = Math.max(1, Math.trunc(count));
    let handled = 0;
    while (handled < targetCount && this.messages.length > 0) {
      this.triggerHandler();
      handled += 1;
    }
    return handled;
  }

  private enqueueMessage(subject: string, content: LingoValue, errorCode: number): void {
    this.messages.push(
      LingoPropList.fromPairs([
        [LingoSymbol.for("errorCode"), errorCode],
        [LingoSymbol.for("subject"), subject],
        [LingoSymbol.for("content"), content],
      ]),
    );
  }

  private triggerHandler(): void {
    if (!this.handlerTarget || !this.handlerName) {
      return;
    }
    if (!this.targetStillOwnsThisXtra()) {
      return;
    }
    try {
      this.invokeHandler(this.handlerTarget, this.handlerName.toLowerCase());
    } catch (error) {
      this.log(`network handler ${this.handlerName} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private targetStillOwnsThisXtra(): boolean {
    const target = this.handlerTarget;
    if (!target || !target.props.has("pxtra")) {
      return true;
    }
    return target.props.get("pxtra") === this;
  }

  private closeStaleSocket(socket: DirectorWebSocketLike, eventName: string): void {
    this.handlerName = undefined;
    this.handlerTarget = undefined;
    this.messages.length = 0;
    if (this.socket === socket) {
      this.socket = undefined;
    }
    if (socket.readyState !== WebSocketReadyState.Closed && socket.readyState !== WebSocketReadyState.Closing) {
      socket.close();
    }
    this.log(`network bridge ignored stale ${eventName} callback ${this.options.url}`);
  }

  private async readSocketMessage(data: unknown): Promise<string> {
    if (typeof data === "string") {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return stringFromLatin1Bytes(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
      return stringFromLatin1Bytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return stringFromLatin1Bytes(new Uint8Array(await data.arrayBuffer()));
    }
    return "";
  }
}

class RelayTerminatedBobbaXtraRef implements LingoObjectLike {
  readonly lingoType = "xtraRef";

  lingoToString(): string {
    return `xtra("BobbaXtra")`;
  }
}

class RelayTerminatedBobbaXtra implements LingoObjectLike {
  readonly lingoType = "xtra";
  private readonly publicKey: string;
  private readonly machineId: string | undefined;

  constructor(publicKey: string | undefined, machineId: string | undefined) {
    this.publicKey = publicKey && publicKey.length > 0 ? publicKey : "relay-terminated";
    this.machineId = machineId && machineId.length > 0 ? machineId : undefined;
  }

  lingoToString(): string {
    return "<BobbaXtra relay-terminated>";
  }

  callMethod(method: string, args: LingoValue[]): LingoValue {
    switch (method.toLowerCase()) {
      case "device_getmachineid":
        return stableOriginsMachineId(this.machineId);
      case "crypto_reset":
        return 1;
      case "crypto_generatepublickey":
        return this.publicKey;
      case "crypto_setserverpublickey":
        return ops.stringOf(args[0] ?? LINGO_VOID).length > 0 ? 1 : 0;
      case "crypto_isready":
        return 0;
      case "crypto_encryptpayload":
      case "crypto_decryptpayload":
        return args[0] ?? "";
      case "crypto_encryptheader": {
        const header = ops.stringOf(args[0] ?? "");
        return header.length >= 4 ? header.slice(1, 4) : header;
      }
      case "crypto_decryptheader":
        return args[0] ?? "";
      default:
        return LINGO_VOID;
    }
  }
}

function stableOriginsMachineId(override: string | undefined): string {
  if (override && override.length > 0) return override;
  const stored = readStoredMachineId();
  if (stored) return stored;

  const generated = fallbackMachineId ?? generateOriginsMachineId();
  fallbackMachineId = generated;
  writeStoredMachineId(generated);
  return generated;
}

function readStoredMachineId(): string | undefined {
  const storage = machineIdStorage();
  if (!storage) return fallbackMachineId;
  const stored = storage.getItem(ORIGINS_MACHINE_ID_STORAGE_KEY);
  if (stored && ORIGINS_MACHINE_ID_PATTERN.test(stored)) {
    fallbackMachineId = stored;
    return stored;
  }
  return fallbackMachineId;
}

function writeStoredMachineId(machineId: string): void {
  const storage = machineIdStorage();
  if (!storage) return;
  storage.setItem(ORIGINS_MACHINE_ID_STORAGE_KEY, machineId);
}

function generateOriginsMachineId(): string {
  return `BX1-${machineIdGroup()}-${machineIdGroup()}-${machineIdGroup()}-${machineIdGroup()}-${machineIdGroup()}`;
}

function machineIdGroup(): string {
  let group = "";
  for (let index = 0; index < 4; index += 1) {
    group += randomMachineIdCharacter();
  }
  return group;
}

function randomMachineIdCharacter(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return alphabet[randomMachineIdInt(alphabet.length)]!;
}

function randomMachineIdInt(maxExclusive: number): number {
  const cryptoObject = (globalThis as typeof globalThis & {
    crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array };
  }).crypto;
  if (cryptoObject?.getRandomValues) {
    const value = new Uint32Array(1);
    cryptoObject.getRandomValues(value);
    return value[0]! % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function machineIdStorage():
  | { getItem(key: string): string | null; setItem(key: string, value: string): void }
  | undefined {
  const globalWithStorage = globalThis as typeof globalThis & {
    localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  };
  return globalWithStorage.localStorage;
}

interface RequiredNormalizedNetworkOptions {
  readonly enabled: boolean;
  readonly url: string;
  readonly webSocketFactory: DirectorWebSocketFactory;
  readonly bobbaPublicKey?: string;
  readonly tracePackets: boolean;
  readonly release306VersionCheckBuild?: number;
  readonly release306VersionCheckClientType?: string;
  readonly release306VersionCheckExternalVariablesUrl?: string;
  readonly machineId?: string;
  readonly onConnect: () => void;
  readonly beforeMessage: () => void;
}

const WebSocketReadyState = {
  Connecting: 0,
  Open: 1,
  Closing: 2,
  Closed: 3,
} as const;

function normalizeNetworkOptions(options: DirectorNetworkBridgeOptions | undefined): RequiredNormalizedNetworkOptions {
  return {
    enabled: options?.enabled ?? true,
    url: resolveBridgeUrl(options),
    webSocketFactory: options?.webSocketFactory ?? defaultWebSocketFactory,
    tracePackets: options?.tracePackets ?? currentSearchParams().get("tracePackets") === "1",
    onConnect: options?.onConnect ?? (() => {}),
    beforeMessage: options?.beforeMessage ?? (() => {}),
    ...(options?.bobbaPublicKey !== undefined ? { bobbaPublicKey: options.bobbaPublicKey } : {}),
    ...(options?.release306VersionCheckBuild !== undefined
      ? { release306VersionCheckBuild: options.release306VersionCheckBuild }
      : {}),
    ...(options?.release306VersionCheckClientType !== undefined
      ? { release306VersionCheckClientType: options.release306VersionCheckClientType }
      : {}),
    ...(options?.release306VersionCheckExternalVariablesUrl !== undefined
      ? { release306VersionCheckExternalVariablesUrl: options.release306VersionCheckExternalVariablesUrl }
      : {}),
    ...(options?.machineId !== undefined ? { machineId: options.machineId } : {}),
  };
}

function defaultWebSocketFactory(url: string): DirectorWebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new WebSocketCtor(url) as DirectorWebSocketLike;
}

function currentSearchParams(): URLSearchParams {
  const loc = currentLocation();
  return new URLSearchParams(loc.search ?? "");
}

function currentLocation(): { protocol?: string; hostname?: string; search?: string } {
  return typeof globalThis.location === "object" && globalThis.location !== null ? globalThis.location : {};
}

function parsePort(value: string | null | undefined): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function parsePortFromValue(value: LingoValue | undefined): number | undefined {
  if (value === undefined || value === LINGO_VOID) return undefined;
  const port = typeof value === "number" ? value : Number.parseInt(ops.stringOf(value), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}
