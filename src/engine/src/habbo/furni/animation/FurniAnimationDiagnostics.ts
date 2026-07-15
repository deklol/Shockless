import { ScriptInstance } from "@director/Runtime";
import { SpriteChannel } from "@director/sprites";
import { LingoList, LingoPropList, type LingoValue } from "@director/values";

const ACTIVE_OBJECT_SPRITE_PROPS = ["psprlist", "psprite", "pmattespr", "pshadowspr"] as const;

export interface FurniAnimationDiscovery {
  readonly count: number;
  readonly withSprites: number;
  readonly channels: ReadonlySet<number>;
}

/** Reads active-furni animation coverage without changing source motion or timing. */
export function collectFurniAnimationDiagnostics(
  roomComponent: ScriptInstance,
  signatureParts: string[],
): FurniAnimationDiscovery {
  const channels = new Set<number>();
  const value = instancePropValue(roomComponent, "pactiveobjlist");
  let count = 0;
  let withSprites = 0;

  const visit = (entry: LingoValue | undefined): void => {
    if (!(entry instanceof ScriptInstance)) return;
    count += 1;
    const before = channels.size;
    for (const propName of ACTIVE_OBJECT_SPRITE_PROPS) addSpriteValue(instancePropValue(entry, propName), channels);
    if (channels.size > before) withSprites += 1;
  };

  if (value instanceof LingoPropList) {
    signatureParts.push(`active:objectProps:${value.count()}`);
    for (const entry of value.values) visit(entry);
  } else if (value instanceof LingoList) {
    signatureParts.push(`active:objectList:${value.count()}`);
    for (const entry of value.items) visit(entry);
  } else {
    signatureParts.push("active:objectList:missing");
  }
  return { count, withSprites, channels };
}

function addSpriteValue(value: LingoValue | undefined, channels: Set<number>): void {
  if (value instanceof SpriteChannel) {
    if (value.visible !== 0) channels.add(value.number);
    return;
  }
  if (value instanceof LingoList) {
    for (const entry of value.items) addSpriteValue(entry, channels);
    return;
  }
  if (value instanceof LingoPropList) {
    for (const entry of value.values) addSpriteValue(entry, channels);
  }
}

function instancePropValue(instance: ScriptInstance, name: string): LingoValue | undefined {
  const key = name.toLowerCase();
  let target: ScriptInstance | null = instance;
  while (target) {
    if (target.props.has(key)) return target.props.get(key);
    const ancestor = target.props.get("ancestor");
    target = ancestor instanceof ScriptInstance ? ancestor : null;
  }
  return undefined;
}
