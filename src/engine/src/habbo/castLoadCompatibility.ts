import * as ops from "@director/ops";
import { ScriptInstance, type Runtime } from "@director/Runtime";
import { LINGO_VOID, LingoPropList, LingoSymbol, type LingoValue } from "@director/values";

const installedRuntimes = new WeakSet<Runtime>();
const completedCastLoadInstances = new WeakSet<ScriptInstance>();

function instanceString(instance: ScriptInstance, name: string, fallback = ""): string {
  const value = instance.props.get(name.toLowerCase());
  const text = ops.stringOf(value ?? "");
  return text.length > 0 ? text : fallback;
}

function instanceNumber(instance: ScriptInstance, name: string): number {
  const value = instance.props.get(name.toLowerCase());
  return typeof value === "number" ? value : Number(ops.stringOf(value ?? 0)) || 0;
}

function castLibRef(runtime: Runtime, number: number): { name?: string; fileName?: string } | null {
  const cast = runtime.call("castlib", [number]);
  if (!cast || typeof cast !== "object") return null;
  return cast as { name?: string; fileName?: string };
}

function isCompleteCastLoadState(value: LingoValue | undefined): boolean {
  return (
    ops.truthy(ops.eq(value ?? LINGO_VOID, LingoSymbol.for("done"))) ||
    ops.truthy(ops.eq(value ?? LINGO_VOID, LingoSymbol.for("failed")))
  );
}

function finishRegisteredCompletedCastLoadInstance(runtime: Runtime, receiver: ScriptInstance): boolean {
  if (completedCastLoadInstances.has(receiver)) return false;
  if (!isCompleteCastLoadState(receiver.props.get("pstate"))) return false;

  const file = receiver.props.get("pfile") ?? LINGO_VOID;
  const groupId = receiver.props.get("pgroupid") ?? LINGO_VOID;
  const manager = runtime.call("getcastloadmanager", []);
  if (!(manager instanceof ScriptInstance) || manager.module.scriptName !== "CastLoad Manager Class") {
    return false;
  }

  const currentDownloads = manager.props.get("pcurrentdownloads");
  const taskList = manager.props.get("ptasklist");
  const castWaiters = manager.props.get("pcastwaiters");
  if (!(currentDownloads instanceof LingoPropList) || !(taskList instanceof LingoPropList)) {
    return false;
  }
  if (!(castWaiters instanceof LingoPropList)) {
    return false;
  }
  if (currentDownloads.getaProp(file, ops.lingoKeyEquals) !== receiver) return false;
  if (taskList.getaProp(groupId, ops.lingoKeyEquals) === LINGO_VOID) return false;
  if (castWaiters.getaProp(file, ops.lingoKeyEquals) === LINGO_VOID) return false;

  completedCastLoadInstances.add(receiver);
  runtime.callMethod(manager, "donecurrentdownload", [
    file,
    receiver.props.get("purl") ?? "",
    groupId,
    receiver.props.get("pstate") ?? LingoSymbol.for("done"),
  ]);
  return true;
}

export function initRelease306CastPreloaderFast(runtime: Runtime, receiver: ScriptInstance): number {
  const castLibCount = Number(runtime.countOf("castlib", null)) || 0;
  const nullCastName = instanceString(receiver, "pnullcastname", "empty");
  const available = new LingoPropList();

  receiver.props.set("pwaitlist", new LingoPropList());
  receiver.props.set("ptasklist", new LingoPropList());
  receiver.props.set("pavailabledyncasts", available);
  receiver.props.set("ppermanentlevellist", new LingoPropList());
  receiver.props.set("pcurrentdownloads", new LingoPropList());
  receiver.props.set("pcastwaiters", new LingoPropList());
  receiver.props.set("pcastsourcenames", new LingoPropList());
  receiver.props.set("pcastloadstats", new LingoPropList());
  receiver.props.set("platesttaskid", "");

  const expectedPrefix = `${nullCastName.toLowerCase()} `;
  for (let castNumber = 1; castNumber <= castLibCount; castNumber += 1) {
    const cast = castLibRef(runtime, castNumber);
    const name = cast?.name ?? "";
    const normalized = name.toLowerCase();
    if (!normalized.startsWith(expectedPrefix)) continue;
    const slot = Number(normalized.slice(expectedPrefix.length));
    if (!Number.isInteger(slot) || slot < 1) continue;
    available.addProp(`${nullCastName} ${slot}`, castNumber);
  }
  return 1;
}

