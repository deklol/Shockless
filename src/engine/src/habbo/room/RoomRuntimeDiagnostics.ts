import { lingoKeyEquals } from "@director/ops";
import { type Runtime, ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LINGO_VOID, LingoList, LingoPropList, LingoSymbol, LingoVoid, type LingoValue } from "@director/values";

const REDACTED_DIAGNOSTIC_VALUE = "[REDACTED]";
const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
  "accesstoken",
  "authsessionticket",
  "authticket",
  "loginpassword",
  "password",
  "refreshtoken",
  "sessiontoken",
  "steamauthticket",
  "steamid",
  "totp",
  "totpsecret",
  "userpassword",
  "webhookurl",
]);

export function shouldHoldRoomAssetPresentation(buffer: ScriptInstance | null): boolean {
  if (!buffer) return false;
  const placeholders = instancePropValue(buffer, "pplaceholderlist");
  if (!(placeholders instanceof LingoPropList)) return false;
  const active = propListLookup(placeholders, "active");
  const item = propListLookup(placeholders, "item");
  const activeCount = active instanceof LingoPropList ? active.count() : 0;
  const itemCount = item instanceof LingoPropList ? item.count() : 0;
  return activeCount + itemCount > 0;
}

export function resourceMemberIndex(gCore: LingoValue): LingoPropList | null {
  const objectList = objectManagerList(gCore);
  if (!objectList) return null;
  const resourceManager = objectList.getaProp(LingoSymbol.for("resource_manager"), lingoKeyEquals);
  if (!(resourceManager instanceof ScriptInstance)) return null;
  const index = resourceManager.props.get("pallmemnumlist");
  return index instanceof LingoPropList ? index : null;
}

export function objectManagerList(gCore: LingoValue): LingoPropList | null {
  if (!(gCore instanceof ScriptInstance)) return null;
  const objectList = gCore.props.get("pobjectlist");
  return objectList instanceof LingoPropList ? objectList : null;
}

export function propListLookup(list: LingoPropList, key: string): LingoValue {
  const asString = list.getaProp(key, lingoKeyEquals);
  if (!(asString instanceof LingoVoid)) return asString;
  const symbolKey = key.startsWith("#") ? key.slice(1) : key;
  return list.getaProp(LingoSymbol.for(symbolKey), lingoKeyEquals);
}

export function setSignature(values: ReadonlySet<number>): string {
  if (values.size === 0) return "0:";
  return `${values.size}:${[...values].sort((left, right) => left - right).join(",")}`;
}

export function instancePropValue(instance: ScriptInstance, name: string): LingoValue | undefined {
  const key = name.toLowerCase();
  let target: ScriptInstance | null = instance;
  while (target) {
    if (target.props.has(key)) return target.props.get(key);
    const ancestor = target.props.get("ancestor");
    target = ancestor instanceof ScriptInstance ? ancestor : null;
  }
  return undefined;
}

export function summarizeVariables(gCore: LingoValue, names: string[]): Record<string, unknown> {
  const objectList = objectManagerList(gCore);
  if (!objectList) return {};
  const manager = propListLookup(objectList, "#variable_manager");
  if (!(manager instanceof ScriptInstance)) return {};
  const itemList = instancePropValue(manager, "pitemlist");
  if (!(itemList instanceof LingoPropList)) return {};
  const result: Record<string, unknown> = {};
  for (const name of names) result[name] = summarizeKeyedValue(name, propListLookup(itemList, name), 3);
  return result;
}

