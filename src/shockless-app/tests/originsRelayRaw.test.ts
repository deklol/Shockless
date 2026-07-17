import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeMusMessage } from "../../engine/src/director/mus";

test("origins relay raw MUS log summarizes photo requests without exposing login tickets", async (t) => {
  const resourceDir = findRelayResourceDir();
  if (!resourceDir) {
    t.skip("relay resource directory is not present in this checkout");
    return;
  }
  const previousResourceDir = process.env.ORIGINS_RELAY_RESOURCE_DIR;
  process.env.ORIGINS_RELAY_RESOURCE_DIR = resourceDir;
  try {
    const { safeRawMusFrameSummary } = await import("../src/main/relay/originsRelayV4");
    const getBinData = Buffer.from(encodeMusMessage("GETBINDATA", "1029764 -2048535046"));
    assert.match(
      safeRawMusFrameSummary(getBinData) ?? "",
      /musSubject="GETBINDATA".*musPhotoItemId="1029764".*musPhotoAuthSign=negative.*musPhotoAuthDigits=10.*musPhotoAuthUint32=2246432250/,
    );

    const login = Buffer.from(encodeMusMessage("LOGIN", "private-ticket-value"));
    assert.match(safeRawMusFrameSummary(login) ?? "", /musSubject="LOGIN".*musTextStatus=redacted/);
    assert.doesNotMatch(safeRawMusFrameSummary(login) ?? "", /private-ticket-value/);
  } finally {
    if (previousResourceDir === undefined) delete process.env.ORIGINS_RELAY_RESOURCE_DIR;
    else process.env.ORIGINS_RELAY_RESOURCE_DIR = previousResourceDir;
  }
});

