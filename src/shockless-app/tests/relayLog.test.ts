import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseRelayLine,
  readRelayLogDeltaSnapshot,
  readRelayLogHistoryPage,
  readRelayLogSnapshot,
} from "../src/main/relayLog";
import { RELAY_LOG_DELTA_ENTRY_LIMIT, RELAY_LOG_LIVE_ENTRY_LIMIT } from "../src/shared/relayLogWindow";

function sampledRelayLine(header: number, bytes: number, bodyLen: number, bodySample: string): string {
  return `[origins-relay #4] official -> browser plaintext header=${header} bytes=${bytes} bodyStatus=sampled bodyLen=${bodyLen} bodySample=${JSON.stringify(bodySample)}`;
}

function writeTempRelayLog(lines: readonly string[]): { readonly appDataPath: string; readonly logPath: string } {
  const appDataPath = mkdtempSync(join(tmpdir(), "habbpy-v4-relay-"));
  const logDir = join(appDataPath, "Shockless", "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "shockless-relay.log");
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  return { appDataPath, logPath };
}

function writeTempClientRelayLog(appDataPath: string, clientId: number, lines: readonly string[]): string {
  const logDir = clientId === 1 ? join(appDataPath, "Shockless", "logs") : join(appDataPath, "Shockless", `client-${clientId}`, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "shockless-relay.log");
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  return logPath;
}

test("relay log parser reports payload bytes and non-persisted body status", () => {
  const entry = parseRelayLine("[origins-relay #2] official -> browser plaintext header=32 bytes=1385", 41);

  assert.ok(entry);
  assert.equal(entry.direction, "SERVER");
  assert.equal(entry.sessionId, "2");
  assert.equal(entry.header, 32);
  assert.equal(entry.size, 1385);
  assert.equal(entry.payloadBytes, 1383);
  assert.equal(entry.bodyStatus, "not-persisted");
  assert.equal(entry.bodyText, null);
  assert.match(entry.bodyNote, /payload body bytes are not persisted/);
});

test("relay log snapshot aggregates per-client relay logs with client tags", () => {
  const appDataPath = mkdtempSync(join(tmpdir(), "habbpy-v4-relay-clients-"));
  try {
    writeTempClientRelayLog(appDataPath, 1, ["[origins-relay #1] official -> browser plaintext header=24 bytes=16"]);
    writeTempClientRelayLog(appDataPath, 2, ["[origins-relay #2] browser -> official plaintext header=55 bytes=22"]);

    const full = readRelayLogSnapshot(appDataPath, [
      { id: 1, label: "Main" },
      { id: 2, label: "Alt" },
    ]);
    assert.equal(full.logPath.startsWith("aggregate://shockless-relay/"), true);
    assert.equal(full.entries.length, 2);
    assert.equal(full.entries[0]?.clientId, 1);
    assert.equal(full.entries[0]?.clientLabel, "Main");
    assert.equal(full.entries[1]?.clientId, 2);
    assert.equal(full.entries[1]?.clientLabel, "Alt");

    const delta = readRelayLogDeltaSnapshot(appDataPath, full.logPath, 1, [
      { id: 1, label: "Main" },
      { id: 2, label: "Alt" },
    ]);
    assert.equal(delta.reset, false);
    assert.deepEqual(delta.entries.map((entry) => entry.clientId), [2]);
  } finally {
    rmSync(appDataPath, { recursive: true, force: true });
  }
});

test("relay log parser keeps lifecycle rows out of packet body decoding", () => {
  const entry = parseRelayLine("[origins-relay #3] official SECRET_KEY received length 32; upstream BobbaCrypto enabled", 2);

  assert.ok(entry);
  assert.equal(entry.direction, "RELAY");
  assert.equal(entry.header, null);
  assert.equal(entry.payloadBytes, null);
  assert.equal(entry.bodyStatus, "not-a-packet");
  assert.equal(entry.bodyText, null);
  assert.equal(entry.message, "official SECRET_KEY received length <redacted>; upstream BobbaCrypto enabled");
});

test("relay log parser reads sanitized v4 relay packet bodies", () => {
  const entry = parseRelayLine(
    '[origins-relay #4] official -> browser plaintext header=24 bytes=16 bodyStatus=sampled bodyLen=14 bodySample="hello\\\\x02world"',
    12,
  );

  assert.ok(entry);
  assert.equal(entry.direction, "SERVER");
  assert.equal(entry.header, 24);
  assert.equal(entry.size, 16);
  assert.equal(entry.payloadBytes, 14);
  assert.equal(entry.bodyStatus, "sampled");
  assert.equal(entry.bodyText, "hello\\x02world");
  assert.equal(entry.bodyHex, "68 65 6c 6c 6f 02 77 6f 72 6c 64");
  assert.equal(entry.bodyAscii, "hello<STX>world");
  assert.equal(entry.bodyTruncated, false);
  assert.deepEqual(entry.decodedFields.slice(0, 4), [
    { label: "decryptedBytes", value: "11" },
    { label: "ascii", value: "hello<STX>world" },
    { label: "field 1", value: "hello" },
    { label: "field 2", value: "world" },
  ]);
  assert.match(entry.bodyNote, /Sanitized relay body captured/);
});

test("relay log parser keeps long decrypted packet bodies untruncated", () => {
  const body = `start\\x02${"abc123".repeat(1200)}\\x02end`;
  const entry = parseRelayLine(sampledRelayLine(30, body.length + 2, body.length, body), 21);

  assert.ok(entry);
  assert.equal(entry.direction, "SERVER");
  assert.equal(entry.header, 30);
  assert.equal(entry.bodyStatus, "sampled");
  assert.equal(entry.bodyTruncated, false);
  assert.equal(entry.bodyText, body);
  assert.equal(entry.bodyAscii?.startsWith("start<STX>abc123"), true);
  assert.equal(entry.bodyAscii?.endsWith("<STX>end"), true);
});

test("relay log parser marks legacy truncated decrypted body samples", () => {
  const entry = parseRelayLine(
    '[origins-relay #4] official -> browser plaintext header=50 bytes=16 bodyStatus=sampled bodyLen=220 bodySample="1781980990552\\\\x02" bodyTruncated=1',
    12,
  );

  assert.ok(entry);
  assert.equal(entry.direction, "SERVER");
  assert.equal(entry.header, 50);
  assert.equal(entry.bodyTruncated, true);
  assert.ok(entry.decodedFields.some((field) => field.label === "pingToken" && field.value === "1781980990552"));
});

test("relay log parser adds packet-family hints for live status and article rows", () => {
  const status = parseRelayLine(
    sampledRelayLine(34, 45, 43, "IIKQA0.0\\x02JJ/flatctrl useradmin/mv 4,5,0.0/\\x02"),
    1,
  );
  const article = parseRelayLine(
    sampledRelayLine(681, 68, 66, "IRvKXrQgeneric7\\x02A THANK YOU FROM US!\\x02Log in during Community Day\\x02"),
    2,
  );

  assert.ok(status);
  assert.ok(article);
  assert.ok(status.decodedFields.some((field) => field.label === "statusRows" && field.value === "2"));
  assert.ok(status.decodedFields.some((field) => field.label === "statusActor 2" && field.value === "flatctrl"));
  assert.ok(status.decodedFields.some((field) => field.label === "statusState 2" && field.value === "mv 4,5,0.0"));
  assert.ok(article.decodedFields.some((field) => field.label === "articleRows" && field.value === "3"));
  assert.ok(article.decodedFields.some((field) => field.label === "article 2" && field.value === "A THANK YOU FROM US!"));
});

test("relay log parser adds packet-family hints for friends, calendar, effects, and slide rows", () => {
  const friend = parseRelayLine(
    sampledRelayLine(13, 68, 66, "Ic_^AHC\\x02IBuying: Blue Habbo Cola\\x02IIoffline\\x02"),
    3,
  );
  const calendar = parseRelayLine(
    sampledRelayLine(683, 70, 68, "QHHabboon MEGA Grabber w/ Woutt @ 17:30 UTC\\x02Room Building Competition\\x02"),
    4,
  );
  const effects = parseRelayLine(
    sampledRelayLine(1242, 19, 17, "ophelias_blessing\\x02IXh"),
    5,
  );
  const slide = parseRelayLine(
    sampledRelayLine(230, 31, 29, "QBQBQBRBIaPcs0.45\\x020.45\\x02`Znp"),
    6,
  );

  assert.ok(friend);
  assert.ok(calendar);
  assert.ok(effects);
  assert.ok(slide);
  assert.ok(friend.decodedFields.some((field) => field.label === "friendUpdateFields" && field.value === "3"));
  assert.ok(calendar.decodedFields.some((field) => field.label === "calendarRows" && field.value === "2"));
  assert.ok(effects.decodedFields.some((field) => field.label === "statusEffectFields" && field.value === "2"));
  assert.ok(slide.decodedFields.some((field) => field.label === "slideObjectFields" && field.value === "3"));
});

test("relay log parser decodes messenger friends badges preferences and effects like v3", () => {
  const friendRow = [
    vl64(902),
    incoming("dek"),
    vl64(1),
    incoming("higher brain pattern"),
    vl64(1),
    vl64(1),
    incoming("Codex Test LAB"),
    incoming("today"),
    incoming("hr-515-1027.hd-190-1021"),
    vl64(3),
  ].join("");
  const messengerBody = [
    incoming("hello"),
    vl64(500),
    vl64(300),
    vl64(200),
    vl64(1),
    friendRow,
    vl64(10),
    vl64(2),
    vl64(20),
    vl64(4),
    incoming("tail"),
  ].join("");
  const updateBody = [vl64(1), friendRow].join("");
  const addedBody = friendRow;
  const highlightBody = [vl64(2), vl64(1), vl64(1), friendRow].join("");
  const badgesBody = [vl64(2), incoming("HC1"), incoming("ADM"), incoming("badge-tail")].join("");
  const activeBadgeBody = [vl64(1), incoming("HC1")].join("");
  const preferencesBody = [vl64(1), vl64(0), vl64(1)].join("");
  const effectsBody = [vl64(2), incoming("sparkle"), vl64(5), incoming("ghost"), vl64(0)].join("");

  const messenger = parseRelayLine(sampledRelayLine(12, messengerBody.length + 2, messengerBody.length, escapeRelayBody(messengerBody)), 31);
  const update = parseRelayLine(sampledRelayLine(13, updateBody.length + 2, updateBody.length, escapeRelayBody(updateBody)), 32);
  const added = parseRelayLine(sampledRelayLine(137, addedBody.length + 2, addedBody.length, escapeRelayBody(addedBody)), 33);
  const highlight = parseRelayLine(sampledRelayLine(362, highlightBody.length + 2, highlightBody.length, escapeRelayBody(highlightBody)), 34);
  const badges = parseRelayLine(sampledRelayLine(229, badgesBody.length + 2, badgesBody.length, escapeRelayBody(badgesBody)), 35);
  const activeBadge = parseRelayLine(sampledRelayLine(228, activeBadgeBody.length + 2, activeBadgeBody.length, escapeRelayBody(activeBadgeBody)), 36);
  const preferences = parseRelayLine(sampledRelayLine(308, preferencesBody.length + 2, preferencesBody.length, escapeRelayBody(preferencesBody)), 37);
  const effects = parseRelayLine(sampledRelayLine(1242, effectsBody.length + 2, effectsBody.length, escapeRelayBody(effectsBody)), 38);

  assert.ok(messenger);
  assert.ok(update);
  assert.ok(added);
  assert.ok(highlight);
  assert.ok(badges);
  assert.ok(activeBadge);
  assert.ok(preferences);
  assert.ok(effects);
  assert.ok(messenger.decodedFields.some((field) => field.label === "messengerFriendCount" && field.value === "1"));
  assert.ok(messenger.decodedFields.some((field) => field.label === "friend 1 name" && field.value === "dek"));
  assert.ok(messenger.decodedFields.some((field) => field.label === "friend 1 online" && field.value === "true"));
  assert.ok(messenger.decodedFields.some((field) => field.label === "friend 1 location" && field.value === "Codex Test LAB"));
  assert.ok(update.decodedFields.some((field) => field.label === "friendUpdateCount" && field.value === "1"));
  assert.ok(update.decodedFields.some((field) => field.label === "friendUpdate 1 accountId" && field.value === "902"));
  assert.ok(added.decodedFields.some((field) => field.label === "friendAdded name" && field.value === "dek"));
  assert.ok(highlight.decodedFields.some((field) => field.label === "highlightFriendCount" && field.value === "1"));
  assert.ok(highlight.decodedFields.some((field) => field.label === "highlightFriend 1 categoryId" && field.value === "3"));
  assert.ok(badges.decodedFields.some((field) => field.label === "badgeCount" && field.value === "2"));
  assert.ok(badges.decodedFields.some((field) => field.label === "badge 2 code" && field.value === "ADM"));
  assert.ok(activeBadge.decodedFields.some((field) => field.label === "activeBadgeSlot" && field.value === "1"));
  assert.ok(activeBadge.decodedFields.some((field) => field.label === "activeBadgeCode" && field.value === "HC1"));
  assert.ok(preferences.decodedFields.some((field) => field.label === "accountPreferenceCount" && field.value === "3"));
  assert.ok(preferences.decodedFields.some((field) => field.label === "accountPreference 2" && field.value === "0"));
  assert.ok(effects.decodedFields.some((field) => field.label === "statusEffectCount" && field.value === "2"));
  assert.ok(effects.decodedFields.some((field) => field.label === "statusEffect 1 name" && field.value === "sparkle"));
  assert.ok(effects.decodedFields.some((field) => field.label === "statusEffect 2 value" && field.value === "0"));
});

test("relay log parser decodes private messenger messages and friend requests like v3 logs", () => {
  const messageListBody = [
    vl64(2),
    vl64(1),
    incoming("6a2d9e9371728f74c3b54476"),
    vl64(73521),
    incoming("13-06-2026 17:16:51"),
    incoming("Looking for Ironwine pillow"),
    incoming("6a2d9e9371728f74c3b54477"),
    vl64(24191),
    incoming("13-06-2026 17:20:00"),
    incoming("yo"),
  ].join("");
  const liveMessageBody = [
    incoming("6a2a526d744ba00ef0fd5e15"),
    vl64(161423),
    incoming("21-06-2026 05:15:09"),
    incoming("sorry you miss my msg"),
  ].join("");
  const requestListBody = [
    vl64(1),
    vl64(1),
    vl64(77157),
    incoming("DrSmug"),
    incoming("77157"),
  ].join("");
  const liveRequestBody = [vl64(24191), incoming("HCM"), incoming("24191")].join("");

  const messageList = parseRelayLine(sampledRelayLine(313, messageListBody.length + 2, messageListBody.length, escapeRelayBody(messageListBody)), 39);
  const liveMessage = parseRelayLine(sampledRelayLine(134, liveMessageBody.length + 2, liveMessageBody.length, escapeRelayBody(liveMessageBody)), 40);
  const requestList = parseRelayLine(sampledRelayLine(314, requestListBody.length + 2, requestListBody.length, escapeRelayBody(requestListBody)), 41);
  const liveRequest = parseRelayLine(sampledRelayLine(132, liveRequestBody.length + 2, liveRequestBody.length, escapeRelayBody(liveRequestBody)), 42);

  assert.ok(messageList);
  assert.ok(liveMessage);
  assert.ok(requestList);
  assert.ok(liveRequest);
  assert.equal(messageList.packetName, "MESSENGER_MESSAGES");
  assert.equal(liveMessage.packetName, "MESSENGER_MESSAGE");
  assert.equal(requestList.packetName, "FRIEND_REQUEST_LIST");
  assert.equal(liveRequest.packetName, "FRIEND_REQUEST");
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessageCount" && field.value === "2"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessageUnreadCount" && field.value === "1"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessage 1 id" && field.value === "6a2d9e9371728f74c3b54476"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessage 1 senderAccountId" && field.value === "73521"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessage 1 sentAt" && field.value === "13-06-2026 17:16:51"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessage 1 text" && field.value === "Looking for Ironwine pillow"));
  assert.ok(messageList.decodedFields.some((field) => field.label === "privateMessage 2 senderAccountId" && field.value === "24191"));
  assert.ok(liveMessage.decodedFields.some((field) => field.label === "privateMessage 1 senderAccountId" && field.value === "161423"));
  assert.ok(liveMessage.decodedFields.some((field) => field.label === "privateMessage 1 text" && field.value === "sorry you miss my msg"));
  assert.ok(requestList.decodedFields.some((field) => field.label === "friendRequestCount" && field.value === "1"));
  assert.ok(requestList.decodedFields.some((field) => field.label === "friendRequestPendingCount" && field.value === "1"));
  assert.ok(requestList.decodedFields.some((field) => field.label === "friendRequest 1 accountId" && field.value === "77157"));
  assert.ok(requestList.decodedFields.some((field) => field.label === "friendRequest 1 name" && field.value === "DrSmug"));
  assert.ok(liveRequest.decodedFields.some((field) => field.label === "friendRequest 1 accountId" && field.value === "24191"));
  assert.ok(liveRequest.decodedFields.some((field) => field.label === "friendRequest 1 name" && field.value === "HCM"));
});