function resetRelease306CastLibsFast(
  runtime: Runtime,
  receiver: ScriptInstance,
  clean: LingoValue,
  forced: LingoValue,
): LingoValue | null {
  if (ops.ne(clean, 0)) return null;

  const castLibCount = Number(runtime.countOf("castlib", null)) || 0;
  const sysCastNumber = instanceNumber(receiver, "psyscastnum");
  const binCastNumber = instanceNumber(receiver, "pbincastnum");
  const nullCastName = instanceString(receiver, "pnullcastname", "empty");
  const fileExtension = instanceString(receiver, "pfileextension", ".cct");
  const moviePath = ops.stringOf(runtime.call("getmoviepath", []));
  const keepCasts = new Set<string>();
  if (ops.eq(runtime.theProp("runmode"), "Author") && ops.ne(forced, 1)) {
    for (let index = 1; ; index += 1) {
      const variable = `cast.dev.${index}`;
      if (!ops.truthy(runtime.call("variableexists", [variable]))) break;
      keepCasts.add(ops.stringOf(runtime.call("getvariable", [variable])).toLowerCase());
    }
  }
  const loadedCasts = receiver.props.get("ploadedcasts");

  receiver.props.set("pcastlibcount", castLibCount);
  let emptyCastNumber = 1;
  for (let castNumber = 2; castNumber <= castLibCount; castNumber += 1) {
    if (castNumber === sysCastNumber || castNumber === binCastNumber) continue;
    const cast = castLibRef(runtime, castNumber);
    if (!cast) continue;
    const castName = cast.name ?? "";
    if (keepCasts.has(castName.toLowerCase())) {
      if (loadedCasts instanceof LingoPropList) {
        loadedCasts.setaProp(castName, String(castNumber), ops.lingoKeyEquals);
      }
      continue;
    }
    cast.name = `${nullCastName} ${emptyCastNumber}`;
    cast.fileName = `${moviePath}${nullCastName}${fileExtension}`;
    emptyCastNumber += 1;
  }
  return initRelease306CastPreloaderFast(runtime, receiver);
}

/**
 * Source-equivalent fast paths for release306 CastLoad Manager startup.
 *
 * The source resets hundreds of castLib slots to "empty N", then InitPreloader
 * searches for each empty slot by repeatedly scanning every castLib. That
 * O(n^2) host-call pattern is a startup stall in JS, while the final state is
 * just the same pAvailableDynCasts table that can be built in one pass.
 */
export function installRelease306CastLoadCompatibility(runtime: Runtime): void {
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalCallMethod = runtime.callMethod.bind(runtime);
  runtime.callMethod = (receiver: LingoValue, method: string, args: LingoValue[]): LingoValue => {
    if (receiver instanceof ScriptInstance && receiver.module.scriptName === "CastLoad Instance Class") {
      const wasAlreadyComplete = method.toLowerCase() === "update" && isCompleteCastLoadState(receiver.props.get("pstate"));
      const result = originalCallMethod(receiver, method, args);
      if (wasAlreadyComplete) {
        finishRegisteredCompletedCastLoadInstance(runtime, receiver);
      }
      return result;
    }
    if (receiver instanceof ScriptInstance && receiver.module.scriptName === "CastLoad Manager Class") {
      const lowerMethod = method.toLowerCase();
      if (lowerMethod === "initpreloader") {
        return initRelease306CastPreloaderFast(runtime, receiver);
      }
      if (lowerMethod === "resetcastlibs") {
        const result = resetRelease306CastLibsFast(
          runtime,
          receiver,
          args[0] ?? 0,
          args[1] ?? 0,
        );
        if (result !== null) return result;
      }
    }
    return originalCallMethod(receiver, method, args);
  };
}