export function summarizeVisualizer(gCore: LingoValue, id: string): unknown {
  const objectList = objectManagerList(gCore);
  if (!objectList) return null;
  const visualizer = propListLookup(objectList, id);
  if (!(visualizer instanceof ScriptInstance)) return null;
  const wrappedParts = instancePropValue(visualizer, "pwrappedparts");
  const spriteData = instancePropValue(visualizer, "pspritedata");
  return {
    id,
    layout: debugValue(instancePropValue(visualizer, "playout") ?? LINGO_VOID),
    loc: [
      debugValue(instancePropValue(visualizer, "plocx") ?? LINGO_VOID),
      debugValue(instancePropValue(visualizer, "plocy") ?? LINGO_VOID),
      debugValue(instancePropValue(visualizer, "plocz") ?? LINGO_VOID),
    ],
    dimensions: [
      debugValue(instancePropValue(visualizer, "pwidth") ?? LINGO_VOID),
      debugValue(instancePropValue(visualizer, "pheight") ?? LINGO_VOID),
    ],
    spriteList: summarizeList(instancePropValue(visualizer, "pspritelist")),
    activeSprites: summarizePropList(instancePropValue(visualizer, "pactsprlist")),
    spriteDataCount: spriteData instanceof LingoList ? spriteData.count() : null,
    wrappedParts: summarizeWrappedParts(wrappedParts),
  };
}

export function summarizeWrappedParts(value: LingoValue | undefined): unknown[] {
  if (!(value instanceof LingoPropList)) return [];
  return value.keys.map((key, index) => {
    const wrapper = value.values[index];
    if (!(wrapper instanceof ScriptInstance)) return { key: debugValue(key), value: debugValue(wrapper) };
    return {
      key: debugValue(key),
      object: wrapper.module.scriptName,
      imgMemberId: debugValue(instancePropValue(wrapper, "pimgmemberid")),
      typeDef: debugValue(instancePropValue(wrapper, "ptypedef")),
      sprite: summarizeSprite(instancePropValue(wrapper, "psprite")),
      locZ: debugValue(instancePropValue(wrapper, "plocz")),
      visualizerLocZ: debugValue(instancePropValue(wrapper, "pvisualizerlocz")),
      wrapperStatus: summarizeValue(instancePropValue(wrapper, "pwrapperstatus"), 2),
      offsets: summarizeValue(instancePropValue(wrapper, "poffsets"), 1),
      wrapId: debugValue(instancePropValue(wrapper, "pwrapid")),
      boundingRect: debugValue(instancePropValue(wrapper, "pboundingrect")),
      capturesEvents: debugValue(instancePropValue(wrapper, "pcapturesevents")),
      spriteProps: summarizeValue(instancePropValue(wrapper, "pspriteprops"), 2),
      bgColor: debugValue(instancePropValue(wrapper, "pbgcolor")),
      partList: summarizeListSample(instancePropValue(wrapper, "ppartlist"), 12),
    };
  });
}

export function summarizeRoomAssetBuffer(buffer: ScriptInstance | null): unknown {
  if (!buffer) return null;
  const placeholders = instancePropValue(buffer, "pplaceholderlist");
  const activePlaceholders = placeholders instanceof LingoPropList ? propListLookup(placeholders, "active") : LINGO_VOID;
  const itemPlaceholders = placeholders instanceof LingoPropList ? propListLookup(placeholders, "item") : LINGO_VOID;
  return {
    object: buffer.module.scriptName,
    loadedCasts: summarizePropListSample(instancePropValue(buffer, "ploadedcasts")),
    queuedCasts: summarizePropListSample(instancePropValue(buffer, "pqueuedcasts")),
    classToCast: summarizePropListSample(instancePropValue(buffer, "pclasstocast")),
    furnitureCastList: summarizeListSample(instancePropValue(buffer, "pfurniturecastlist")),
    placeholders: {
      active: activePlaceholders instanceof LingoPropList ? activePlaceholders.count() : 0,
      item: itemPlaceholders instanceof LingoPropList ? itemPlaceholders.count() : 0,
    },
  };
}