test("relay log parser decodes inventory strip packets like v3", () => {
  const floorHead = `${vl64(501)}${vl64(3)}S`;
  const floorBody = `${vl64(42)}${vl64(0)}${vl64(0)}plant_bonsai`;
  const floorMeta = `${vl64(1)}${vl64(2)}#00ff00`;
  const wallHead = `${vl64(777)}${vl64(9)}I`;
  const wallBody = `${vl64(88)}${vl64(0)}${vl64(0)}poster_skull`;
  const wallMeta = "wall-data";
  const body = [vl64(2), incoming(floorHead), incoming(floorBody), incoming(floorMeta), incoming(wallHead), incoming(wallBody), incoming(wallMeta)].join("");
  const removeBody = incoming(vl64(501));

  const inventory = parseRelayLine(sampledRelayLine(140, body.length + 2, body.length, escapeRelayBody(body)), 39);
  const remove = parseRelayLine(sampledRelayLine(99, removeBody.length + 2, removeBody.length, escapeRelayBody(removeBody)), 40);

  assert.ok(inventory);
  assert.ok(remove);
  assert.equal(inventory.packetName, "STRIPINFO_2");
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItemCount" && field.value === "2"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 idValue" && field.value === "501"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 slotId" && field.value === "3"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 objectId" && field.value === "42"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 kind" && field.value === "floor"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 class" && field.value === "plant_bonsai"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 size" && field.value === "1x2"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 1 colors" && field.value === "#00ff00"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 2 idValue" && field.value === "777"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 2 kind" && field.value === "wall"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 2 class" && field.value === "poster_skull"));
  assert.ok(inventory.decodedFields.some((field) => field.label === "inventoryItem 2 data" && field.value === "wall-data"));
  assert.equal(remove.packetName, "REMOVESTRIPITEM");
  assert.ok(remove.decodedFields.some((field) => field.label === "inventoryRemove id" && field.value === inventory.decodedFields.find((candidate) => candidate.label === "inventoryItem 1 id")?.value));
});

