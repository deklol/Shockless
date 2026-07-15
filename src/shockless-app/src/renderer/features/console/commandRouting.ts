import { runtimeRoomName } from "../../../engine-adapter/shocklessSessionAdapter";
import type { OriginsUserLookupResult } from "../../../shared/window-api";
import type { EngineRuntimeSnapshot, RuntimeUserSummary } from "../../engineRuntime";
import { compactValue, userDisplayName, userPosition } from "../common/model";

export function isRelayBackedConsoleCommand(command: string): boolean {
  return [
    "message",
    "msg",
    "pm",
    "adduser",
    "friend",
    "requests",
    "friendrequests",
    "refreshrequests",
    "accept",
    "acceptfriend",
    "decline",
    "declinefriend",
    "follow",
    "followfriend",
    "removefriend",
    "unfriend",
  ].includes(command);
}

export function commandRefreshesEngineLaunch(command: string, firstArg = ""): boolean {
  return [
    "start",
    "launch",
    "newclient",
    "addclient",
    "login",
    "load",
    "load-store",
    "close",
    "stop",
  ].includes(command) || (command === "accounts" && firstArg.toLowerCase() === "load");
}

export function runtimeLookupLine(user: RuntimeUserSummary, snapshot: EngineRuntimeSnapshot | null): string {
  return [
    `in-game: room=${runtimeRoomName(snapshot)}`,
    `user=${userDisplayName(user, snapshot?.userState?.sessionUserName)}`,
    `account=${compactValue(user.accountId)}`,
    `index=${compactValue(user.roomIndex ?? user.rowId)}`,
    `pos=${userPosition(user)}`,
    `figure=${compactValue(user.figure)}`,
    `badge=${compactValue(user.badgeCode)}`,
  ].join(" ");
}

export function originsLookupLine(result: OriginsUserLookupResult, fallbackName: string): string {
  return [
    "origins:",
    `name=${compactValue(result.name || fallbackName)}`,
    `id=${compactValue(result.id)}`,
    `motto=${compactValue(result.motto)}`,
    `member=${compactValue(result.memberSince)}`,
    `visible=${compactValue(result.profileVisible)}`,
  ].join(" ");
}