export function summarizeRoomAssetBufferDiagnostics(buffer: ScriptInstance | null, runtime: Runtime, limit: number): unknown {
  if (!buffer) return null;
  const placeholders = instancePropValue(buffer, "pplaceholderlist");
  const sourceList = (typeName: "active" | "item"): LingoPropList | null => {
    if (!(placeholders instanceof LingoPropList)) return null;
    const value = propListLookup(placeholders, typeName);
    return value instanceof LingoPropList ? value : null;
  };
  const safeCall = (method: string, args: LingoValue[]): LingoValue => {
    try {
      return runtime.hasHandler(buffer, method) ? runtime.callMethod(buffer, method, args) : LINGO_VOID;
    } catch (error) {
      return String(error);
    }
  };
  const summarizePlaceholderList = (typeName: "active" | "item"): unknown[] => {
    const list = sourceList(typeName);
    if (!list) return [];
    return list.keys.slice(0, limit).map((key, index) => {
      const object = list.values[index];
      if (!(object instanceof LingoPropList)) return { key: debugValue(key), value: summarizeValue(object, 1) };
      const classValue = propListValue(object, "class");
      const typeValue = propListValue(object, "type");
      const className = safeCall("getclassname", [classValue, typeValue]);
      const castName = safeCall("getcastforclass", [className]);
      return {
        key: debugValue(key),
        id: debugValue(propListValue(object, "id")),
        sourceClass: debugValue(classValue),
        sourceType: debugValue(typeValue),
        className: debugValue(className),
        castName: debugValue(castName),
        ready: debugValue(safeCall("objectfurnitureready", [object, typeName])),
        canFinalize: debugValue(safeCall("canfinalizeplaceholder", [object, typeName, castName])),
        direction: summarizeValue(propListValue(object, "direction"), 1),
        dimensions: summarizeValue(propListValue(object, "dimensions"), 1),
        members: placeholderMemberCandidates(buffer, runtime, object, typeName, className),
      };
    });
  };
  return {
    object: buffer.module.scriptName,
    scale: debugValue(safeCall("getcurrentroomscale", [])),
    furnitureCastList: summarizeListSample(instancePropValue(buffer, "pfurniturecastlist"), 80),
    loadedCasts: summarizePropListSample(instancePropValue(buffer, "ploadedcasts"), 80),
    queuedCasts: summarizePropListSample(instancePropValue(buffer, "pqueuedcasts"), 80),
    activePlaceholders: summarizePlaceholderList("active"),
    itemPlaceholders: summarizePlaceholderList("item"),
  };
}

export function propListValue(list: LingoPropList, key: string): LingoValue {
  const bySymbol = list.getaProp(LingoSymbol.for(key), lingoKeyEquals);
  return bySymbol instanceof LingoVoid ? list.getaProp(key, lingoKeyEquals) : bySymbol;
}

export function placeholderMemberCandidates(
  buffer: ScriptInstance,
  runtime: Runtime,
  object: LingoPropList,
  typeName: "active" | "item",
  className: LingoValue,
): unknown[] {
  const callExists = (name: string): unknown => {
    try {
      return debugValue(runtime.callMethod(buffer, "memberreferenceexists", [name]));
    } catch (error) {
      return String(error);
    }
  };
  const classText = typeof className === "string" ? className : "";
  if (!classText) return [];
  if (typeName === "item") {
    const direction = debugValue(runtime.callMethod(buffer, "getitemdirectionname", [object]));
    const typeValue = propListValue(object, "type");
    const names = [
      `${String(direction)} ${classText}`,
      `${String(direction)} ${classText}_a_0`,
      typeof typeValue === "string" && typeValue ? `${String(direction)} ${classText}_${typeValue}` : "",
    ].filter(Boolean);
    return names.map((name) => ({ name, exists: callExists(name) }));
  }
  const dimensions = propListValue(object, "dimensions");
  const directionValue = propListValue(object, "direction");
  const width = dimensions instanceof LingoList && dimensions.items.length >= 1 ? Number(dimensions.items[0]) || 1 : 1;
  const height = dimensions instanceof LingoList && dimensions.items.length >= 2 ? Number(dimensions.items[1]) || 1 : 1;
  const direction = directionValue instanceof LingoList && directionValue.items.length > 0
    ? Number(directionValue.items[0]) || 0
    : Number(directionValue) || 0;
  const base = `${classText}_a_0_${width}_${height}`;
  return [`${base}_${direction}_0`, `${base}_${direction}_1`, `${base}_0_0`, `${classText}.data`, `${classText}.props`]
    .map((name) => ({ name, exists: callExists(name) }));
}