test("relay log parser decodes room chat packets like v3", () => {
  const talkBody = [vl64(0), incoming("hello room")].join("");
  const whisperBody = [vl64(2), incoming("quiet words")].join("");
  const shoutBody = [vl64(3), incoming("LOUD WORDS")].join("");

  const talk = parseRelayLine(sampledRelayLine(24, talkBody.length + 2, talkBody.length, escapeRelayBody(talkBody)), 41);
  const whisper = parseRelayLine(sampledRelayLine(25, whisperBody.length + 2, whisperBody.length, escapeRelayBody(whisperBody)), 42);
  const shout = parseRelayLine(sampledRelayLine(26, shoutBody.length + 2, shoutBody.length, escapeRelayBody(shoutBody)), 43);

  assert.ok(talk);
  assert.ok(whisper);
  assert.ok(shout);
  assert.equal(talk.packetName, "CHAT");
  assert.equal(whisper.packetName, "CHAT_2");
  assert.equal(shout.packetName, "CHAT_3");
  assert.ok(talk.decodedFields.some((field) => field.label === "chatIndex" && field.value === "0"));
  assert.ok(talk.decodedFields.some((field) => field.label === "chatText" && field.value === "hello room"));
  assert.ok(talk.decodedFields.some((field) => field.label === "chatType" && field.value === "talk"));
  assert.ok(talk.decodedFields.some((field) => field.label === "chatActivity" && field.value === "TALKING"));
  assert.ok(whisper.decodedFields.some((field) => field.label === "chatIndex" && field.value === "2"));
  assert.ok(whisper.decodedFields.some((field) => field.label === "chatText" && field.value === "quiet words"));
  assert.ok(whisper.decodedFields.some((field) => field.label === "chatType" && field.value === "whisper"));
  assert.ok(whisper.decodedFields.some((field) => field.label === "chatActivity" && field.value === "WHISPERING"));
  assert.ok(shout.decodedFields.some((field) => field.label === "chatIndex" && field.value === "3"));
  assert.ok(shout.decodedFields.some((field) => field.label === "chatText" && field.value === "LOUD WORDS"));
  assert.ok(shout.decodedFields.some((field) => field.label === "chatType" && field.value === "shout"));
  assert.ok(shout.decodedFields.some((field) => field.label === "chatActivity" && field.value === "SHOUTING"));
});

