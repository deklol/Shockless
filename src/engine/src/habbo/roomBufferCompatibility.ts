import * as ops from "@director/ops";
import { CastRegistry } from "@director/members";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";
import {
  isRelease306DynamicRoomCast,
  RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE,
} from "./roomAssetVariables";
import { indexRelease306MemberAliases } from "./resourceManagerCompatibility";

const installedRuntimes = new WeakSet<Runtime>();

function normalizedCastName(value: LingoValue): string {
  return ops.stringOf(value).trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function release306NormalizedCastName(value: LingoValue): string {
  const text = ops.stringOf(value);
  if (text.length === 0) return "";
  const queryOffset = text.indexOf("?");
  return (queryOffset >= 0 ? text.slice(0, queryOffset) : text)
    .replace(/["\r\[\] ]/g, "")
    .toLowerCase();
}

function normalizedFurnitureClassName(value: string): string {
  return stripSmallFurniturePrefix(value.trim().replace(/^["']|["']$/g, "").toLowerCase());
}

export function release306DynamicFurnitureCastNamesFromValue(value: LingoValue): string[] {
  if (!(value instanceof LingoList)) return [];
  const seen = new Set<string>();
  const casts: string[] = [];
  for (const item of value.items) {
    const castName = normalizedCastName(item);
    if (!isRelease306DynamicRoomCast(castName) || seen.has(castName)) continue;
    seen.add(castName);
    casts.push(castName);
  }
  return casts;
}

export function isRelease306SmallScaleFurnitureCastName(castName: string): boolean {
  const normalized = castName.trim().replace(/^["']|["']$/g, "").toLowerCase();
  if (normalized === "hh_furni_small") return false;
  return normalized.includes("_s_") || normalized.endsWith("_50") || normalized.endsWith("_small");
}

export function shouldUseRelease306SmallRoomMembers(
  currentScale: LingoValue,
  sourceIsSmallRoom: LingoValue,
): boolean {
  return (
    currentScale instanceof LingoSymbol &&
    (currentScale.name.toLowerCase() === "small" || currentScale.name.toLowerCase() === "large") &&
    ops.truthy(sourceIsSmallRoom)
  );
}

export function release306FurnitureScaleFromGeometry(currentScale: LingoValue, sourceIsSmallRoom: LingoValue): LingoValue {
  if (!(currentScale instanceof LingoSymbol)) return currentScale;
  const scale = currentScale.name.toLowerCase();
  if (scale !== "small" && scale !== "large") return currentScale;
  return shouldUseRelease306SmallRoomMembers(currentScale, sourceIsSmallRoom)
    ? LingoSymbol.for("small")
    : LingoSymbol.for("large");
}

function stripSmallFurniturePrefix(value: string): string {
  return value.toLowerCase().startsWith("s_") ? value.slice(2) : value;
}

function keyToString(value: LingoValue): string {
  if (value instanceof LingoVoid) return "";
  const text = ops.stringOf(value);
  if (text.length === 0) return "";
  return text.startsWith("#") ? text.slice(1) : text;
}

function propValue(list: LingoPropList, key: string): LingoValue {
  return list.getaProp(LingoSymbol.for(key), ops.lingoKeyEquals);
}

function instancePropList(instance: ScriptInstance, name: string): LingoPropList | null {
  const value = instance.props.get(name.toLowerCase());
  return value instanceof LingoPropList ? value : null;
}

function setPropListValue(list: LingoPropList, key: LingoValue, value: LingoValue): void {
  list.setaProp(key, value, ops.lingoKeyEquals);
}

function sourceClassNameFast(
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  obj: LingoPropList,
): string {
  const classValue = propValue(obj, "class");
  if (classValue instanceof LingoVoid) return "";
  let name = ops.stringOf(classValue);
  if (name.includes("*")) {
    name = name.split("*", 1)[0] ?? "";
  }
  const baseName = name;
  const typeValue = propValue(obj, "type");
  const typeText = typeValue instanceof LingoVoid ? "" : ops.stringOf(typeValue);
  if (typeText !== "") {
    if (baseName === "poster") {
      name = `${name} ${typeText}`;
    } else if (baseName === "window") {
      name = typeText.startsWith("_") ? `${name}${typeText}` : `${name}_${typeText}`;
    }
  }
  if (ops.truthy(originalCallMethod(receiver, "issmallroom", []))) {
    name = name.length < 2 || !name.toLowerCase().startsWith("s_") ? `s_${name}` : name;
  }
  return keyToString(name);
}

function classFromFurnitureMemberName(memberName: string): string {
  const normalized = memberName.trim().toLowerCase();
  if (normalized.length === 0) return "";
  for (const suffix of [".data", ".props"]) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return stripSmallFurniturePrefix(normalized.slice(0, -suffix.length));
    }
  }
  const layerOffset = normalized.indexOf("_a_0_");
  if (layerOffset > 0) {
    const className = normalized.slice(0, layerOffset);
    return className.includes(" ") ? "" : stripSmallFurniturePrefix(className);
  }
  return "";
}

function textMemberNamed(
  members: CastRegistry,
  castName: string,
  memberName: string,
): { text?: string; name: string } | null {
  const wanted = memberName.toLowerCase();
  const loaded = members
    .membersOf(castName)
    .find((member) => member.name.toLowerCase() === wanted);
  if (loaded) return { text: loaded.text, name: loaded.name };
  return members
    .definedMembersOf(castName)
    .find((member) => member.name.toLowerCase() === wanted) ?? null;
}

function recordClassCastIndexFast(receiver: ScriptInstance, className: string, castName: string): number {
  const classToCast = instancePropList(receiver, "pclasstocast");
  if (!classToCast) return 0;
  const normalizedClass = keyToString(className);
  const normalizedCast = normalizedCastName(castName);
  if (normalizedClass === "" || normalizedCast === "") return 0;
  setPropListValue(classToCast, normalizedClass, normalizedCast);
  return 1;
}

function indexFurnitureCastAssetsFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  members: CastRegistry,
  castName: string,
): number | null {
  const assetIndexed = instancePropList(receiver, "passetindexedcasts");
  if (!assetIndexed) return null;
  if (!(assetIndexed.getaProp(castName, ops.lingoKeyEquals) instanceof LingoVoid)) return 1;

  const assetIndex = textMemberNamed(members, castName, "asset.index");
  if (!assetIndex || assetIndex.name !== "asset.index") {
    setPropListValue(assetIndexed, castName, LingoSymbol.for("missing"));
    return 0;
  }

  const classContainer = originalCallMethod(receiver, "getroomclasscontainer", []);
  if (!(classContainer instanceof ScriptInstance)) {
    // Source cannot apply asset.index without Room Classes either. Leave the
    // cast unmarked as loaded so isCastReady will re-run markCastReady after
    // the room component has constructed its class container.
    return null;
  }

  let indexed = 0;
  for (const rawLine of (assetIndex.text ?? "").split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length <= 3) continue;
    const lineData = runtime.call("value", [line]);
    if (!(lineData instanceof LingoPropList)) continue;
    let assetId = propValue(lineData, "id");
    if (assetId instanceof LingoVoid) continue;
    let assetIdText = ops.stringOf(assetId);
    if (assetIdText === "") continue;
    if (assetIdText.toLowerCase().startsWith("s_") && assetIdText.length > 2) {
      assetIdText = assetIdText.slice(2);
    }
    const assetClasses = propValue(lineData, "classes");
    if (assetClasses instanceof LingoVoid) continue;
    runtime.callMethod(classContainer, "set", [assetIdText, assetClasses]);
    recordClassCastIndexFast(receiver, assetIdText, castName);
    indexed += 1;
  }

  setPropListValue(assetIndexed, castName, 1);
  return indexed > 0 ? 1 : 0;
}

function indexFurnitureCastAliasesFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  members: CastRegistry,
  castName: string,
): number {
  const aliasIndexed = instancePropList(receiver, "paliasindexedcasts");
  if (!aliasIndexed) return 0;
  if (!(aliasIndexed.getaProp(castName, ops.lingoKeyEquals) instanceof LingoVoid)) return 1;
  const resourceManager = runtime.call("getresourcemanager", []);
  if (!(resourceManager instanceof ScriptInstance)) return 0;
  const indexed = indexRelease306MemberAliases(resourceManager, members, castName);
  if (indexed) {
    setPropListValue(aliasIndexed, castName, 1);
  }
  return indexed;
}

function inferFurnitureCastClassesFast(receiver: ScriptInstance, members: CastRegistry, castName: string): number {
  let inferred = 0;
  for (const className of release306FurnitureClassesDefinedByCast(members, castName)) {
    const classToCast = instancePropList(receiver, "pclasstocast");
    if (!classToCast) return inferred;
    if (classToCast.getaProp(className, ops.lingoKeyEquals) instanceof LingoVoid) {
      inferred += 1;
    }
    recordClassCastIndexFast(receiver, className, castName);
  }
  return inferred > 0 ? 1 : 0;
}

function markCastReadyFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  members: CastRegistry,
  castNameValue: LingoValue,
): LingoValue | null {
  const castName = normalizedCastName(castNameValue);
  if (castName === "") return null;
  const assetResult = indexFurnitureCastAssetsFast(runtime, receiver, originalCallMethod, members, castName);
  if (assetResult === null) return null;
  indexFurnitureCastAliasesFast(runtime, receiver, members, castName);
  inferFurnitureCastClassesFast(receiver, members, castName);
  const loadedCasts = instancePropList(receiver, "ploadedcasts");
  if (!loadedCasts) return null;
  setPropListValue(loadedCasts, castName, 1);
  return 1;
}

function handleFurnitureCastLoadedBatched(
  runtime: Runtime,
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  members: CastRegistry,
  castNameValue: LingoValue,
): LingoValue | null {
  const castName = normalizedCastName(castNameValue);
  if (castName === "") return null;
  const queuedCasts = instancePropList(receiver, "pqueuedcasts");
  if (!queuedCasts) return null;

  queuedCasts.deleteProp(castName, ops.lingoKeyEquals);
  if (!ops.truthy(originalCallMethod(receiver, "furniturecasthasmembers", [castName]))) {
    return null;
  }

  const markResult = markCastReadyFast(runtime, receiver, originalCallMethod, members, castName);
  if (markResult === null) {
    return null;
  }

  const pendingPlaceholders = Number(originalCallMethod(receiver, "pendingplaceholdercount", [])) || 0;
  if (pendingPlaceholders <= 0) return 1;

  // Release306 finalizes after each dynamic cast callback, which was fine for
  // network-era single-cast downloads. In this engine local cast metadata is
  // queued in one burst, so scanning every placeholder after every callback
  // repeats the same source loop several times. Keep source finalization
  // order, but run it once after the current cast burst has drained.
  if (queuedCasts.count() > 0) {
    return 1;
  }
  const replaced = replaceReadyPlaceholdersFast(runtime, receiver, originalCallMethod, members);
  return replaced ?? originalCallMethod(receiver, "replacereadyplaceholders", ["", ""]);
}

function loadedDynamicCastList(receiver: ScriptInstance): string[] | null {
  const loadedCasts = instancePropList(receiver, "ploadedcasts");
  if (!loadedCasts) return null;
  return loadedCasts.keys
    .map((key) => normalizedCastName(key))
    .filter((castName) => castName.length > 0);
}

function loadedCastForPlaceholder(
  runtime: Runtime,
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  members: CastRegistry,
  obj: LingoPropList,
  loadedCasts: Set<string>,
): string | null {
  const className = sourceClassNameFast(receiver, originalCallMethod, obj);
  if (className.length === 0) return null;
  const indexedCast = classCastFromBufferIndex(receiver, className);
  if (indexedCast.length > 0) {
    return loadedCasts.has(indexedCast) ? indexedCast : null;
  }
  const owners = release306DynamicFurnitureOwners(runtime, members, className).filter((castName) =>
    loadedCasts.has(castName),
  );
  return owners.length === 1 ? owners[0]! : null;
}

function callIfHandler(
  runtime: Runtime,
  receiver: LingoValue,
  method: string,
  args: LingoValue[],
): LingoValue {
  if (!(receiver instanceof ScriptInstance) || !runtime.hasHandler(receiver, method)) return 0;
  return runtime.callMethod(receiver, method, args);
}

function executeRoomAssetMessage(runtime: Runtime, message: string, arg?: LingoValue): void {
  runtime.call(
    "executemessage",
    arg === undefined ? [LingoSymbol.for(message)] : [LingoSymbol.for(message), arg],
  );
}

function replaceReadyPlaceholdersFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  originalCallMethod: Runtime["callMethod"],
  members: CastRegistry,
): LingoValue | null {
  if (!ops.truthy(originalCallMethod(receiver, "isenabled", []))) return 0;
  const placeholderTypes = instancePropList(receiver, "pplaceholderlist");
  if (!placeholderTypes) return null;
  const loadedCasts = loadedDynamicCastList(receiver);
  if (!loadedCasts) return null;
  const loadedCastSet = new Set(loadedCasts);
  if (loadedCastSet.size === 0) return 0;

  const roomComponent = originalCallMethod(receiver, "getroomcomponent", []);
  if (roomComponent === 0 || roomComponent instanceof LingoVoid) return 0;

  for (let typeIndex = 1; typeIndex <= placeholderTypes.count(); typeIndex += 1) {
    const typeName = keyToString(placeholderTypes.getPropAt(typeIndex));
    const list = placeholderTypes.getAt(typeIndex);
    if (!(list instanceof LingoPropList)) return null;
    let updated = 0;

    for (let index = list.count(); index >= 1; index -= 1) {
      const tid = list.getPropAt(index);
      const obj = list.getAt(index);
      if (!(obj instanceof LingoPropList)) return null;

      const preferredCast = loadedCastForPlaceholder(runtime, receiver, originalCallMethod, members, obj, loadedCastSet);
      let finalizingCast = "";
      const candidateCasts = preferredCast ? [preferredCast] : loadedCasts;
      for (const castName of candidateCasts) {
        const canFinalize = originalCallMethod(receiver, "canfinalizeplaceholder", [obj, typeName, castName]);
        if (ops.truthy(canFinalize)) {
          finalizingCast = castName;
          break;
        }
      }
      if (finalizingCast === "") continue;
      const placeholderExists = originalCallMethod(receiver, "placeholderobjectexists", [
        roomComponent,
        typeName,
        tid,
        obj,
      ]);
      if (!ops.truthy(placeholderExists)) continue;

      const created = originalCallMethod(receiver, "createfinalobject", [
        roomComponent,
        typeName,
        obj,
        tid,
        finalizingCast,
      ]);
      if (ops.truthy(created)) {
        list.deleteAt(index);
        callIfHandler(runtime, roomComponent, "updateroomassetcachedobject", [typeName, obj]);
        originalCallMethod(receiver, "processmessagebuffer", [tid, typeName]);
        executeRoomAssetMessage(runtime, "objectFinalized", tid);
        updated = 1;
        continue;
      }

      originalCallMethod(receiver, "restoreplaceholderobject", [roomComponent, typeName, obj, tid]);
    }

    if (updated) {
      if (typeName === "active") {
        executeRoomAssetMessage(runtime, "activeObjectsUpdated");
      } else if (typeName === "item") {
        executeRoomAssetMessage(runtime, "itemObjectsUpdated");
      }
    }
  }

  if (Number(originalCallMethod(receiver, "pendingplaceholdercount", [])) === 0) {
    callIfHandler(runtime, roomComponent, "roomprogressivefurnitureloaded", []);
  }
  return 1;
}

export function release306CastDefinesFurnitureClass(
  members: CastRegistry,
  castName: string,
  className: string,
): boolean {
  const normalizedClass = normalizedFurnitureClassName(className);
  if (normalizedClass.length === 0) return false;
  return release306FurnitureClassesDefinedByCast(members, castName).has(normalizedClass);
}

function dynamicFurnitureCasts(runtime: Runtime): string[] {
  return release306DynamicFurnitureCastNamesFromValue(
    runtime.call("getvariablevalue", [
      RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE,
      new LingoList(),
    ]),
  );
}

const castClassCache = new WeakMap<CastRegistry, Map<string, Set<string>>>();
const dynamicOwnerCache = new WeakMap<
  CastRegistry,
  { castsKey: string; ownersByClass: Map<string, string[]> }
>();

function release306FurnitureClassesDefinedByCast(members: CastRegistry, castName: string): Set<string> {
  const normalizedCast = normalizedCastName(castName);
  let cache = castClassCache.get(members);
  if (!cache) {
    cache = new Map();
    castClassCache.set(members, cache);
  }
  const cached = cache.get(normalizedCast);
  if (cached) return cached;

  const classes = new Set<string>();
  for (const member of members.definedMembersOf(normalizedCast)) {
    const className = classFromFurnitureMemberName(member.name);
    if (className.length > 0) classes.add(className);
  }
  cache.set(normalizedCast, classes);
  return classes;
}

function release306DynamicFurnitureOwners(
  runtime: Runtime,
  members: CastRegistry,
  className: string,
): string[] {
  const normalizedClass = normalizedFurnitureClassName(className);
  if (normalizedClass.length === 0) return [];
  const dynamicCasts = dynamicFurnitureCasts(runtime);
  const castsKey = dynamicCasts.join("\0");
  const cached = dynamicOwnerCache.get(members);
  if (cached && cached.castsKey === castsKey) {
    return cached.ownersByClass.get(normalizedClass) ?? [];
  }

  const ownersByClass = new Map<string, string[]>();
  for (const castName of dynamicCasts) {
    for (const definedClass of release306FurnitureClassesDefinedByCast(members, castName)) {
      const owners = ownersByClass.get(definedClass);
      if (owners) owners.push(castName);
      else ownersByClass.set(definedClass, [castName]);
    }
  }
  dynamicOwnerCache.set(members, { castsKey, ownersByClass });
  return ownersByClass.get(normalizedClass) ?? [];
}

function classCastFromBufferIndex(receiver: ScriptInstance, className: string): string {
  if (className === "") return "";
  const classToCast = receiver.props.get("pclasstocast");
  if (!(classToCast instanceof LingoPropList)) return "";
  let value = classToCast.getaProp(className, ops.lingoKeyEquals);
  let lookupClass = className;
  if (value instanceof LingoVoid && lookupClass.toLowerCase().startsWith("s_")) {
    lookupClass = lookupClass.slice(2);
    value = classToCast.getaProp(lookupClass, ops.lingoKeyEquals);
  }
  return value instanceof LingoVoid ? "" : normalizedCastName(value);
}

function currentRelease306CastLibNumber(runtime: Runtime, castName: string): number {
  const wanted = release306NormalizedCastName(castName);
  if (wanted === "") return 0;
  const count = Number(runtime.countOf("castlib", null)) || 0;
  for (let index = 1; index <= count; index += 1) {
    const cast = runtime.call("castlib", [index]);
    if (!cast || typeof cast !== "object") continue;
    const ref = cast as { name?: string; fileName?: string };
    const fileName = ops.stringOf(ref.fileName ?? "");
    const extension = fileName.length >= 3 ? fileName.slice(-3).toLowerCase() : "";
    if (release306NormalizedCastName(ref.name ?? "") === "internal") continue;
    if (extension === "dcr" || extension === "dir") continue;
    if (release306NormalizedCastName(ref.name ?? "") === wanted) return index;
  }
  return 0;
}

export function release306FurnitureCastMemberCountFast(
  runtime: Runtime,
  members: CastRegistry,
  castNameValue: LingoValue,
): number {
  const castName = release306NormalizedCastName(castNameValue);
  if (castName === "") return 0;
  if (currentRelease306CastLibNumber(runtime, castName) === 0) return 0;
  return members.memberCount(castName);
}

/**
 * Release306's dynamic room asset path initially reads room model charScale,
 * but object member naming is driven by Room Geometry pXFactor. Horizon rooms
 * can be charScale #small with 64x32 geometry, so furniture cast scale must
 * follow the same geometry predicate as Active/Item object classes.
 */
export function installRelease306RoomBufferCompatibility(runtime: Runtime, members?: CastRegistry): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (receiver instanceof ScriptInstance && receiver.module.scriptName === "Buffer Component Class") {
      const lowerMethod = method.toLowerCase();
      if (lowerMethod === "getcurrentroomscale") {
        try {
          const currentScale = originalCallMethod(receiver, method, args);
          const sourceIsSmallRoom = originalCallMethod(receiver, "issmallroom", []);
          return release306FurnitureScaleFromGeometry(currentScale, sourceIsSmallRoom);
        } catch {
          // Fall through to the generated source handler.
        }
      }
      if (lowerMethod === "markcastready" && members) {
        const result = markCastReadyFast(runtime, receiver, originalCallMethod, members, args[0] ?? "");
        if (result !== null) return result;
      }
      if (lowerMethod === "furniturecastmembercount" && members) {
        return release306FurnitureCastMemberCountFast(runtime, members, args[0] ?? "");
      }
      if (lowerMethod === "furniturecasthasmembers" && members) {
        return release306FurnitureCastMemberCountFast(runtime, members, args[0] ?? "") > 1 ? 1 : 0;
      }
      if (lowerMethod === "handlefurniturecastloaded" && members) {
        const result = handleFurnitureCastLoadedBatched(runtime, receiver, originalCallMethod, members, args[0] ?? "");
        if (result !== null) return result;
      }
      if (lowerMethod === "replacereadyplaceholders" && members) {
        const result = replaceReadyPlaceholdersFast(runtime, receiver, originalCallMethod, members);
        if (result !== null) return result;
      }
      if (lowerMethod === "islargeroomfurniturecast" && isRelease306SmallScaleFurnitureCastName(normalizedCastName(args[0] ?? ""))) {
        return 1;
      }
      if (lowerMethod === "canfinalizeplaceholder") {
        const obj = args[0];
        const loadedCast = normalizedCastName(args[2] ?? "");
        if (obj instanceof LingoPropList && loadedCast !== "") {
          const className = sourceClassNameFast(receiver, originalCallMethod, obj);
          const objectCast = classCastFromBufferIndex(receiver, className);
          if (objectCast !== "" && objectCast !== loadedCast) {
            return 0;
          }
          if (objectCast === "" && members) {
            const owningDynamicCasts = release306DynamicFurnitureOwners(runtime, members, className);
            if (owningDynamicCasts.length > 0 && !owningDynamicCasts.includes(loadedCast)) {
              return 0;
            }
          }
        }
      }
      if (lowerMethod === "reloaddynamicfurniturecastlist") {
        const result = originalCallMethod(receiver, method, args);
        const dynamicCasts = release306DynamicFurnitureCastNamesFromValue(
          runtime.call("getvariablevalue", [
            RELEASE306_DYNAMIC_FURNITURE_CAST_LIST_VARIABLE,
            new LingoList(),
          ]),
        );
        for (const castName of dynamicCasts) {
          originalCallMethod(receiver, "adddynamicfurniturecast", [castName]);
        }
        return result;
      }
    }
    return originalCallMethod(receiver, method, args);
  };
}

