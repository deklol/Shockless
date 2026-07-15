#!/usr/bin/env node
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BobbaCrypto } from "./bobba-crypto.mjs";
import {
  ClientPacketBuffer,
  EncryptedShockwaveChunkBuffer,
  ServerPacketBuffer,
  encryptShockwaveChunk,
  makePacket,
  packetHeaderId,
  prependClientLength,
  readIncomingString,
  readOutgoingString,
  serverFrame,
  writeOutgoingString
} from "./shockwave-codec.mjs";

const DEFAULT_WS_HOST = "127.0.0.1";
const DEFAULT_WS_PORT = 12326;
const DEFAULT_TCP_HOST = "game-ous.habbo.com";
const DEFAULT_TCP_PORT = 40001;

const PACKETS = {
  HELLO: 0,
  SECRET_KEY: 1,
  GENERATEKEY: 202
};

export function createOriginsRelayServer(options = {}) {
  const settings = normalizeRelayOptions(options);
  let connectionCounter = 0;

  return net.createServer((browserSocket) => {
    const id = ++connectionCounter;
    const session = new OriginsRelaySession(id, settings, browserSocket);
    session.start();
  });
}

class OriginsRelaySession {
  constructor(id, settings, browserSocket) {
    this.id = id;
    this.settings = settings;
    this.browserSocket = browserSocket;
    this.websocketUpgraded = false;
    this.websocketBuffer = Buffer.alloc(0);
    this.httpHandshakeBuffer = Buffer.alloc(0);
    this.upstreamSocket = undefined;
    this.upstreamCrypto = new BobbaCrypto(settings.privateKey === undefined ? {} : { privateKey: settings.privateKey });
    this.clientPackets = new ClientPacketBuffer();
    this.serverPackets = new ServerPacketBuffer();
    this.encryptedServerChunks = undefined;
    this.serverCryptoEnabled = false;
    this.closed = false;
  }

  start() {
    this.browserSocket.on("data", (chunk) => this.handleBrowserData(chunk));
    this.browserSocket.on("close", () => this.close("browser closed"));
    this.browserSocket.on("error", (error) => this.close(`browser error ${error.message}`));
  }

  handleBrowserData(chunk) {
    if (this.closed) {
      return;
    }

    if (!this.websocketUpgraded) {
      this.httpHandshakeBuffer = Buffer.concat([this.httpHandshakeBuffer, Buffer.from(chunk)]);
      const end = this.httpHandshakeBuffer.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }

      const headerText = this.httpHandshakeBuffer.subarray(0, end).toString("latin1");
      const headers = parseHttpHeaders(headerText);
      const key = headers["sec-websocket-key"];
      if (!key) {
        this.browserSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }

      const leftover = this.httpHandshakeBuffer.subarray(end + 4);
      void this.connectUpstreamAndUpgrade(key, leftover);
      return;
    }

    this.websocketBuffer = Buffer.concat([this.websocketBuffer, Buffer.from(chunk)]);
    this.websocketBuffer = drainWebSocketFrames(this.websocketBuffer, {
      data: (payload) => this.handleBrowserPayload(payload),
      close: () => this.close("browser requested websocket close"),
      pong: (payload) => this.browserSocket.write(encodeWebSocketFrame(payload, 0x0a))
    });
  }

  async connectUpstreamAndUpgrade(webSocketKey, leftover) {
    try {
      const upstreamHost = await resolveUpstreamHost(this.settings);
      this.upstreamSocket = net.connect({ host: upstreamHost, port: this.settings.tcpPort });
      this.upstreamSocket.on("data", (chunk) => this.handleUpstreamData(chunk));
      this.upstreamSocket.on("close", () => this.close("upstream closed"));
      this.upstreamSocket.on("error", (error) => this.close(`upstream error ${error.message}`));

      await onceConnect(this.upstreamSocket);
      this.websocketUpgraded = true;
      this.browserSocket.write(webSocketUpgradeResponse(webSocketKey));
      this.log(`browser ws -> ${upstreamHost}:${this.settings.tcpPort}`);

      if (leftover.length > 0) {
        this.handleBrowserData(leftover);
      }
    } catch (error) {
      this.log(`upstream connect failed: ${error.message}`);
      this.browserSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      this.close(`upstream connect failed ${error.message}`);
    }
  }

  handleBrowserPayload(payload) {
    this.clientPackets.push(payload);
    let packets;
    try {
      packets = this.clientPackets.receive();
    } catch (error) {
      this.closeProtocolError("browser packet parse failed", error);
      return;
    }

    for (const packet of packets) {
      try {
        this.forwardBrowserPacket(packet);
      } catch (error) {
        this.closeProtocolError("browser packet forward failed", error);
        return;
      }
    }
  }

  forwardBrowserPacket(packet) {
    if (!this.upstreamSocket || this.upstreamSocket.destroyed) {
      return;
    }

    let outgoingPacket = Buffer.from(packet);
    const headerId = safeHeaderId(outgoingPacket);
    if (headerId === PACKETS.GENERATEKEY) {
      outgoingPacket = makePacket(PACKETS.GENERATEKEY, writeOutgoingString(this.upstreamCrypto.publicKeyString()));
      this.log(`client GENERATEKEY replaced with relay public key length ${this.upstreamCrypto.publicKeyString().length}`);
    }

    if (this.serverCryptoEnabled) {
      this.upstreamSocket.write(encryptShockwaveChunk(outgoingPacket, this.upstreamCrypto.c2sHeader, this.upstreamCrypto.c2sData));
      this.logPacket("browser -> official encrypted", outgoingPacket);
      return;
    }

    this.upstreamSocket.write(prependClientLength(outgoingPacket));
    this.logPacket("browser -> official plaintext", outgoingPacket);
  }

  handleUpstreamData(chunk) {
    try {
      if (this.serverCryptoEnabled) {
        this.encryptedServerChunks.push(chunk);
        for (const plainChunk of this.encryptedServerChunks.receive()) {
          this.serverPackets.push(plainChunk);
          this.forwardServerPackets();
        }
        return;
      }

      this.serverPackets.push(chunk);
      this.forwardServerPackets();
    } catch (error) {
      this.closeProtocolError("official packet parse failed", error);
    }
  }

  forwardServerPackets() {
    for (const packet of this.serverPackets.receive()) {
      const headerId = safeHeaderId(packet);
      if (headerId === PACKETS.SECRET_KEY && !this.serverCryptoEnabled) {
        const serverPublicKey = readIncomingString(packet).value;
        this.upstreamCrypto.setPeerPublicKey(serverPublicKey);
        this.encryptedServerChunks = new EncryptedShockwaveChunkBuffer(this.upstreamCrypto.s2cHeader, this.upstreamCrypto.s2cData);
        this.serverCryptoEnabled = true;
        this.log(`official SECRET_KEY received length ${serverPublicKey.length}; upstream BobbaCrypto enabled`);
      }

      this.browserSocket.write(encodeWebSocketFrame(serverFrame(packet), 0x02));
      this.logPacket("official -> browser plaintext", packet);
    }
  }

  close(reason) {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.log(reason);
    this.upstreamSocket?.destroy();
    this.browserSocket.destroy();
  }

  closeProtocolError(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.close(`${context}: ${message}`);
  }

  log(message) {
    if (this.settings.quiet) {
      return;
    }
    console.log(`[origins-relay #${this.id}] ${message}`);
  }

  logPacket(prefix, packet) {
    if (!this.settings.logPackets) {
      return;
    }

    const headerId = safeHeaderId(packet);
    const suffix = headerId === PACKETS.GENERATEKEY
      ? ` header=${headerId} keyLength=${readSafeOutgoingString(packet).length}`
      : ` header=${headerId} bytes=${packet.length}`;
    this.log(`${prefix}${suffix}`);
  }
}