export function summarizeRoomObjects(gCore: LingoValue, runtime: Runtime): unknown {
  const objectList = objectManagerList(gCore);
  if (!objectList) return null;
  const roomComponent = propListLookup(objectList, "#room_component");
  if (!(roomComponent instanceof ScriptInstance)) return null;
  const prop = (object: ScriptInstance, name: string): LingoValue => instancePropValue(object, name) ?? LINGO_VOID;
  const summarizeObjectList = (propName: string): unknown[] => {
    const list = prop(roomComponent, propName);
    if (!(list instanceof LingoPropList)) return [];
    return list.keys.map((key, index) => {
      const object = list.values[index];
      if (!(object instanceof ScriptInstance)) return { key: debugValue(key), value: debugValue(object) };
      const sprites = prop(object, "psprlist");
      return {
        key: debugValue(key),
        object: object.module.scriptName,
        id: debugValue(prop(object, "id")),
        name: debugValue(prop(object, "pname")),
        custom: debugValue(prop(object, "pcustom")),
        sex: debugValue(prop(object, "psex")),
        badge: debugValue(prop(object, "pbadge")),
        class: debugValue(prop(object, "pclass")),
        type: debugValue(prop(object, "ptype")),
        direction: summarizeValue(prop(object, "pdirection"), 2),
        dimensions: summarizeValue(prop(object, "pdimensions"), 2),
        formatVersion: debugValue(prop(object, "pformatver")),
        wall: [debugValue(prop(object, "pwallx")), debugValue(prop(object, "pwally"))],
        local: [debugValue(prop(object, "plocalx")), debugValue(prop(object, "plocaly"))],
        loc: [debugValue(prop(object, "plocx")), debugValue(prop(object, "plocy")), debugValue(prop(object, "ploch"))],
        sprites: sprites instanceof LingoList
          ? {
              count: sprites.count(),
              items: sprites.items.map((sprite) => sprite instanceof SpriteChannel
                ? {
                    n: sprite.number,
                    member: sprite.member?.name ?? null,
                    loc: [sprite.locH, sprite.locV],
                    size: [sprite.width, sprite.height],
                    z: sprite.locZ,
                    visible: sprite.visible,
                  }
                : debugValue(sprite)),
            }
          : summarizeValue(sprites, 0),
      };
    });
  };
  return {
    users: summarizeObjectList("puserobjlist"),
    active: summarizeObjectList("pactiveobjlist"),
    passive: summarizeObjectList("ppassiveobjlist"),
    items: summarizeObjectList("pitemobjlist"),
  };
}

export function summarizePropListSample(value: LingoValue | undefined, limit = 30): unknown {
  if (!(value instanceof LingoPropList)) return { count: 0, entries: [] };
  return {
    count: value.count(),
    entries: value.keys.slice(0, limit).map((key, index) => ({
      key: debugValue(key),
      value: isSensitiveDiagnosticKey(key) ? REDACTED_DIAGNOSTIC_VALUE : debugValue(value.values[index]),
    })),
  };
}

export function summarizeListSample(value: LingoValue | undefined, limit = 30): unknown {
  if (!(value instanceof LingoList)) return { count: 0, items: [] };
  return { count: value.count(), items: value.items.slice(0, limit).map(debugValue) };
}

export function summarizeList(value: LingoValue | undefined): unknown[] {
  if (value instanceof LingoList) return value.items.map((entry) => summarizeSprite(entry));
  if (value instanceof LingoPropList) return value.values.map((entry) => summarizeSprite(entry));
  return [];
}

export function summarizePropList(value: LingoValue | undefined): unknown[] {
  if (!(value instanceof LingoPropList)) return [];
  return value.keys.map((key, index) => ({ key: debugValue(key), sprite: summarizeSprite(value.values[index]) }));
}

export function summarizeSprite(value: LingoValue | undefined, depth = 1): unknown {
  if (!(value instanceof SpriteChannel)) return debugValue(value);
  return {
    n: value.number,
    member: value.member?.name ?? null,
    memberNumber: value.member?.number ?? null,
    castNum: value.member?.slotNumber ?? 0,
    castLibNum: value.member?.castNumber ?? value.castLibNum,
    loc: [value.locH, value.locV],
    size: [value.width, value.height],
    z: value.locZ,
    id: debugValue(value.id),
    ink: value.ink,
    blend: value.blend,
    flipH: value.flipH,
    flipV: value.flipV,
    rotation: value.rotation,
    skew: value.skew,
    regPoint: value.member ? [value.member.regX, value.member.regY] : null,
    scripts: value.scriptInstanceList.items.map((entry) => summarizeValue(entry, depth)),
  };
}

