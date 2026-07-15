import { CastMember, CastRegistry } from "@director/members";
import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LINGO_VOID, LingoFloat, LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";

const installedRuntimes = new WeakSet<Runtime>();

interface MemberAliasEntry {
  alias: string;
  aliasLower: string;
  target: string;
  negated: boolean;
}

const memberAliasCache = new WeakMap<CastMember, { textVersion: number; entries: MemberAliasEntry[] }>();

function isIntegerValue(value: LingoValue): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function castNameForNumber(runtime: Runtime, castNumber: number): string {
  const castRef = runtime.call("castlib", [castNumber]);
  if (castRef === undefined || castRef instanceof LingoVoid) return "";
  return ops.stringOf(runtime.getProp(castRef, "name")).trim();
}

function optionalRuntimeCall(runtime: Runtime, name: string, args: LingoValue[]): LingoValue {
  try {
    return runtime.call(name, args) ?? LINGO_VOID;
  } catch {
    return LINGO_VOID;
  }
}

function memberNamed(members: CastRegistry, castName: string, memberName: string) {
  return members.find(memberName, castName);
}

function parsedMemberAliasIndex(member: CastMember): MemberAliasEntry[] {
  const cached = memberAliasCache.get(member);
  if (cached?.textVersion === member.textVersion) return cached.entries;
  const entries: MemberAliasEntry[] = [];
  for (const rawLine of member.text.split(/\r\n|\r|\n/)) {
    if (rawLine.length <= 2) continue;
    const equalsAt = rawLine.indexOf("=");
    if (equalsAt <= 0) continue;
    const alias = rawLine.slice(0, equalsAt);
    let target = rawLine.slice(equalsAt + 1);
    let negated = false;
    if (target.endsWith("*")) {
      target = target.slice(0, -1);
      negated = true;
    }
    entries.push({
      alias,
      aliasLower: alias.toLowerCase(),
      target,
      negated,
    });
  }
  memberAliasCache.set(member, { textVersion: member.textVersion, entries });
  return entries;
}

function setResourceMemberIndex(index: LingoPropList, key: string, value: number): void {
  if (key.length === 0) return;
  index.setaProp(key, value, ops.lingoKeyEquals);
}

function stringKey(value: LingoValue): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function indexedMemberNumber(resourceManager: ScriptInstance, key: string): number {
  const allMembers = resourceManager.props.get("pallmemnumlist");
  if (!(allMembers instanceof LingoPropList)) return 0;
  const value = allMembers.getaProp(key, ops.lingoKeyEquals);
  return typeof value === "number" ? value : 0;
}

function memberNumberForName(members: CastRegistry, memberName: string): number {
  const member = members.find(memberName, null);
  return member?.slotNumber ?? 0;
}

function memberForSlotNumber(members: CastRegistry, slotNumber: number) {
  return members.find(slotNumber, null);
}

function isColorlessPaletteSlot(members: CastRegistry, slotNumber: number): boolean {
  const member = memberForSlotNumber(members, slotNumber);
  return (
    member?.type.toLowerCase() === "palette" &&
    (!Array.isArray(member.paletteColors) || member.paletteColors.length === 0)
  );
}

function isUsablePaletteSlot(members: CastRegistry, slotNumber: number): boolean {
  const member = memberForSlotNumber(members, slotNumber);
  return member?.type.toLowerCase() === "palette" && Array.isArray(member.paletteColors) && member.paletteColors.length > 0;
}

function colorBackedPaletteAliasNumber(
  resourceManager: ScriptInstance,
  members: CastRegistry,
  memberName: string,
  currentNumber: number,
): number {
  if (!isColorlessPaletteSlot(members, currentNumber)) return currentNumber;
  if (memberName.toLowerCase().startsWith("catalog_")) return currentNumber;

  const catalogName = `catalog_${memberName}`;
  const catalogIndexed = indexedMemberNumber(resourceManager, catalogName);
  if (catalogIndexed !== 0 && isUsablePaletteSlot(members, catalogIndexed)) return catalogIndexed;

  const catalogFallback = memberNumberForName(members, catalogName);
  if (catalogFallback !== 0 && isUsablePaletteSlot(members, catalogFallback)) return catalogFallback;

  return currentNumber;
}