test("origins relay raw mode tunnels MUS bytes without game packet framing", async (t) => {
  const resourceDir = findRelayResourceDir();
  if (!resourceDir) {
    t.skip("relay resource directory is not present in this checkout");
    return;
  }
  const previousAllowAny = process.env.ORIGINS_RAW_RELAY_ALLOW_ANY;
  const previousResourceDir = process.env.ORIGINS_RELAY_RESOURCE_DIR;
  process.env.ORIGINS_RAW_RELAY_ALLOW_ANY = "1";
  process.env.ORIGINS_RELAY_RESOURCE_DIR = resourceDir;
  const { createOriginsRelayServer } = await import("../src/main/relay/originsRelayV4");
  let upstreamSocket: Socket | null = null;
  const upstream = net.createServer((socket) => {
    upstreamSocket = socket;
    socket.once("data", (chunk) => socket.write(Buffer.from([0x78, 0x79, 0x7a])));
  });
  const relay = createOriginsRelayServer({ quiet: true });

  try {
    await listen(upstream, "127.0.0.1", 0);
    await listen(relay, "127.0.0.1", 0);
    const upstreamPort = addressPort(upstream);
    const relayPort = addressPort(relay);
    const client = net.connect({ host: "127.0.0.1", port: relayPort });
    await onceEvent(client, "connect");

    const key = crypto.randomBytes(16).toString("base64");
    client.write(
      [
        `GET /?mode=raw&targetHost=127.0.0.1&targetPort=${upstreamPort} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"),
      "latin1",
    );
    const response = await readUntil(client, "\r\n\r\n");
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 101 /);

    client.write(maskedWebSocketFrame(Buffer.from([0x61, 0x62, 0x63])));
    const frame = await readFramePayload(client);
    assert.deepEqual([...frame], [0x78, 0x79, 0x7a]);
    assert.ok(upstreamSocket);
    client.destroy();
  } finally {
    await closeServer(relay);
    await closeServer(upstream);
    if (previousAllowAny === undefined) delete process.env.ORIGINS_RAW_RELAY_ALLOW_ANY;
    else process.env.ORIGINS_RAW_RELAY_ALLOW_ANY = previousAllowAny;
    if (previousResourceDir === undefined) delete process.env.ORIGINS_RELAY_RESOURCE_DIR;
    else process.env.ORIGINS_RELAY_RESOURCE_DIR = previousResourceDir;
  }
});

test("origins relay raw mode reports failed MUS connects without crashing the relay", async (t) => {
  const resourceDir = findRelayResourceDir();
  if (!resourceDir) {
    t.skip("relay resource directory is not present in this checkout");
    return;
  }
  const previousAllowAny = process.env.ORIGINS_RAW_RELAY_ALLOW_ANY;
  const previousResourceDir = process.env.ORIGINS_RELAY_RESOURCE_DIR;
  process.env.ORIGINS_RAW_RELAY_ALLOW_ANY = "1";
  process.env.ORIGINS_RELAY_RESOURCE_DIR = resourceDir;
  const { createOriginsRelayServer } = await import("../src/main/relay/originsRelayV4");
  const closedPort = await reserveThenReleasePort();
  const upstream = net.createServer((socket) => {
    socket.once("data", () => socket.write(Buffer.from([0x6f, 0x6b])));
  });
  const relay = createOriginsRelayServer({ quiet: true });

  try {
    await listen(upstream, "127.0.0.1", 0);
    await listen(relay, "127.0.0.1", 0);
    const relayPort = addressPort(relay);

    const failedClient = await openRawClient(relayPort, "127.0.0.1", closedPort);
    const failedResponse = await readUntil(failedClient, "\r\n\r\n");
    assert.match(failedResponse.toString("latin1"), /^HTTP\/1\.1 502 /);
    failedClient.destroy();

    const liveClient = await openRawClient(relayPort, "127.0.0.1", addressPort(upstream));
    const liveResponse = await readUntil(liveClient, "\r\n\r\n");
    assert.match(liveResponse.toString("latin1"), /^HTTP\/1\.1 101 /);
    liveClient.write(maskedWebSocketFrame(Buffer.from([0x68, 0x69])));
    const frame = await readFramePayload(liveClient);
    assert.deepEqual([...frame], [0x6f, 0x6b]);
    liveClient.destroy();
  } finally {
    await closeServer(relay);
    await closeServer(upstream);
    if (previousAllowAny === undefined) delete process.env.ORIGINS_RAW_RELAY_ALLOW_ANY;
    else process.env.ORIGINS_RAW_RELAY_ALLOW_ANY = previousAllowAny;
    if (previousResourceDir === undefined) delete process.env.ORIGINS_RELAY_RESOURCE_DIR;
    else process.env.ORIGINS_RELAY_RESOURCE_DIR = previousResourceDir;
  }
});

test("Steam authentication stays private without bypassing bidirectional Shockless packet transport", async (t) => {
  const resourceDir = findRelayResourceDir();
  if (!resourceDir) {
    t.skip("relay resource directory is not present in this checkout");
    return;
  }

  const previousResourceDir = process.env.ORIGINS_RELAY_RESOURCE_DIR;
  process.env.ORIGINS_RELAY_RESOURCE_DIR = resourceDir;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "shockless-relay-transport-"));
  const policyPath = join(temporaryDirectory, "plugin-relay-policy.json");
  writeFileSync(policyPath, JSON.stringify({
    version: 1,
    generatedAt: new Date(0).toISOString(),
    sensitiveClientHeaders: [764, 765],
    grants: [{
      pluginId: "packet-test-plugin",
      permissions: ["packet.read", "packet.inject", "packet.intercept", "packet.intercept.sensitive"],
    }],
  }));

  const steamPacket = makeTestPacket(764, Buffer.from("synthetic-private-ticket", "latin1"));
  const ordinaryClientPacket = makeTestPacket(59, Buffer.from("ordinary-client-payload", "latin1"));
  const expectedUpstreamBytes = Buffer.concat([
    frameTestClientPacket(steamPacket),
    frameTestClientPacket(ordinaryClientPacket),
  ]);
  const ordinaryServerPacket = makeTestPacket(29, Buffer.from("ordinary-server-payload", "latin1"));

  const { createOriginsRelayServer } = await import("../src/main/relay/originsRelayV4");
  let resolveUpstreamBytes: ((value: Buffer) => void) | null = null;
  const upstreamBytes = new Promise<Buffer>((resolve) => {
    resolveUpstreamBytes = resolve;
  });
  const upstream = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < expectedUpstreamBytes.length || !resolveUpstreamBytes) return;
      const resolve = resolveUpstreamBytes;
      resolveUpstreamBytes = null;
      resolve(received.subarray(0, expectedUpstreamBytes.length));
      socket.write(Buffer.concat([ordinaryServerPacket, Buffer.from([1])]));
    });
  });
  let transportRelay: Server | null = null;

  try {
    await listen(upstream, "127.0.0.1", 0);
    const upstreamPort = addressPort(upstream);
    transportRelay = createOriginsRelayServer({
      quiet: true,
      tcpHost: "127.0.0.1",
      tcpPort: upstreamPort,
      dnsBypassHosts: false,
      pluginRelayPolicyFile: policyPath,
    });
    await listen(transportRelay, "127.0.0.1", 0);

    const client = net.connect({ host: "127.0.0.1", port: addressPort(transportRelay) });
    await onceEvent(client, "connect");
    const key = crypto.randomBytes(16).toString("base64");
    client.write(
      [
        "GET / HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"),
      "latin1",
    );
    const response = await readUntil(client, "\r\n\r\n");
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 101 /);

    const browserResponse = readFramePayload(client);
    client.write(maskedWebSocketFrame(expectedUpstreamBytes));
    assert.deepEqual(await upstreamBytes, expectedUpstreamBytes);
    assert.deepEqual(
      await browserResponse,
      Buffer.concat([ordinaryServerPacket, Buffer.from([1])]),
    );
    client.destroy();
  } finally {
    if (transportRelay) await closeServer(transportRelay);
    await closeServer(upstream);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (previousResourceDir === undefined) delete process.env.ORIGINS_RELAY_RESOURCE_DIR;
    else process.env.ORIGINS_RELAY_RESOURCE_DIR = previousResourceDir;
  }
});

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function reserveThenReleasePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, "127.0.0.1", 0);
  const port = addressPort(server);
  await closeServer(server);
  return port;
}

async function openRawClient(relayPort: number, targetHost: string, targetPort: number): Promise<Socket> {
  const client = net.connect({ host: "127.0.0.1", port: relayPort });
  await onceEvent(client, "connect");
  const key = crypto.randomBytes(16).toString("base64");
  client.write(
    [
      `GET /?mode=raw&targetHost=${targetHost}&targetPort=${targetPort} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "\r\n",
    ].join("\r\n"),
    "latin1",
  );
  return client;
}

function findRelayResourceDir(): string | null {
  const candidates = [
    join(process.cwd(), "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "release", "src", "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "dist", "portable", "Shockless", "resources", "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "dist", "portable", "Shockless", "resources", "relay"),
    join(process.cwd(), "dist", "portable", "HabbpyV4", "resources", "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "dist", "portable", "HabbpyV4", "resources", "relay"),
    join(process.cwd(), "release", "portable", "Shockless", "resources", "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "release", "portable", "Shockless", "resources", "relay"),
    join(process.cwd(), "release", "portable", "HabbpyV4", "resources", "engine", "standalone", "resources", "relay"),
    join(process.cwd(), "release", "portable", "HabbpyV4", "resources", "relay"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function addressPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not expose a TCP address");
  return address.port;
}

function onceEvent(socket: Socket, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once(eventName, () => resolve());
    socket.once("error", reject);
  });
}

function readUntil(socket: Socket, marker: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", reject);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(marker)) {
        cleanup();
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function readFramePayload(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", reject);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const length = buffer[1] ?? 0;
      if (buffer.length < 2 + length) return;
      cleanup();
      resolve(buffer.subarray(2, 2 + length));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function maskedWebSocketFrame(payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
}

function makeTestPacket(header: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeTestHabboBase64Int(header, 2), payload]);
}

function frameTestClientPacket(packet: Buffer): Buffer {
  return Buffer.concat([encodeTestHabboBase64Int(packet.length, 3), packet]);
}

function encodeTestHabboBase64Int(value: number, width: number): Buffer {
  const output = Buffer.alloc(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    output[index] = 0x40 + (remaining & 0x3f);
    remaining >>= 6;
  }
  return output;
}