test("relay log parser decodes fishing packets like v3", () => {
  const catchBody = incoming("You caught a golden carp! (+42 XP)");
  const tokensBody = vl64(1234);
  const minigameBody = [vl64(18), vl64(2), vl64(7), vl64(0)].join("");
  const bulletinBody = [incoming("You leveled up!"), incoming("You reached fishing level 5"), incoming("Fishing Frenzy is active")].join("");
  const fishopediaBody = [
    incoming("fish_golden_carp"),
    incoming("42 XP"),
    incoming("3 catches"),
    incoming("complete"),
    incoming("lake"),
  ].join("");
  const startBody = vl64(888);
  const inputBody = `${base64(1, 2)}L`;

  const caught = parseRelayLine(sampledRelayLine(1101, catchBody.length + 2, catchBody.length, escapeRelayBody(catchBody)), 51);
  const tokens = parseRelayLine(sampledRelayLine(1102, tokensBody.length + 2, tokensBody.length, escapeRelayBody(tokensBody)), 52);
  const minigame = parseRelayLine(sampledRelayLine(1108, minigameBody.length + 2, minigameBody.length, escapeRelayBody(minigameBody)), 53);
  const bulletin = parseRelayLine(sampledRelayLine(680, bulletinBody.length + 2, bulletinBody.length, escapeRelayBody(bulletinBody)), 54);
  const fishopedia = parseRelayLine(sampledRelayLine(1116, fishopediaBody.length + 2, fishopediaBody.length, escapeRelayBody(fishopediaBody)), 55);
  const start = parseRelayLine(
    `[origins-relay #4] browser -> official plaintext header=1100 bytes=${startBody.length + 2} bodyStatus=sampled bodyLen=${startBody.length} bodySample=${JSON.stringify(escapeRelayBody(startBody))}`,
    56,
  );
  const input = parseRelayLine(
    `[origins-relay #4] browser -> official plaintext header=1101 bytes=${inputBody.length + 2} bodyStatus=sampled bodyLen=${inputBody.length} bodySample=${JSON.stringify(escapeRelayBody(inputBody))}`,
    57,
  );

  assert.ok(caught);
  assert.ok(tokens);
  assert.ok(minigame);
  assert.ok(bulletin);
  assert.ok(fishopedia);
  assert.ok(start);
  assert.ok(input);
  assert.equal(caught.packetName, "FISHING_CHAT");
  assert.ok(caught.decodedFields.some((field) => field.label === "fishingCatchName" && field.value === "golden carp"));
  assert.ok(caught.decodedFields.some((field) => field.label === "fishingCatchXp" && field.value === "42"));
  assert.ok(caught.decodedFields.some((field) => field.label === "fishingCatchGolden" && field.value === "true"));
  assert.ok(tokens.decodedFields.some((field) => field.label === "fishTokens" && field.value === "1234"));
  assert.ok(minigame.decodedFields.some((field) => field.label === "fishingStatusValueCount" && field.value === "4"));
  assert.ok(minigame.decodedFields.some((field) => field.label === "fishingMinigamePin" && field.value === "18"));
  assert.ok(bulletin.decodedFields.some((field) => field.label === "fishingLevel" && field.value === "5"));
  assert.ok(bulletin.decodedFields.some((field) => field.label === "fishingFrenzyActive" && field.value === "true"));
  assert.ok(fishopedia.decodedFields.some((field) => field.label === "fishopediaFish name" && field.value === "fish_golden_carp"));
  assert.ok(fishopedia.decodedFields.some((field) => field.label === "fishopediaFish catches" && field.value === "3"));
  assert.ok(start.decodedFields.some((field) => field.label === "fishingClientTargetId" && field.value === "888"));
  assert.ok(input.decodedFields.some((field) => field.label === "fishingClientInput" && field.value === "L"));
});