export function debugValue(value: LingoValue | undefined): unknown {
  if (value instanceof LingoSymbol) return `#${value.name}`;
  if (value instanceof SpriteChannel) return `(sprite ${value.number})`;
  if (value instanceof ScriptInstance) return `<offspring "${value.module.scriptName}">`;
  // Never stringify an unexplored collection. Lingo's string form includes all
  // values and can bypass the keyed redaction applied by the summaries below.
  if (value instanceof LingoList) return { type: "list", count: value.count() };
  if (value instanceof LingoPropList) return { type: "propList", count: value.count() };
  if (value && typeof value === "object" && "lingoToString" in value && typeof value.lingoToString === "function") {
    return value.lingoToString();
  }
  return value;
}

export function summarizeValue(value: LingoValue | undefined, depth: number): unknown {
  if (depth <= 0) return debugValue(value);
  if (value instanceof LingoList) {
    return { type: "list", count: value.count(), items: value.items.slice(0, 20).map((entry) => summarizeValue(entry, depth - 1)) };
  }
  if (value instanceof LingoPropList) {
    return {
      type: "propList",
      count: value.count(),
      entries: value.keys.slice(0, 20).map((key, index) => ({
        key: debugValue(key),
        value: summarizeKeyedValue(key, value.values[index], depth - 1),
      })),
    };
  }
  if (value instanceof ScriptInstance) return summarizeObject(value, depth - 1);
  return debugValue(value);
}

export function summarizeObject(value: LingoValue | undefined, depth: number): unknown {
  if (!(value instanceof ScriptInstance)) return debugValue(value);
  const summary: Record<string, unknown> = {
    object: value.module.scriptName,
    props: Object.fromEntries(Array.from(value.props.entries()).map(([key, entry]) => [key, summarizeKeyedValue(key, entry, depth)])),
  };
  const ancestor = value.props.get("ancestor");
  if (ancestor instanceof ScriptInstance && depth > 0) summary.ancestor = summarizeObject(ancestor, depth - 1);
  return summary;
}

export function isSensitiveDiagnosticKey(value: unknown): boolean {
  const normalized = normalizeDiagnosticKey(value);
  return normalized !== null && SENSITIVE_DIAGNOSTIC_KEYS.has(normalized);
}

export function isSensitiveDiagnosticInvocation(method: string, args: readonly unknown[]): boolean {
  const normalizedMethod = normalizeDiagnosticKey(method);
  if (normalizedMethod === "isteamusergetsteamid" || normalizedMethod === "isteamusergetauthsessionticket") return true;
  if (!normalizedMethod || !["exists", "get", "getaprop", "remove", "set", "setaprop"].includes(normalizedMethod)) return false;
  return args.some((arg) => isSensitiveDiagnosticKey(arg));
}

function summarizeKeyedValue(key: unknown, value: LingoValue | undefined, depth: number): unknown {
  return isSensitiveDiagnosticKey(key) ? REDACTED_DIAGNOSTIC_VALUE : summarizeValue(value, depth);
}

function normalizeDiagnosticKey(value: unknown): string | null {
  const raw = value instanceof LingoSymbol ? value.name : typeof value === "string" ? value : null;
  if (raw === null) return null;
  return raw.replace(/^#/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function coerceDebugValue(value: unknown): LingoValue {
  if (typeof value === "string") return value.startsWith("#") ? LingoSymbol.for(value.slice(1)) : value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Array.isArray(value)) return new LingoList(value.map((entry) => coerceDebugValue(entry)));
  if (value && typeof value === "object") {
    const props = new LingoPropList();
    for (const [key, entry] of Object.entries(value)) {
      props.setaProp(key.startsWith("#") ? LingoSymbol.for(key.slice(1)) : key, coerceDebugValue(entry), lingoKeyEquals);
    }
    return props;
  }
  return value instanceof LingoVoid ? value : 0;
}