export function prewarmRelease306RoomAssetBuffer(runtime: Runtime): number {
  try {
    if (runtime.call("getintvariable", ["room.dynamic.assets.enabled", 0]) === 0) return 0;
    if (!runtime.call("threadexists", [LingoSymbol.for("room")])) return 0;
    const roomThread = runtime.call("getthread", [LingoSymbol.for("room")]);
    if (!(roomThread instanceof ScriptInstance)) return 0;
    const roomComponent = runtime.callMethod(roomThread, "getcomponent", []);
    if (!(roomComponent instanceof ScriptInstance)) return 0;
    const roomMarker = runtime.callMethod(roomComponent, "getroommodel", []);
    if (roomMarker instanceof LingoVoid || roomMarker === 0) return 0;
    const roomScale = runtime.callMethod(roomComponent, "getroomscale", [roomMarker]);
    if (
      !(roomScale instanceof LingoSymbol) ||
      (roomScale.name.toLowerCase() !== "small" && roomScale.name.toLowerCase() !== "large")
    ) {
      return 0;
    }
    const objectId = ops.stringOf(runtime.call("getstringvariable", ["room.asset.buffer.object.id", "Room Asset Buffer"]) ?? "Room Asset Buffer");
    const className = ops.stringOf(runtime.call("getstringvariable", ["room.asset.buffer.component.class", "Buffer Component Class"]) ?? "Buffer Component Class");
    if (!runtime.call("objectexists", [objectId])) {
      runtime.call("createobject", [objectId, className]);
    }
    const buffer = runtime.call("getobject", [objectId]);
    if (!(buffer instanceof ScriptInstance)) return 0;
    return ops.truthy(runtime.callMethod(buffer, "queuebackgroundfurniturecasts", [])) ? 1 : 0;
  } catch {
    return 0;
  }
}