test("relay log parser decodes live USERS packet profile rows", () => {
  const entry = parseRelayLine(
    sampledRelayLine(
      28,
      141,
      139,
      "IHZaCdek\\x02hr-515-1027.hd-190-1021.lg-285-1266.ea-1402-1.fa-1201-1.ca-1802-1\\x02m\\x02'higher brain pattern' @dekHabbo\\x02SAQA0.0\\x02\\x02HC2\\x02Istd\\x02crr.5\\x02PAHPS",
    ),
    7,
  );

  assert.ok(entry);
  assert.ok(entry.decodedFields.some((field) => field.label === "userCount" && field.value === "1"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 name" && field.value === "dek"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 accountId" && field.value === "902"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 index" && field.value === "0"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 gender" && field.value === "m"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 motto" && field.value === "'higher brain pattern' @dekHabbo"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 badge" && field.value === "HC2"));
  assert.ok(entry.decodedFields.some((field) => field.label === "user 1 type" && field.value === "1"));
});

test("relay log parser decodes active floor object rows like v3", () => {
  const body = [
    vl64(1),
    incoming("42"),
    incoming("plant_bonsai"),
    vl64(3),
    vl64(5),
    vl64(1),
    vl64(1),
    vl64(2),
    incoming("0.0"),
    incoming("#00ff00"),
    incoming("ready"),
    vl64(7),
    incoming("watered"),
  ].join("");
  const entry = parseRelayLine(sampledRelayLine(32, body.length + 2, body.length, escapeRelayBody(body)), 8);

  assert.ok(entry);
  assert.equal(entry.packetName, "ACTIVEOBJECTS");
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectCount" && field.value === "1"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 id" && field.value === "42"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 class" && field.value === "plant_bonsai"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 tile" && field.value === "3, 5, 0.0"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 size" && field.value === "1x1"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 direction" && field.value === "2"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 rawPosition" && field.value === "KQAIIJ0.0"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 state" && field.value === "7"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 stuff" && field.value === "watered"));
});