export function normalizeRelayOptions(options = {}) {
  return {
    wsHost: options.wsHost ?? readEnvString("ORIGINS_WS_HOST", "BRIDGE_WS_HOST") ?? DEFAULT_WS_HOST,
    wsPort: parsePort(options.wsPort ?? readEnvString("ORIGINS_WS_PORT", "BRIDGE_WS_PORT"), DEFAULT_WS_PORT),
    tcpHost: options.tcpHost ?? readEnvString("ORIGINS_TCP_HOST", "BRIDGE_TCP_HOST") ?? DEFAULT_TCP_HOST,
    tcpPort: parsePort(options.tcpPort ?? readEnvString("ORIGINS_TCP_PORT", "BRIDGE_TCP_PORT"), DEFAULT_TCP_PORT),
    dnsBypassHosts: options.dnsBypassHosts ?? (readEnvString("ORIGINS_DNS_BYPASS_HOSTS") !== "0"),
    logPackets: options.logPackets ?? readEnvString("ORIGINS_LOG_PACKETS") === "1",
    quiet: options.quiet ?? false,
    privateKey: options.privateKey
  };
}

async function resolveUpstreamHost(settings) {
  if (!settings.dnsBypassHosts || settings.tcpHost !== DEFAULT_TCP_HOST) {
    return settings.tcpHost;
  }

  try {
    const addresses = await dns.resolve4(settings.tcpHost);
    const publicAddress = addresses.find((address) => !isLocalAddress(address));
    return publicAddress ?? settings.tcpHost;
  } catch {
    return settings.tcpHost;
  }
}

function webSocketUpgradeResponse(key) {
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n");
}

function parseHttpHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r\n/).slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function drainWebSocketFrames(buffer, handlers) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      const high = buffer.readUInt32BE(offset + 2);
      const low = buffer.readUInt32BE(offset + 6);
      if (high !== 0) {
        throw new Error("WebSocket frame is too large for the Origins relay");
      }
      length = low;
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) {
      break;
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    if (opcode === 0x08) {
      handlers.close();
    } else if (opcode === 0x09) {
      handlers.pong(payload);
    } else if (opcode === 0x01 || opcode === 0x02) {
      handlers.data(payload);
    }

    offset += frameLength;
  }

  return buffer.subarray(offset);
}

function encodeWebSocketFrame(payload, opcode) {
  const data = Buffer.from(payload);
  if (data.length <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, data.length]), data]);
  }
  if (data.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(data.length, 6);
  return Buffer.concat([header, data]);
}

function onceConnect(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("connect", handleConnect);
      socket.off("error", handleError);
    };
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", handleConnect);
    socket.once("error", handleError);
  });
}

function readSafeOutgoingString(packet) {
  try {
    return readOutgoingString(packet).value;
  } catch {
    return "";
  }
}

function safeHeaderId(packet) {
  try {
    return packetHeaderId(packet);
  } catch {
    return -1;
  }
}

function readEnvString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parsePort(value, fallback) {
  const parsed = value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function isLocalAddress(address) {
  return address === "127.0.0.1" || address.startsWith("127.") || address === "0.0.0.0";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = normalizeRelayOptions();
  const server = createOriginsRelayServer(settings);
  server.listen(settings.wsPort, settings.wsHost, () => {
    console.log(`[origins-relay] listening ws://${settings.wsHost}:${settings.wsPort} -> ${settings.tcpHost}:${settings.tcpPort}`);
    console.log("[origins-relay] browser side stays plaintext; official TCP side uses BobbaCrypto after SECRET_KEY");
  });

  process.on("SIGINT", () => server.close(() => process.exit(0)));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