function aliasMemberNumber(
  resourceManager: ScriptInstance,
  members: CastRegistry,
  memberName: string,
  seen = new Set<string>(),
): number {
  const wanted = memberName.toLowerCase();
  if (seen.has(wanted)) return 0;
  seen.add(wanted);

  for (const castName of members.loaded) {
    const aliasMember = memberNamed(members, castName, "memberalias.index");
    if (!aliasMember || aliasMember.name !== "memberalias.index") continue;
    for (const { aliasLower, target, negated } of parsedMemberAliasIndex(aliasMember)) {
      if (aliasLower !== wanted) continue;
      const indexed = indexedMemberNumber(resourceManager, target);
      const direct = indexed !== 0 ? indexed : memberNumberForName(members, target);
      const resolved = direct !== 0 ? direct : aliasMemberNumber(resourceManager, members, target, seen);
      return negated ? -resolved : resolved;
    }
  }

  return 0;
}

function getMemberNumber(resourceManager: ScriptInstance, members: CastRegistry, memberNameValue: LingoValue): number {
  const memberName = ops.stringOf(memberNameValue);
  if (memberName.length === 0) return 0;
  const indexed = indexedMemberNumber(resourceManager, memberName);
  const allMembers = resourceManager.props.get("pallmemnumlist");
  if (indexed !== 0) {
    const resolved = colorBackedPaletteAliasNumber(resourceManager, members, memberName, indexed);
    if (resolved !== indexed && allMembers instanceof LingoPropList) {
      setResourceMemberIndex(allMembers, memberName, resolved);
    }
    return resolved;
  }
  const fallback = memberNumberForName(members, memberName);
  if (fallback !== 0 && allMembers instanceof LingoPropList) {
    setResourceMemberIndex(allMembers, memberName, colorBackedPaletteAliasNumber(resourceManager, members, memberName, fallback));
  }
  if (fallback !== 0) return colorBackedPaletteAliasNumber(resourceManager, members, memberName, fallback);
  const alias = aliasMemberNumber(resourceManager, members, memberName);
  if (alias !== 0 && allMembers instanceof LingoPropList) {
    setResourceMemberIndex(allMembers, memberName, colorBackedPaletteAliasNumber(resourceManager, members, memberName, alias));
  }
  return alias !== 0 ? colorBackedPaletteAliasNumber(resourceManager, members, memberName, alias) : alias;
}

export function indexRelease306MemberAliases(resourceManager: ScriptInstance, members: CastRegistry, castName: string): number {
  const allMembers = resourceManager.props.get("pallmemnumlist");
  if (!(allMembers instanceof LingoPropList)) return 0;
  const aliasMember = memberNamed(members, castName, "memberalias.index");
  if (!aliasMember || aliasMember.name !== "memberalias.index") return 0;

  for (const { alias, target, negated } of parsedMemberAliasIndex(aliasMember)) {
    const targetNumber = getMemberNumber(resourceManager, members, target);
    if (typeof targetNumber === "number" && targetNumber > 0) {
      setResourceMemberIndex(allMembers, alias, negated ? -targetNumber : targetNumber);
    }
  }
  return 1;
}

function preIndexCast(
  runtime: Runtime,
  resourceManager: ScriptInstance,
  members: CastRegistry,
  castName: string,
  castNumber: number,
): number {
  const allMembers = resourceManager.props.get("pallmemnumlist");
  if (!(allMembers instanceof LingoPropList)) return 0;

  for (const member of members.membersOf(castName)) {
    setResourceMemberIndex(allMembers, member.name, member.slotNumber);
  }

  const variableManager = runtime.call("getvariablemanager", []) ?? LINGO_VOID;
  const variableIndex = memberNamed(members, castName, "variable.index");
  if (variableIndex) {
    runtime.callMethod(variableManager, "dump", [variableIndex.slotNumber, "\r", 0]);
  }
  const overrideVariableIndex = memberNamed(members, castName, "override.variable.index");
  if (overrideVariableIndex) {
    runtime.callMethod(variableManager, "dump", [overrideVariableIndex.slotNumber, "\r", 1]);
  }

  indexRelease306MemberAliases(resourceManager, members, castName);

  const classIndex = memberNamed(members, castName, "class.index");
  if (classIndex) {
    const classes = runtime.call("getobject", [LingoSymbol.for("classes")]) ?? LINGO_VOID;
    runtime.callMethod(classes, "dump", [classIndex.slotNumber]);
  }

  return castNumber > 0 ? 1 : 0;
}