test("relay log parser decodes wall item packets like v3", () => {
  const first = "42\tposter_skull\tdek\t:w=1,2 l=3,4 l\t7\r";
  const second = "77\tposter_hc\tWoutt\t:w=-2,5 l=0,1 r\topen";
  const body = [incoming(first), incoming(second)].join("");
  const updateBody = incoming("42\tposter_skull\tdek\t:w=1,2 l=3,4 l\t8");
  const removeBody = incoming("item 42 removed");

  const list = parseRelayLine(sampledRelayLine(45, body.length + 2, body.length, escapeRelayBody(body)), 44);
  const update = parseRelayLine(sampledRelayLine(85, updateBody.length + 2, updateBody.length, escapeRelayBody(updateBody)), 45);
  const remove = parseRelayLine(sampledRelayLine(84, removeBody.length + 2, removeBody.length, escapeRelayBody(removeBody)), 46);

  assert.ok(list);
  assert.ok(update);
  assert.ok(remove);
  assert.equal(list.packetName, "ITEMS");
  assert.ok(list.decodedFields.some((field) => field.label === "wallItemCount" && field.value === "2"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 id" && field.value === "42"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 class" && field.value === "poster_skull"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 owner" && field.value === "dek"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 wall" && field.value === "1,2"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 local" && field.value === "3,4"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 orientation" && field.value === "l"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 rawLocation" && field.value === ":w=1,2 l=3,4 l"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 data" && field.value === "7"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 1 state" && field.value === "7"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 2 id" && field.value === "77"));
  assert.ok(list.decodedFields.some((field) => field.label === "wallItem 2 data" && field.value === "open"));
  assert.equal(update.packetName, "UPDATEITEM");
  assert.ok(update.decodedFields.some((field) => field.label === "wallItemUpdate id" && field.value === "42"));
  assert.ok(update.decodedFields.some((field) => field.label === "wallItemUpdate state" && field.value === "8"));
  assert.equal(remove.packetName, "REMOVEITEM");
  assert.ok(remove.decodedFields.some((field) => field.label === "wallItemRemove id" && field.value === "42"));
});

test("relay log parser keeps v3 stall floor object trailing segments", () => {
  const firstObject = [
    incoming("42"),
    incoming("market_stall"),
    vl64(3),
    vl64(5),
    vl64(1),
    vl64(1),
    vl64(2),
    incoming("0.0"),
    incoming(""),
    incoming("runtime"),
    vl64(1),
    incoming("open"),
    incoming("owner=dek"),
    incoming("price=3"),
  ].join("");
  const secondObject = [
    incoming("77"),
    incoming("chair"),
    vl64(8),
    vl64(9),
    vl64(1),
    vl64(1),
    vl64(0),
    incoming("0.0"),
    incoming(""),
    incoming(""),
    vl64(0),
    incoming(""),
  ].join("");
  const body = [vl64(2), firstObject, secondObject].join("");
  const entry = parseRelayLine(sampledRelayLine(32, body.length + 2, body.length, escapeRelayBody(body)), 10);

  assert.ok(entry);
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectCount" && field.value === "2"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 1 trailing" && field.value === "owner=dek<STX>price=3"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObject 2 id" && field.value === "77"));
});

test("relay log parser decodes active floor object update rows like v3", () => {
  const body = [
    incoming("99"),
    incoming("farm_orange"),
    vl64(4),
    vl64(6),
    vl64(2),
    vl64(1),
    vl64(4),
    incoming("0.25"),
    incoming(""),
    incoming("fruiting"),
    vl64(3),
    incoming("stage=3"),
    incoming("tail"),
  ].join("");
  const entry = parseRelayLine(sampledRelayLine(95, body.length + 2, body.length, escapeRelayBody(body)), 9);

  assert.ok(entry);
  assert.equal(entry.packetName, "ACTIVEOBJECT_UPDATE");
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate id" && field.value === "99"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate class" && field.value === "farm_orange"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate tile" && field.value === "4, 6, 0.25"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate size" && field.value === "2x1"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate direction" && field.value === "4"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate rawPosition" && field.value.endsWith("0.25")));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate runtime" && field.value === "fruiting"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate state" && field.value === "3"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate stuff" && field.value === "stage=3"));
  assert.ok(entry.decodedFields.some((field) => field.label === "floorObjectUpdate trailing" && field.value === "tail"));
});

test("relay log parser decodes active object add remove and data update rows like v3", () => {
  const rawPosition = [vl64(4), vl64(6), vl64(2), vl64(1), vl64(4)].join("");
  const addBody = [
    incoming("99"),
    incoming("farm_orange"),
    incoming(rawPosition),
    incoming("fruiting"),
    incoming("stage=2"),
    incoming("tail"),
  ].join("");
  const removeBody = incoming("object:99");
  const plantBody = [incoming("99"), incoming("3"), incoming("ripe")].join("");
  const stuffBody = [incoming("99"), incoming("watered")].join("");

  const add = parseRelayLine(sampledRelayLine(93, addBody.length + 2, addBody.length, escapeRelayBody(addBody)), 11);
  const remove = parseRelayLine(sampledRelayLine(94, removeBody.length + 2, removeBody.length, escapeRelayBody(removeBody)), 12);
  const plant = parseRelayLine(sampledRelayLine(87, plantBody.length + 2, plantBody.length, escapeRelayBody(plantBody)), 13);
  const stuff = parseRelayLine(sampledRelayLine(88, stuffBody.length + 2, stuffBody.length, escapeRelayBody(stuffBody)), 14);

  assert.ok(add);
  assert.ok(remove);
  assert.ok(plant);
  assert.ok(stuff);
  assert.equal(add.packetName, "ACTIVEOBJECT_ADD");
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd id" && field.value === "99"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd class" && field.value === "farm_orange"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd tile" && field.value === "4, 6"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd size" && field.value === "2x1"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd direction" && field.value === "4"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd runtime" && field.value === "fruiting"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd stuff" && field.value === "stage=2"));
  assert.ok(add.decodedFields.some((field) => field.label === "activeObjectAdd trailing" && field.value === "tail"));
  assert.equal(remove.packetName, "ACTIVEOBJECT_REMOVE");
  assert.ok(remove.decodedFields.some((field) => field.label === "activeObjectRemove id" && field.value === "99"));
  assert.equal(plant.packetName, "PLANTDATAUPDATE");
  assert.ok(plant.decodedFields.some((field) => field.label === "plantData id" && field.value === "99"));
  assert.ok(plant.decodedFields.some((field) => field.label === "plantData stage" && field.value === "3"));
  assert.ok(plant.decodedFields.some((field) => field.label === "plantData data" && field.value === "ripe"));
  assert.equal(stuff.packetName, "STUFFDATAUPDATE");
  assert.ok(stuff.decodedFields.some((field) => field.label === "floorItemData id" && field.value === "99"));
  assert.ok(stuff.decodedFields.some((field) => field.label === "floorItemData data" && field.value === "watered"));
});

