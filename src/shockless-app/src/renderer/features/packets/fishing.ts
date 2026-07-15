import type { RelayLogEntry } from "../../../shared/window-api";
import { compactValue } from "../common/model";
import { packetFieldMap, parsedCount } from "./fields";
import { emptyPacketFishingState, type PacketFishingCatch, type PacketFishingState, type PacketFishopediaEntry } from "./types";

export function packetFishingStateFromEntries(
  entries: readonly RelayLogEntry[],
  startIndex = 0,
  initialState: PacketFishingState = emptyPacketFishingState,
): PacketFishingState {
  let status = initialState.status;
  let note = initialState.note;
  let tokens = initialState.tokens;
  let level = initialState.level;
  let minigameActive = initialState.minigameActive;
  let minigamePin = initialState.minigamePin;
  let minigameValues = initialState.minigameValues;
  let catches = initialState.catches;
  let golden = initialState.golden;
  let xp = initialState.xp;
  let frenzies = initialState.frenzies;
  let lastCatch = initialState.lastCatch;
  let lastClientAction = initialState.lastClientAction;
  let lastClientTargetId = initialState.lastClientTargetId;
  let activeTile = initialState.activeTile;
  let lastSourceLine = initialState.lastSourceLine;
  const catchLog = [...initialState.catchLog];
  const fishopediaByKey = new globalThis.Map<string, PacketFishopediaEntry>();
  for (const entry of initialState.fishopedia) fishopediaByKey.set(entry.key, entry);

  for (let entryIndex = Math.max(0, startIndex); entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]!;
    if (entry.direction !== "SERVER" && entry.direction !== "CLIENT") continue;
    const fields = packetFieldMap(entry);

    if (entry.direction === "CLIENT") {
      const action = compactValue(fields.get("fishingClientAction") ?? fields.get("fishingClientRequest"));
      if (action !== "-") {
        const target = compactValue(fields.get("fishingClientTargetId"));
        const input = compactValue(fields.get("fishingClientInput"));
        lastClientAction = [action, target !== "-" ? `target ${target}` : "", input !== "-" ? input : ""].filter(Boolean).join(" / ");
        if (target !== "-") lastClientTargetId = target;
        lastSourceLine = entry.lineNumber;
      }
      continue;
    }

    if (entry.header === 1107) {
      minigameActive = true;
      status = "minigame";
      note = "Minigame started";
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 1108) {
      minigameActive = true;
      status = "minigame";
      minigamePin = compactValue(fields.get("fishingMinigamePin"));
      minigameValues = compactValue(fields.get("fishingMinigameValues"));
      note = minigamePin !== "-" ? `Minigame pin ${minigamePin}` : "Minigame update";
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 1109) {
      minigameActive = false;
      status = "idle";
      note = "Minigame ended";
      activeTile = null;
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 1102) {
      tokens = compactValue(fields.get("fishTokens"));
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 680) {
      const nextLevel = compactValue(fields.get("fishingLevel"));
      if (nextLevel !== "-") {
        level = nextLevel;
        note = `Fishing level ${nextLevel}`;
      }
      if (compactValue(fields.get("fishingFrenzyActive")) === "true") {
        frenzies += 1;
        status = "frenzy";
        note = "Fishing frenzy started";
      }
      const derby = compactValue(fields.get("fishingDerbyMessage"));
      if (derby !== "-") note = derby;
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 1101) {
      if (compactValue(fields.get("fishingSlipAway")) === "true") {
        status = "idle";
        minigameActive = false;
        activeTile = null;
        note = "Fish slipped away";
        lastSourceLine = entry.lineNumber;
      }
      const fishName = compactValue(fields.get("fishingCatchName"));
      if (fishName !== "-") {
        const catchXp = Number.parseInt(compactValue(fields.get("fishingCatchXp")), 10);
        const goldenCatch = compactValue(fields.get("fishingCatchGolden")) === "true";
        const caught: PacketFishingCatch = {
          key: `line:${entry.lineNumber}:${fishName}:${compactValue(fields.get("fishingCatchXp"))}`,
          fishName,
          message: compactValue(fields.get("fishingCatchMessage")),
          xp: Number.isFinite(catchXp) ? catchXp : 0,
          golden: goldenCatch,
          sourceLine: entry.lineNumber,
        };
        if (!catchLog.some((existing) => existing.key === caught.key)) {
          catches += 1;
          xp += caught.xp;
          if (caught.golden) golden += 1;
          catchLog.push(caught);
        }
        lastCatch = caught;
        minigameActive = false;
        activeTile = null;
        status = caught.golden ? "golden-catch" : "catch";
        note = `${caught.fishName} (+${caught.xp} XP)`;
        lastSourceLine = entry.lineNumber;
      }
    } else if (entry.header === 1115) {
      const count = parsedCount(fields.get("fishopediaCount"));
      if (count !== null) {
        fishopediaByKey.clear();
        for (let row = 1; row <= count; row += 1) {
          const fish = packetFishopediaEntryFromPrefix(fields, `fishopedia ${row}`, entry.lineNumber);
          if (fish) fishopediaByKey.set(fish.key, fish);
        }
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 1116) {
      const fish = packetFishopediaEntryFromPrefix(fields, "fishopediaFish", entry.lineNumber);
      if (fish) {
        fishopediaByKey.set(fish.key, fish);
        note = `Fishopedia updated: ${fish.fishName}`;
      }
      lastSourceLine = entry.lineNumber;
    } else if (entry.header === 34) {
      const statusRows = parsedCount(fields.get("statusRows")) ?? 0;
      for (let row = 1; row <= statusRows; row += 1) {
        const statusText = compactValue(fields.get(`statusState ${row}`) ?? fields.get(`statusRow ${row}`)).toLowerCase();
        if (/(^|\/|\s)fsh\b/.test(statusText)) {
          status = "fishing";
          activeTile = fishingStatusTile(statusText, entry.lineNumber);
          note = "Fishing status active";
          lastSourceLine = entry.lineNumber;
          break;
        }
      }
    }
  }

  return {
    status,
    note,
    tokens,
    level,
    minigameActive,
    minigamePin,
    minigameValues,
    catches,
    golden,
    xp,
    frenzies,
    fishopedia: [...fishopediaByKey.values()].sort((left, right) => left.fishName.localeCompare(right.fishName)),
    catchLog: catchLog.slice(-100),
    lastCatch,
    lastClientAction,
    lastClientTargetId,
    activeTile,
    lastSourceLine,
  };
}

function fishingStatusTile(statusText: string, sourceLine: number): PacketFishingState["activeTile"] {
  const match = statusText.match(/\bfsh\s+(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i);
  if (!match) return null;
  return {
    x: Number.parseInt(match[1]!, 10),
    y: Number.parseInt(match[2]!, 10),
    state: Number.parseInt(match[4]!, 10),
    raw: statusText,
    sourceLine,
  };
}

export function packetFishopediaEntryFromPrefix(fields: ReadonlyMap<string, string>, prefix: string, sourceLine: number): PacketFishopediaEntry | null {
  const fishName = compactValue(fields.get(`${prefix} name`));
  if (fishName === "-") return null;
  return {
    key: fishName.trim().toLowerCase(),
    fishName,
    xp: compactValue(fields.get(`${prefix} xp`)),
    catches: compactValue(fields.get(`${prefix} catches`)),
    completion: compactValue(fields.get(`${prefix} completion`)),
    location: compactValue(fields.get(`${prefix} location`)),
    sourceLine,
  };
}