function preIndexMembers(
  runtime: Runtime,
  resourceManager: ScriptInstance,
  members: CastRegistry,
  castNumberValue: LingoValue,
): number {
  if (runtime.call("getintvariable", ["duplicate.name.alert", 0]) !== 0) {
    return 0;
  }

  if (isIntegerValue(castNumberValue)) {
    const castName = castNameForNumber(runtime, castNumberValue);
    if (castName.length === 0) return 0;
    return preIndexCast(runtime, resourceManager, members, castName, castNumberValue);
  }

  const index = new LingoPropList();
  resourceManager.props.set("pallmemnumlist", index);
  for (const castName of members.loaded) {
    const castMembers = members.membersOf(castName);
    const castNumber = castMembers.find((member) => member.castNumber > 0)?.castNumber ?? 0;
    if (castNumber > 0) preIndexCast(runtime, resourceManager, members, castName, castNumber);
  }
  return 1;
}

function unregisterMembersFast(
  runtime: Runtime,
  resourceManager: ScriptInstance,
  members: CastRegistry,
  castNumberValue: LingoValue,
): LingoValue | null {
  if (castNumberValue instanceof LingoVoid) return null;
  const castNumber =
    typeof castNumberValue === "number"
      ? castNumberValue
      : castNumberValue instanceof LingoFloat
        ? Math.round(castNumberValue.value)
        : 0;
  if (!Number.isInteger(castNumber) || castNumber <= 0) return null;

  const allMembers = resourceManager.props.get("pallmemnumlist");
  if (!(allMembers instanceof LingoPropList)) return null;

  const castName = castNameForNumber(runtime, castNumber);
  if (castName.length === 0) return 1;

  const deleteKeys = new Set<string>();
  const castMemberNames = new Set<string>();
  for (const member of members.membersOf(castName)) {
    if (member.name.length === 0) continue;
    castMemberNames.add(member.name.toLowerCase());
    if (ops.truthy(ops.eq(allMembers.getaProp(member.name, ops.lingoKeyEquals), member.slotNumber))) {
      deleteKeys.add(member.name.toLowerCase());
    }
  }

  const aliasIndex = optionalRuntimeCall(runtime, "getvariable", ["alias.index.field"]);
  const aliasMember = members.find(aliasIndex, castName);
  if (aliasMember && aliasMember.number > 0) {
    for (const rawLine of aliasMember.text.split(/\r\n|\r|\n/)) {
      if (rawLine.length <= 2) continue;
      const equalsAt = rawLine.indexOf("=");
      if (equalsAt <= 0) continue;
      const alias = rawLine.slice(0, equalsAt);
      let target = rawLine.slice(equalsAt + 1);
      if (target.endsWith("*")) target = target.slice(0, -1);
      if (!(allMembers.getaProp(target, ops.lingoKeyEquals) instanceof LingoVoid) && alias.length > 0) {
        deleteKeys.add(alias.toLowerCase());
      }
    }
  }

  if (deleteKeys.size > 0) {
    allMembers.deletePropsWhere((key) => {
      const normalized = stringKey(key);
      return normalized !== null && deleteKeys.has(normalized);
    });
  }

  const dynamicMembers = resourceManager.props.get("pdynmemnumlist");
  if (dynamicMembers instanceof LingoList && castMemberNames.size > 0) {
    dynamicMembers.deleteWhere((value) => {
      const normalized = stringKey(value);
      return normalized !== null && castMemberNames.has(normalized);
    });
  }

  return 1;
}

export function installRelease306ResourceManagerCompatibility(runtime: Runtime, members: CastRegistry): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (receiver instanceof ScriptInstance && receiver.module.scriptName === "Resource Manager Class") {
      const lowerMethod = method.toLowerCase();
      if (lowerMethod === "readaliasindexesfromfield") {
        const castNumberArg = args[1];
        const castNumber =
          typeof castNumberArg === "number"
            ? castNumberArg
            : castNumberArg instanceof LingoFloat
              ? Math.round(castNumberArg.value)
              : 0;
        const castName = castNumber > 0 ? castNameForNumber(runtime, castNumber) : "";
        if (castName.length > 0 && indexRelease306MemberAliases(receiver, members, castName)) {
          return LINGO_VOID;
        }
      }
      if (lowerMethod === "getmemnum") {
        return getMemberNumber(receiver, members, args[0] ?? LINGO_VOID);
      }
      if (lowerMethod === "exists") {
        return getMemberNumber(receiver, members, args[0] ?? LINGO_VOID) !== 0 ? 1 : 0;
      }
      if (lowerMethod === "preindexmembers") {
        if (preIndexMembers(runtime, receiver, members, args[0] ?? LINGO_VOID)) {
          return 1;
        }
      }
      if (lowerMethod === "unregistermembers") {
        const result = unregisterMembersFast(runtime, receiver, members, args[0] ?? LINGO_VOID);
        if (result !== null) return result;
      }
    }
    return originalCallMethod(receiver, method, args);
  };
}