test("relay log parser keeps sensitive v4 relay packet bodies redacted", () => {
  const entry = parseRelayLine(
    "[origins-relay #5] browser -> official encrypted header=4 bytes=38 bodyStatus=redacted bodyLen=36",
    20,
  );

  assert.ok(entry);
  assert.equal(entry.direction, "CLIENT");
  assert.equal(entry.header, 4);
  assert.equal(entry.payloadBytes, 36);
  assert.equal(entry.bodyStatus, "redacted");
  assert.equal(entry.bodyText, null);
  assert.equal(entry.bodyHex, null);
  assert.deepEqual(entry.decodedFields, []);
  assert.match(entry.bodyNote, /Sensitive client payload redacted/);
});

function incoming(value: string): string {
  return `${value}\x02`;
}

function vl64(value: number): string {
  const negative = value < 0;
  let remaining = Math.abs(value);
  const bytes: number[] = [64 + (remaining & 0x03)];
  remaining = Math.floor(remaining / 4);
  while (remaining > 0) {
    bytes.push(64 + (remaining & 0x3f));
    remaining = Math.floor(remaining / 64);
  }
  bytes[0] = bytes[0]! | (bytes.length << 3) | (negative ? 0x04 : 0);
  return String.fromCharCode(...bytes);
}

function base64(value: number, width: number): string {
  const chars = new Array<number>(width);
  let remaining = value;
  for (let index = width - 1; index >= 0; index -= 1) {
    chars[index] = 0x40 + (remaining & 0x3f);
    remaining = Math.floor(remaining / 64);
  }
  return String.fromCharCode(...chars);
}

function escapeRelayBody(value: string): string {
  let escaped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09) escaped += "\\t";
    else if (code === 0x0a) escaped += "\\n";
    else if (code === 0x0d) escaped += "\\r";
    else if (code === 0x5c) escaped += "\\\\";
    else if (code >= 0x20 && code <= 0x7e) escaped += value[index];
    else escaped += `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return escaped;
}

test("relay log parser treats habbpy-control injected packets as outgoing client packets", () => {
  const entry = parseRelayLine(
    '[origins-relay #2] habbpy-control -> official plaintext User wave header=94 header=94 bytes=2 bodyStatus=sampled bodyLen=0 bodySample=""',
    21,
  );

  assert.ok(entry);
  assert.equal(entry.direction, "CLIENT");
  assert.equal(entry.route, "habbpy-control -> official");
  assert.equal(entry.mode, "plaintext");
  assert.equal(entry.header, 94);
  assert.equal(entry.packetName, "WAVE");
  assert.equal(entry.size, 2);
  assert.equal(entry.payloadBytes, 0);
  assert.equal(entry.bodyStatus, "sampled");
  assert.equal(entry.bodyText, "");
  assert.equal(entry.bodyHex, "");
  assert.ok(entry.decodedFields.some((field) => field.label === "decryptedBytes" && field.value === "0"));
});

test("relay log delta snapshots return only appended rows while disk history remains complete", () => {
  const first = sampledRelayLine(24, 16, 14, "hello\\x02world");
  const second = "[origins-relay #4] browser -> official encrypted header=4 bytes=38 bodyStatus=redacted bodyLen=36";
  const third = sampledRelayLine(50, 16, 14, "1781980990552\\x02");
  const temp = writeTempRelayLog([first, second]);

  try {
    const full = readRelayLogSnapshot(temp.appDataPath);
    assert.equal(full.logPath, temp.logPath);
    assert.equal(full.totalLines, 2);
    assert.equal(full.entries.length, 2);
    assert.equal(full.packetCount, 2);
    assert.equal(full.clientCount, 1);
    assert.equal(full.serverCount, 1);

    const unchanged = readRelayLogDeltaSnapshot(temp.appDataPath, full.logPath, full.totalLines);
    assert.equal(unchanged.reset, false);
    assert.equal(unchanged.entries.length, 0);
    assert.equal(unchanged.totalLines, 2);

    appendFileSync(temp.logPath, `${third}\n`, "utf8");
    const appended = readRelayLogDeltaSnapshot(temp.appDataPath, full.logPath, full.totalLines);
    assert.equal(appended.reset, false);
    assert.equal(appended.totalLines, 3);
    assert.equal(appended.packetCount, 3);
    assert.equal(appended.clientCount, 1);
    assert.equal(appended.serverCount, 2);
    assert.equal(appended.entries.length, 1);
    assert.equal(appended.entries[0]?.lineNumber, 3);
    assert.equal(appended.entries[0]?.header, 50);

    const reset = readRelayLogDeltaSnapshot(temp.appDataPath, "F:\\different\\shockless-relay.log", 3);
    assert.equal(reset.reset, true);
    assert.equal(reset.entries.length, 3);
  } finally {
    rmSync(temp.appDataPath, { recursive: true, force: true });
  }
});

test("relay log keeps a bounded live window and pages complete older history from disk", () => {
  const lineCount = RELAY_LOG_LIVE_ENTRY_LIMIT + 125;
  const lines = Array.from({ length: lineCount }, (_, index) =>
    `[origins-relay #4] official -> browser plaintext header=50 bytes=${index + 2}`,
  );
  const temp = writeTempRelayLog(lines);

  try {
    const snapshot = readRelayLogSnapshot(temp.appDataPath);
    assert.equal(snapshot.totalLines, lineCount);
    assert.equal(snapshot.packetCount, lineCount);
    assert.equal(snapshot.entries.length, RELAY_LOG_LIVE_ENTRY_LIMIT);
    assert.equal(snapshot.retainedFromLine, 126);
    assert.equal(snapshot.retainedToLine, lineCount);
    assert.equal(snapshot.historyComplete, false);

    const page = readRelayLogHistoryPage(temp.appDataPath, 1, snapshot.retainedFromLine, 50);
    assert.equal(page.entries.length, 50);
    assert.equal(page.firstSourceLineNumber, 76);
    assert.equal(page.lastSourceLineNumber, 125);
    assert.equal(page.hasMore, true);
    assert.ok(page.entries.every((entry) => entry.message.length > 0));
  } finally {
    rmSync(temp.appDataPath, { recursive: true, force: true });
  }
});

