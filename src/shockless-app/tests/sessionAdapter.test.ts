import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runtimeLocation,
  runtimeRoomName,
  summarizeRuntimeSnapshot,
} from "../src/engine-adapter/shocklessSessionAdapter";
import type { EngineRuntimeSnapshot } from "../src/renderer/engineRuntime";

function baseSnapshot(overrides: Partial<EngineRuntimeSnapshot> = {}): EngineRuntimeSnapshot {
  return {
    hasEngine: true,
    title: "Habbo Hotel: Origins",
    href: "http://127.0.0.1:50000/",
    errors: 0,
    frame: 100,
    castLoaded: true,
    loadedCastCount: 20,
    networkBridgeUrl: "ws://127.0.0.1:1",
    roomReady: null,
    roomEntryState: null,
    performanceStats: null,
    editableFields: [],
    windowIds: [],
    objectCount: 0,
    chatHistory: [],
    scriptBundle: null,
    activeSprites: [],
    roomObjects: null,
    userState: null,
    inventory: null,
    navigator: null,
    customHotelView: null,
    ...overrides,
  };
}

test("session adapter normalizes room, account, diagnostics, and source item rows", () => {
  const snapshot = baseSnapshot({
    errors: 2,
    performanceStats: {
      rafPerSecond: 59.6,
      directorTicksPerSecond: 30.2,
    },
    roomReady: {
      ready: true,
      roomId: "private",
      roomType: "#private",
    },
    roomEntryState: {
      lastroom: {
        "#flatId": 224520,
        "#name": "Codex Test LAB",
        "#owner": "dek",
        "#type": "#private",
      },
      roomComponent: {
        pActiveFlag: 1,
      },
    },
    roomObjects: {
      keys: ["activeObjects", "wallItems"],
      counts: {
        users: 2,
        activeObjects: 5,
        passiveObjects: 1,
        wallItems: 3,
      },
      users: [],
      activeObjects: [
        { objectId: 11, className: "farm_orange" },
      ],
      passiveObjects: [
        { objectId: 12, className: "passive_fixture" },
      ],
      wallItems: [
        { objectId: 13, className: "poster", wall: "1,2", local: "3,4", orientation: "l" },
      ],
    },
    userState: {
      source: "Session.pitemlist + roomObjects.users",
      sessionUserName: "dek",
      roomName: "Codex Test LAB",
      roomOwner: "dek",
      roomId: 224520,
      roomType: "#private",
      rightsCount: 12,
      rights: ["room_owner"],
      roomUserCount: 2,
      users: [
        {
          rowId: "0",
          badgeCode: "ADM",
          sourceKeys: ["name", "badgeCode"],
        },
      ],
      sessionKeys: ["#userName"],
      missingProfileFields: [],
    },
  });

  const summary = summarizeRuntimeSnapshot(snapshot);

  assert.equal(summary.roomReady, true);
  assert.equal(summary.visitorRoomKey, "private:224520");
  assert.equal(summary.visitorRoomName, "Codex Test LAB");
  assert.deepEqual(summary.engine, {
    running: true,
    embedded: true,
    location: "Codex Test LAB",
    fps: 60,
    tickRate: 30,
    errors: 2,
  });
  assert.deepEqual(summary.room, {
    id: "224520",
    name: "Codex Test LAB",
    owner: "dek",
    type: "private",
    users: 2,
    floorItems: 6,
    wallItems: 3,
  });
  assert.deepEqual(summary.account, {
    name: "dek",
    badge: "ADM",
  });
  assert.equal(summary.itemRows.length, 3);
  assert.equal(summary.itemRows[0]?.source, "roomObjects.activeObjects");
  assert.equal(summary.itemRows[1]?.source, "roomObjects.passiveObjects");
  assert.equal(summary.itemRows[2]?.source, "roomObjects.wallItems");
});

test("runtime snapshot carries parsed Navigator public room nodes", () => {
  const snapshot = baseSnapshot({
    navigator: {
      total: 3,
      categories: 1,
      publicRooms: 2,
      privateRooms: 0,
      sample: [],
      publicRoomNodes: [
        {
          id: 7,
          name: "Welcome Lounge",
          unitStrId: "hh_room_welcome",
          port: 54001,
          users: 12,
          maxUsers: 25,
          nodeType: 1,
        },
      ],
    },
  });

  assert.equal(snapshot.navigator?.publicRoomNodes[0]?.name, "Welcome Lounge");
  assert.equal(snapshot.navigator?.publicRoomNodes[0]?.unitStrId, "hh_room_welcome");
});

test("session adapter reports login and hotel-view locations without fake room data", () => {
  const loginSnapshot = baseSnapshot({
    roomReady: { ready: false },
    editableFields: [
      { n: 1, member: "login_name", rect: [0, 0, 10, 10], text: "" },
      { n: 2, member: "login_password", rect: [0, 10, 10, 20], text: "" },
    ],
  });
  const hotelSnapshot = baseSnapshot({
    roomEntryState: {
      lastroom: "Entry",
    },
  });

  assert.equal(runtimeLocation(loginSnapshot), "Login screen");
  assert.equal(runtimeRoomName(loginSnapshot), "Login screen");
  assert.equal(summarizeRuntimeSnapshot(loginSnapshot).room.type, "unknown");
  assert.equal(runtimeLocation(hotelSnapshot), "Hotel view");
  assert.equal(summarizeRuntimeSnapshot(hotelSnapshot).room.type, "hotel-view");
});
