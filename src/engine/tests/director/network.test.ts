import { describe, expect, it } from "vitest";
import { DirectorMovie, MovieManifest } from "../../src/director/Movie";
import { ScriptInstance } from "../../src/director/Runtime";
import { CastRegistry } from "../../src/director/members";
import {
  decodeHabboBase64,
  decodeMusMessages,
  decodeMusPropList,
  decodeVl64Text,
  encodeHabboBase64,
  encodeMusMessage,
  encodeVl64,
  type DirectorNetworkBridgeOptions,
  type DirectorWebSocketLike,
  formatOutgoingPacketTrace,
  latin1BytesFromString,
  MUS_TYPES,
  rewriteRelease306VersionCheckPayload,
  rewriteRelease306VersionCheckPacket,
  stringFromLatin1Bytes,
} from "../../src/director/network";
import { LingoBitmapMedia } from "../../src/director/imaging";
import { LINGO_VOID, LingoPropList, LingoValue, symbol } from "../../src/director/values";

class FakeSocket implements DirectorWebSocketLike {
  binaryType?: BinaryType;
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (typeof data === "string") {
      this.sent.push(latin1BytesFromString(data));
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else {
      throw new Error("FakeSocket only supports string and binary sends");
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createMovie(
  socketFactory: (url: string) => DirectorWebSocketLike,
  networkOptions: Partial<DirectorNetworkBridgeOptions> = {},
): DirectorMovie {
  const manifest: MovieManifest = {
    stage: { width: 640, height: 480, backgroundColor: "#000000" },
    casts: [],
    score: { frameRate: 12, markers: [], behaviors: [], frames: [] },
  };
  const members = new CastRegistry({ movie: { casts: [] }, textFields: [], bitmaps: [] }, "/assets/");
  return new DirectorMovie(
    manifest,
    { log: () => {} },
    async () => {},
    async () => "",
    members,
    () => {},
    "/origins-data/client/",
    new Map<string, string>(),
    async () => {},
    {
      url: "ws://127.0.0.1:12326",
      webSocketFactory: socketFactory,
      ...networkOptions,
    },
  );
}

function versionCheckPayload(build: number, clientType = "", externalVariables = ""): string {
  const body =
    encodeHabboBase64(5, 2) +
    encodeVl64(build) +
    encodeStringParam(clientType) +
    encodeStringParam(externalVariables);
  return encodeHabboBase64(body.length, 3) + body;
}

function uniqueIdPayload(machineId: string): string {
  const body = encodeHabboBase64(6, 2) + encodeStringParam(machineId);
  return encodeHabboBase64(body.length, 3) + body;
}

function tryLoginPayload(identifier: string, password: string, totp = "", steamId = ""): string {
  const body =
    encodeHabboBase64(4, 2) +
    encodeStringParam(identifier) +
    encodeStringParam(password) +
    encodeStringParam(totp) +
    encodeStringParam(steamId);
  return encodeHabboBase64(body.length, 3) + body;
}

function musBindataPicturePayload(bytes: Uint8Array): Uint8Array {
  const body: number[] = [];
  writeInt32(body, 0);
  writeInt32(body, 0);
  writeEvenString(body, "BINDATA");
  writeEvenString(body, "System");
  writeInt32(body, 1);
  writeEvenString(body, "*");
  writeInt16(body, MUS_TYPES.PropList);
  writeInt32(body, 1);
  writeInt16(body, MUS_TYPES.Symbol);
  writeEvenString(body, "image");
  writeInt16(body, MUS_TYPES.Picture);
  writeInt32(body, bytes.length);
  body.push(...bytes);
  if (bytes.length % 2 !== 0) body.push(0);

  const frame: number[] = [0x72, 0x00];
  writeInt32(frame, body.length);
  frame.push(...body);
  return new Uint8Array(frame);
}

function writeInt16(output: number[], value: number): void {
  output.push((value >>> 8) & 0xff, value & 0xff);
}

function writeInt32(output: number[], value: number): void {
  output.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function writeEvenString(output: number[], value: string): void {
  const bytes = latin1BytesFromString(value);
  writeInt32(output, bytes.length);
  output.push(...bytes);
  if (bytes.length % 2 !== 0) output.push(0);
}

function readVersionCheckBuild(payload: string): number {
  return decodeVl64Text(payload.slice(5)).value;
}

function readVersionCheckParams(payload: string): { build: number; clientType: string; externalVariables: string } {
  const build = decodeVl64Text(payload.slice(5));
  const clientType = readStringParam(payload, 5 + build.bytesRead);
  const externalVariables = readStringParam(payload, clientType.offset);
  return {
    build: build.value,
    clientType: clientType.value,
    externalVariables: externalVariables.value,
  };
}

function readTryLoginIdentifier(payload: string): string {
  return readStringParam(payload, 5).value;
}

function readStringParam(payload: string, offset: number): { value: string; offset: number } {
  const length = decodeHabboBase64(payload.slice(offset, offset + 2));
  const start = offset + 2;
  const end = start + length;
  return { value: payload.slice(start, end), offset: end };
}

function encodeStringParam(value: string): string {
  return encodeHabboBase64(value.length, 2) + value;
}

describe("Director network bridge", () => {
  it("round-trips relay bytes as latin1 strings", () => {
    const text = "\u0000@A\u00ff";
    expect(stringFromLatin1Bytes(latin1BytesFromString(text))).toBe(text);
  });

  it("formats v306 outgoing TRY_LOGIN traces without leaking the password", () => {
    const user = "sample-user";
    const pass = "sampleSecret!";
    const params = `@${String.fromCharCode(64 + user.length)}${user}@${String.fromCharCode(64 + pass.length)}${pass}@@@`;
    const body = `@D${params}`;
    const payload = `@A${String.fromCharCode(64 + body.length)}${body}`;

    expect(formatOutgoingPacketTrace(payload)).toContain("id=4 TRY_LOGIN");
    expect(formatOutgoingPacketTrace(payload)).toContain("string[2]=<redacted len=13>");
    expect(formatOutgoingPacketTrace(payload)).not.toContain(pass);
  });

  it("rewrites release306 VERSIONCHECK build while preserving source-authored string params", () => {
    const original = versionCheckPayload(401, "", "/origins-data/client/external_variables.txt");
    const rewritten = rewriteRelease306VersionCheckPayload(original, 1124);

    expect(readVersionCheckParams(rewritten)).toEqual({
      build: 1124,
      clientType: "",
      externalVariables: "/origins-data/client/external_variables.txt",
    });
    expect(formatOutgoingPacketTrace(rewritten)).toContain("id=5 VERSIONCHECK");
    expect(formatOutgoingPacketTrace(rewritten)).toContain("params=build=1124,clientType=\"\"");
    expect(rewriteRelease306VersionCheckPayload(versionCheckPayload(401).replace("@E", "@D"), 1124)).not.toBe(
      rewritten,
    );
  });

  it("supports explicit VERSIONCHECK client/url overrides", () => {
    const rewritten = rewriteRelease306VersionCheckPacket(versionCheckPayload(401), {
      build: 3180,
      clientType: "3",
      externalVariablesUrl: "https://example.test/external_variables",
    });

    expect(readVersionCheckParams(rewritten)).toEqual({
      build: 3180,
      clientType: "3",
      externalVariables: "https://example.test/external_variables",
    });
  });

  it("delivers plaintext release306 relay frames through Multiuser getNetMessage", async () => {
    let socket: FakeSocket | undefined;
    const movie = createMovie((url) => {
      expect(url).toBe("ws://127.0.0.1:12326");
      socket = new FakeSocket();
      return socket;
    });
    const multiuserRef = movie.runtime.call("xtra", ["Multiuser"]);
    const multiuser = movie.runtime.call("new", [multiuserRef]);
    let lastSubject: LingoValue = LINGO_VOID;
    let lastContent: LingoValue = LINGO_VOID;

    const target = new ScriptInstance({
      scriptName: "Network Target",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        xtramsghandler(ctx) {
          const message = ctx.callMethod(multiuser, "getnetmessage", []);
          lastSubject = ctx.callMethod(message, "getaprop", [symbol("subject")]);
          lastContent = ctx.callMethod(message, "getaprop", [symbol("content")]);
          return 1;
        },
      },
    });

    expect(movie.callMethod(multiuser, "setnetmessagehandler", [symbol("xtraMsgHandler"), target])).toBe(0);
    expect(movie.callMethod(multiuser, "connecttonetserver", ["*", "*", "game-ous.habbo.com", 40001, "*", 1])).toBe(1);
    socket!.open();
    expect(lastSubject).toBe("ConnectToNetServer");
    expect(lastContent).toBe(LINGO_VOID);

    socket!.message(new Uint8Array([64, 65, 1]).buffer);
    await Promise.resolve();
    expect(lastContent).toBe("@A\u0001");

    expect(movie.callMethod(multiuser, "sendnetmessage", [0, 0, "@Chello"])).toBe(1);
    expect([...socket!.sent[0]!]).toEqual([64, 67, 104, 101, 108, 108, 111]);
  });

  it("routes MUS connections through the raw bridge and frames text messages", async () => {
    let socket: FakeSocket | undefined;
    const movie = createMovie((url) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("mode")).toBe("raw");
      expect(parsed.searchParams.get("targetHost")).toBe("mus-ous.habbo.com");
      expect(parsed.searchParams.get("targetPort")).toBe("30001");
      socket = new FakeSocket();
      return socket;
    });
    const multiuser = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    let lastSubject: LingoValue = LINGO_VOID;
    let lastContent: LingoValue = LINGO_VOID;

    const target = new ScriptInstance({
      scriptName: "MUS Target",
      scriptType: "parent",
      scriptProperties: [],
      scriptGlobals: [],
      handlers: {
        xtramsghandler(ctx) {
          const message = ctx.callMethod(multiuser, "getnetmessage", []);
          lastSubject = ctx.callMethod(message, "getaprop", [symbol("subject")]);
          lastContent = ctx.callMethod(message, "getaprop", [symbol("content")]);
          return 1;
        },
      },
    });

    expect(movie.callMethod(multiuser, "setnetmessagehandler", [symbol("xtraMsgHandler"), target])).toBe(0);
    expect(movie.callMethod(multiuser, "connecttonetserver", ["*", "*", "mus-ous.habbo.com", 30001, "*", 0])).toBe(1);
    socket!.open();
    expect(lastSubject).toBe("ConnectToNetServer");

    const logon = decodeMusMessages(socket!.sent[0]!);
    expect(logon.messages[0]?.subject).toBe("Logon");

    expect(movie.callMethod(multiuser, "sendnetmessage", ["*", "PHOTOTXT", "/hello"])).toBe(1);
    const sent = decodeMusMessages(socket!.sent[1]!);
    expect(sent.messages[0]?.subject).toBe("PHOTOTXT");
    expect(sent.messages[0]?.content).toBe("/hello");

    socket!.message(encodeMusMessage("BINDATA_SAVED", "123"));
    await Promise.resolve();
    expect(lastSubject).toBe("BINDATA_SAVED");
    expect(lastContent).toBe("123");
  });

  it("encodes MUS BINDATA property lists with media bytes", () => {
    const media = new LingoBitmapMedia(new Uint8Array([1, 2, 3]));
    const payload = LingoPropList.fromPairs([
      [symbol("image"), media],
      [symbol("time"), "1/1/2026 12:00"],
      [symbol("cs"), 42],
      [symbol("preset"), 1],
    ]);
    const decoded = decodeMusMessages(encodeMusMessage("BINDATA", payload)).messages[0]?.content;

    expect(decoded).toBeInstanceOf(LingoPropList);
    const list = decoded as LingoPropList;
    expect(list.values[0]).toBeInstanceOf(LingoBitmapMedia);
    expect([...(list.values[0] as LingoBitmapMedia).bytes]).toEqual([1, 2, 3]);
    expect(list.values[2]).toBe(42);
  });

  it("decodes MUS Picture values as bitmap media for retrieved photo BINDATA", () => {
    const decoded = decodeMusMessages(musBindataPicturePayload(new Uint8Array([4, 5, 6, 7]))).messages[0]?.content;

    expect(decoded).toBeInstanceOf(LingoPropList);
    const list = decoded as LingoPropList;
    expect(list.keys[0]).toBe(symbol("image"));
    expect(list.values[0]).toBeInstanceOf(LingoBitmapMedia);
    expect([...(list.values[0] as LingoBitmapMedia).bytes]).toEqual([4, 5, 6, 7]);
  });

  it("keeps flagged game connections on the framed bridge even for custom hosts", () => {
    const seenUrls: string[] = [];
    const movie = createMovie((url) => {
      seenUrls.push(url);
      return new FakeSocket();
    });
    const multiuser = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);

    expect(movie.callMethod(multiuser, "connecttonetserver", ["*", "*", "127.0.0.1", 31000, "*", 1])).toBe(1);

    expect(seenUrls).toEqual(["ws://127.0.0.1:12326"]);
  });

  it("ignores stale Multiuser callbacks after a source connection replaces pXtra", () => {
    const sockets: FakeSocket[] = [];
    const movie = createMovie(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const oldMultiuser = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    const currentMultiuser = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    let handlerCalls = 0;
    let lastSubject: LingoValue = LINGO_VOID;

    const target = new ScriptInstance({
      scriptName: "Connection Instance Class",
      scriptType: "parent",
      scriptProperties: ["pXtra"],
      scriptGlobals: [],
      handlers: {
        xtramsghandler(ctx) {
          handlerCalls += 1;
          const message = ctx.callMethod(currentMultiuser, "getnetmessage", []);
          lastSubject = ctx.callMethod(message, "getaprop", [symbol("subject")]);
          return 1;
        },
      },
    });
    target.props.set("pxtra", currentMultiuser);

    expect(movie.callMethod(oldMultiuser, "setnetmessagehandler", [symbol("xtraMsgHandler"), target])).toBe(0);
    expect(movie.callMethod(oldMultiuser, "connecttonetserver", ["*", "*", "game-ous.habbo.com", 40001, "*", 1])).toBe(1);
    sockets[0]!.open();
    expect(handlerCalls).toBe(0);
    expect(sockets[0]!.readyState).toBe(3);

    expect(movie.callMethod(currentMultiuser, "setnetmessagehandler", [symbol("xtraMsgHandler"), target])).toBe(0);
    expect(movie.callMethod(currentMultiuser, "connecttonetserver", ["*", "*", "game-ous.habbo.com", 40001, "*", 1])).toBe(1);
    sockets[1]!.open();
    expect(handlerCalls).toBe(1);
    expect(lastSubject).toBe("ConnectToNetServer");
  });

  it("sends hardcoded source VERSIONCHECK packets with the configured bypass build", () => {
    let socket: FakeSocket | undefined;
    const movie = createMovie(() => {
      socket = new FakeSocket();
      return socket;
    }, { release306VersionCheckBuild: 1124 });
    const multiuserRef = movie.runtime.call("xtra", ["Multiuser"]);
    const multiuser = movie.runtime.call("new", [multiuserRef]);

    expect(movie.callMethod(multiuser, "connecttonetserver", ["*", "*", "game-ous.habbo.com", 40001, "*", 1])).toBe(1);
    socket!.open();
    expect(movie.callMethod(multiuser, "sendnetmessage", [0, 0, versionCheckPayload(401)])).toBe(1);

    const sent = stringFromLatin1Bytes(socket!.sent[0]!);
    expect(readVersionCheckParams(sent)).toEqual({
      build: 1124,
      clientType: "",
      externalVariables: "",
    });
  });

  it("reuses the authenticated login identifier when room relogin tries to send the avatar name", () => {
    const sockets: FakeSocket[] = [];
    const movie = createMovie(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const first = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    const second = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);

    expect(movie.callMethod(first, "connecttonetserver", [])).toBe(1);
    sockets[0]!.open();
    expect(movie.callMethod(first, "sendnetmessage", [0, 0, tryLoginPayload("user@example.test", "sampleSecret!")])).toBe(1);

    expect(movie.callMethod(second, "connecttonetserver", [])).toBe(1);
    sockets[1]!.open();
    expect(movie.callMethod(second, "sendnetmessage", [0, 0, tryLoginPayload("dek", "sampleSecret!")])).toBe(1);

    expect(readTryLoginIdentifier(stringFromLatin1Bytes(sockets[0]!.sent[0]!))).toBe("user@example.test");
    expect(readTryLoginIdentifier(stringFromLatin1Bytes(sockets[1]!.sent[0]!))).toBe("user@example.test");
  });

  it("does not replace a later explicit email login", () => {
    const sockets: FakeSocket[] = [];
    const movie = createMovie(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const first = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    const second = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);

    expect(movie.callMethod(first, "connecttonetserver", [])).toBe(1);
    sockets[0]!.open();
    expect(movie.callMethod(first, "sendnetmessage", [0, 0, tryLoginPayload("first@example.test", "sampleSecret!")])).toBe(1);

    expect(movie.callMethod(second, "connecttonetserver", [])).toBe(1);
    sockets[1]!.open();
    expect(movie.callMethod(second, "sendnetmessage", [0, 0, tryLoginPayload("second@example.test", "otherSecret!")])).toBe(1);

    expect(readTryLoginIdentifier(stringFromLatin1Bytes(sockets[1]!.sent[0]!))).toBe("second@example.test");
  });

  it("treats relay Xtra instances as Director objects for generated connection guards", () => {
    const movie = createMovie(() => new FakeSocket());
    const multiuser = movie.runtime.call("new", [movie.runtime.call("xtra", ["Multiuser"])]);
    const bobba = movie.runtime.call("new", [movie.runtime.call("xtra", ["BobbaXtra"])]);

    expect(movie.runtime.call("objectp", [multiuser])).toBe(1);
    expect(movie.runtime.call("objectp", [bobba])).toBe(1);
  });

  it("keeps BobbaXtra relay-terminated so generated connection code stays plaintext", () => {
    const movie = createMovie(() => new FakeSocket());
    const bobbaRef = movie.runtime.call("xtra", ["BobbaXtra"]);
    const bobba = movie.runtime.call("new", [bobbaRef]);

    expect(movie.callMethod(bobba, "crypto_generatepublickey", [])).toBe("relay-terminated");
    expect(movie.callMethod(bobba, "crypto_setserverpublickey", ["12345"])).toBe(1);
    expect(movie.callMethod(bobba, "crypto_isready", [])).toBe(0);
    expect(movie.callMethod(bobba, "crypto_encryptpayload", ["@CPAYLOAD"])).toBe("@CPAYLOAD");
    expect(movie.callMethod(bobba, "crypto_encryptheader", ["X@A@"])).toBe("@A@");
  });

  it("provides a stable BobbaXtra machine id with the original UNIQUEID packet shape", () => {
    const movie = createMovie(() => new FakeSocket());
    const bobbaRef = movie.runtime.call("xtra", ["BobbaXtra"]);
    const firstBobba = movie.runtime.call("new", [bobbaRef]);
    const secondBobba = movie.runtime.call("new", [bobbaRef]);

    const machineId = movie.callMethod(firstBobba, "Device_GetMachineId", []);

    expect(machineId).toMatch(/^BX1(?:-[A-Z0-9]{4}){5}$/);
    expect(movie.callMethod(secondBobba, "device_getmachineid", [])).toBe(machineId);

    const payload = uniqueIdPayload(String(machineId));
    expect(decodeHabboBase64(payload.slice(0, 3))).toBe(32);
    expect(payload.length).toBe(35);
    expect(formatOutgoingPacketTrace(payload)).toContain("id=6 UNIQUEID");
    expect(formatOutgoingPacketTrace(payload)).toContain('machineIdLen=28,machineIdPrefix="BX1-"');
  });

  it("supports a runtime machine id override for standalone parity with the working donor boundary", () => {
    const movie = createMovie(() => new FakeSocket(), { machineId: "director-habbo-runtime" });
    const bobba = movie.runtime.call("new", [movie.runtime.call("xtra", ["BobbaXtra"])]);

    expect(movie.callMethod(bobba, "Device_GetMachineId", [])).toBe("director-habbo-runtime");
  });

  it("keeps incomplete MUS frames buffered without allocating the announced body length", () => {
    const frame = new Uint8Array([0x72, 0x00, 0x7f, 0xff, 0xff, 0xff]);

    const decoded = decodeMusMessages(frame);

    expect(decoded.messages).toEqual([]);
    expect(decoded.remaining).toEqual(frame);
  });

  it("bounds hostile MUS property-list counts and lengths", () => {
    const countOnly = new Uint8Array([0x7f, 0xff, 0xff, 0xff]);
    const hugeKeyLength = new Uint8Array([0, 0, 0, 1, 0, MUS_TYPES.Symbol, 0x7f, 0xff, 0xff, 0xff]);
    const hugeValueLength = new Uint8Array([
      0, 0, 0, 1,
      0, MUS_TYPES.Symbol,
      0, 0, 0, 1,
      0x78, 0,
      0, MUS_TYPES.String,
      0x7f, 0xff, 0xff, 0xff,
    ]);

    for (const bytes of [countOnly, hugeKeyLength, hugeValueLength]) {
      const decoded = decodeMusPropList(bytes, 0);
      expect(decoded.offset).toBeLessThanOrEqual(bytes.length);
      expect(decoded.value.count()).toBeLessThanOrEqual(1);
    }
  });

  it("passes malformed VERSIONCHECK-shaped packets through unchanged", () => {
    const malformedBodies = [
      encodeHabboBase64(5, 2),
      encodeHabboBase64(5, 2) + String.fromCharCode(64),
      encodeHabboBase64(3, 3) + encodeHabboBase64(5, 2) + String.fromCharCode(64),
    ];

    for (const payload of malformedBodies) {
      expect(rewriteRelease306VersionCheckPacket(payload, { build: 1129 })).toBe(payload);
    }
  });

  it("round-trips valid VL64 values and rejects malformed short forms deterministically", () => {
    for (const value of [-1_048_575, -65_535, -1, 0, 1, 63, 64, 4_096, 1_048_575]) {
      expect(decodeVl64Text(encodeVl64(value))).toEqual({ value, bytesRead: encodeVl64(value).length });
    }
    for (const text of ["", String.fromCharCode(64), String.fromCharCode(64 + (7 << 3))]) {
      expect(() => decodeVl64Text(text)).toThrow();
    }
  });

  it("fuzzes network packet rewrite helpers without mutating unrelated payloads", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const payload = stringFromLatin1Bytes(seededBytes(seed, (seed % 17) + 1));
      expect(() => rewriteRelease306VersionCheckPacket(payload, { build: 1129 })).not.toThrow();
      const rewritten = rewriteRelease306VersionCheckPacket(payload, { build: 1129 });
      expect(typeof rewritten).toBe("string");
    }
  });
});

function seededBytes(seed: number, length: number): Uint8Array {
  let state = seed >>> 0;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = 32 + (state % 95);
  }
  return bytes;
}