test("relay log 100k-line snapshot does not serialize full history over IPC", () => {
  const lineCount = 100_000;
  const line = "[origins-relay #4] official -> browser plaintext header=50 bytes=16";
  const temp = writeTempRelayLog(Array.from({ length: lineCount }, () => line));

  try {
    const startedAt = performance.now();
    const snapshot = readRelayLogSnapshot(temp.appDataPath);
    const elapsedMs = performance.now() - startedAt;
    const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot));

    assert.equal(snapshot.totalLines, lineCount);
    assert.equal(snapshot.packetCount, lineCount);
    assert.equal(snapshot.entries.length, RELAY_LOG_LIVE_ENTRY_LIMIT);
    assert.equal(snapshot.historyComplete, false);
    assert.ok(serializedBytes < 3 * 1024 * 1024, `serialized snapshot was ${serializedBytes} bytes`);
    assert.ok(elapsedMs < 2_000, `snapshot took ${elapsedMs.toFixed(1)}ms`);

    appendFileSync(temp.logPath, `${line}\n${line}\n`, "utf8");
    const delta = readRelayLogDeltaSnapshot(temp.appDataPath, snapshot.logPath, snapshot.totalLines);
    assert.equal(delta.reset, false);
    assert.equal(delta.totalLines, lineCount + 2);
    assert.equal(delta.entries.length, 2);
  } finally {
    rmSync(temp.appDataPath, { recursive: true, force: true });
  }
});

test("relay log delta paging delivers a burst larger than the live window without gaps", () => {
  const line = "[origins-relay #4] official -> browser plaintext header=50 bytes=16";
  const burstSize = RELAY_LOG_DELTA_ENTRY_LIMIT * 2 + 505;
  const temp = writeTempRelayLog([line]);

  try {
    const initial = readRelayLogSnapshot(temp.appDataPath);
    appendFileSync(temp.logPath, `${Array.from({ length: burstSize }, () => line).join("\n")}\n`, "utf8");

    const received: number[] = [];
    let cursor = initial.totalLines;
    let chunks = 0;
    while (true) {
      const delta = readRelayLogDeltaSnapshot(temp.appDataPath, initial.logPath, cursor);
      assert.equal(delta.reset, false);
      received.push(...delta.entries.map((entry) => entry.lineNumber));
      cursor = delta.nextLineNumber;
      chunks += 1;
      if (!delta.hasMore) break;
      assert.ok(chunks < 10, "delta paging did not terminate");
    }

    assert.equal(chunks, 3);
    assert.equal(received.length, burstSize);
    assert.equal(received[0], 2);
    assert.equal(received.at(-1), burstSize + 1);
    assert.deepEqual(received, Array.from({ length: burstSize }, (_, index) => index + 2));
    assert.equal(cursor, burstSize + 1);
  } finally {
    rmSync(temp.appDataPath, { recursive: true, force: true });
  }
});

test("multi-client aggregation keeps exact totals while retaining only the live tail", () => {
  const appDataPath = mkdtempSync(join(tmpdir(), "habbpy-v4-relay-clients-scale-"));
  const serverLine = "[origins-relay #1] official -> browser plaintext header=24 bytes=16";
  const clientLine = "[origins-relay #2] browser -> official plaintext header=55 bytes=22";
  const clients = [
    { id: 1, label: "Main" },
    { id: 2, label: "Alt" },
  ] as const;
  try {
    writeTempClientRelayLog(appDataPath, 1, Array.from({ length: 1_200 }, () => serverLine));
    const altPath = writeTempClientRelayLog(appDataPath, 2, Array.from({ length: 1_200 }, () => clientLine));

    const snapshot = readRelayLogSnapshot(appDataPath, clients);
    assert.equal(snapshot.totalLines, 2_400);
    assert.equal(snapshot.packetCount, 2_400);
    assert.equal(snapshot.serverCount, 1_200);
    assert.equal(snapshot.clientCount, 1_200);
    assert.equal(snapshot.entries.length, RELAY_LOG_LIVE_ENTRY_LIMIT);
    assert.deepEqual(
      snapshot.clients.map((entry) => [entry.clientId, entry.totalLines, entry.packetCount]),
      [[1, 1_200, 1_200], [2, 1_200, 1_200]],
    );

    appendFileSync(altPath, `${clientLine}\n`, "utf8");
    const delta = readRelayLogDeltaSnapshot(appDataPath, snapshot.logPath, snapshot.totalLines, clients);
    assert.equal(delta.reset, false);
    assert.equal(delta.totalLines, 2_401);
    assert.equal(delta.entries.length, 1);
    assert.equal(delta.entries[0]?.clientId, 2);
    assert.equal(delta.entries[0]?.sourceLineNumber, 1_201);
  } finally {
    rmSync(appDataPath, { recursive: true, force: true });
  }
});
