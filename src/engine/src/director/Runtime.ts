import { Expression } from "../lingo/ast";
import { parseLingoExpression } from "../lingo/parser";
import { LingoContext } from "./context";
import { directorCharToNum, directorNumToChar } from "./characterEncoding";
import { DirectorPassSignal, type DirectorEventContext } from "./eventDispatch";
import { LingoColor, LingoDate, LingoPoint, LingoRect } from "./geometry";
import { CopyPixelsParams, CopyPixelsQuadTransform, LingoImage } from "./imaging";
import { XmlNode, XmlParserInstance, XmlParserXtraRef } from "./xml";
import { directorXtraRegistration, type DirectorXtraRegistration } from "./xtras";
import {
  ChunkRef,
  type GeneratedScriptModule,
  MissingScriptInstance,
  MissingScriptRef,
  ScriptInstance,
  ScriptRef,
  ScriptingObjectRef,
  UnsupportedFeatureError,
} from "./runtimeObjects";
export {
  ChunkRef,
  type GeneratedScriptModule,
  MissingScriptInstance,
  MissingScriptRef,
  ScriptInstance,
  ScriptRef,
  ScriptingObjectRef,
  UnsupportedFeatureError,
} from "./runtimeObjects";
import * as ops from "./ops";
import {
  LINGO_VOID,
  LingoFloat,
  LingoList,
  LingoPropList,
  LingoSymbol,
  LingoValue,
  LingoVoid,
  duplicateValue,
  float,
  isLingoObject,
} from "./values";

const DIRECTOR_INK_SYMBOLS = new Map<string, number>([
  ["copy", 0],
  ["transparent", 1],
  ["reverse", 2],
  ["ghost", 3],
  ["notcopy", 4],
  ["nottransparent", 5],
  ["notreverse", 6],
  ["notghost", 7],
  ["matte", 8],
  ["mask", 9],
  ["blend", 32],
  ["addpin", 33],
  ["add", 34],
  ["subtractpin", 35],
  ["backgroundtransparent", 36],
  ["lightest", 37],
  ["subtract", 38],
  ["darkest", 39],
  ["lighten", 40],
  ["darken", 41],
]);

function copyPixelsInkValue(value: LingoValue): number | null {
  if (typeof value === "number") return value;
  if (value instanceof LingoSymbol) return DIRECTOR_INK_SYMBOLS.get(value.name.toLowerCase()) ?? null;
  return null;
}

/**
 * The Director-compatible runtime that generated Lingo code executes
 * against. Holds the loaded script registry, globals, script instances,
 * chunk semantics, and the pure builtin library. Host-dependent behavior
 * (stage, casts, members, network, timing) is delegated to a DirectorHost so
 * the runtime itself stays platform-free (testable in Node, rendered in the
 * browser).
 */

export interface UnsupportedDiagnostics {
  readonly entries: readonly string[];
  readonly count: number;
  readonly cap: number;
  readonly truncated: boolean;
  readonly callStack: readonly string[];
}

type QuadCorners = [LingoPoint, LingoPoint, LingoPoint, LingoPoint];

function sameCoord(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.0001;
}

function quadCornerName(point: LingoPoint, rect: LingoRect): "TL" | "TR" | "BR" | "BL" | null {
  const x =
    sameCoord(point.x, rect.left) ? "L" : sameCoord(point.x, rect.right) ? "R" : null;
  const y =
    sameCoord(point.y, rect.top) ? "T" : sameCoord(point.y, rect.bottom) ? "B" : null;
  return x && y ? (`${y}${x}` as "TL" | "TR" | "BR" | "BL") : null;
}

export function classifyCopyPixelsQuadTransform(points: QuadCorners, rect: LingoRect): CopyPixelsQuadTransform | null {
  const pattern = points.map((point) => quadCornerName(point, rect)).join(",");
  switch (pattern) {
    case "TL,TR,BR,BL":
      return "identity";
    case "TR,TL,BL,BR":
      return "flipH";
    case "BL,BR,TR,TL":
      return "flipV";
    case "BR,BL,TL,TR":
      return "rotate180";
    case "TR,BR,BL,TL":
      return "rotateCW";
    case "BL,TL,TR,BR":
      return "rotateCCW";
    case "TL,BL,BR,TR":
      return "transpose";
    case "BR,TR,TL,BL":
      return "antiTranspose";
    default:
      return null;
  }
}

export interface DirectorHost {
  /** `the <prop>` not handled by the core runtime. */
  theProp?(name: string): LingoValue | undefined;
  setTheProp?(name: string, value: LingoValue): boolean;
  /** `the <prop> of <obj>` for host objects (sprites, members, castLibs). */
  theOf?(property: string, object: LingoValue): LingoValue | undefined;
  setTheOf?(property: string, object: LingoValue, value: LingoValue): boolean;
  /** member/sprite/castLib/... references. */
  objectRef?(refType: string, id: LingoValue, castLib: LingoValue | null): LingoValue | undefined;
  /** Host builtins (go, netDone, preloadNetThing, puppetTempo, ...). */
  call?(name: string, args: LingoValue[]): LingoValue | undefined;
  /** Method call on a host object (e.g. sprite-behavior dispatch). */
  callMethod?(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue | undefined;
  /** Property reads on host objects. */
  getProp?(receiver: LingoValue, property: string): LingoValue | undefined;
  setProp?(receiver: LingoValue, property: string, value: LingoValue): boolean;
  /** put output sink; defaults to console. */
  put?(text: string): void;
  /** Object Manager entry was created/registered by generated source. */
  objectRegistered?(id: LingoValue, object: LingoValue, classList: LingoValue): void;
}

interface RegisteredScript {
  module: GeneratedScriptModule;
  castFile: string;
  memberNumber: number | null;
}

export interface ScriptRegistrationMeta {
  memberNumber?: number | null;
}

function normalizeCastFile(castFile: string): string {
  return castFile.toLowerCase().replace(/\.(cct|cst)$/i, "");
}

function scriptMemberKey(castFile: string, memberNumber: number): string {
  return `${normalizeCastFile(castFile)}:${memberNumber}`;
}

export class Runtime implements LingoContext {
  private static readonly MAX_UNSUPPORTED_SEEN = 512;
  private static readonly MAX_DIAGNOSTIC_DEDUPE_KEYS = 512;
  private static readonly PREF_STORAGE_PREFIX = "director.pref.";
  private readonly globals = new Map<string, LingoValue>();
  private readonly movieHandlers = new Map<string, RegisteredScript>();
  private readonly movieScripts: RegisteredScript[] = [];
  private readonly scriptsByName = new Map<string, RegisteredScript>();
  private readonly scriptsByMember = new Map<string, RegisteredScript>();
  private readonly preferences = new Map<string, string>();
  private readonly deconstructingInstances = new WeakSet<ScriptInstance>();
  private readonly exactKeyPropLists = new WeakSet<LingoPropList>();
  private readonly handlerLabels = new WeakMap<GeneratedScriptModule, Map<string, string>>();
  private readonly unsupportedSeenKeys = new Set<string>();
  private readonly callTargetErrorKeys = new Set<string>();
  private readonly deferredVisualizerWrappers = new Set<ScriptInstance>();
  private readonly directorEventStack: DirectorEventContext[] = [];
  private unsupportedSeenTruncated = false;
  private handlerDispatchDepth = 0;
  private flushingDeferredVisualizerWrappers = false;
  private itemDelimiter = ",";
  private randomState = 0x12345678;
  private timerStartMs = nowMs();
  private resultRegister: LingoValue = LINGO_VOID;
  readonly unsupportedSeen: string[] = [];
  /** Live Lingo call stack ("Script.handler") for diagnostics. */
  readonly callStack: string[] = [];
  /** Parameter frames backing `the paramCount` / param(i). Method calls
   * include `me` as param 1, matching Director. */
  private readonly paramFrames: LingoValue[][] = [];
  /** Script instance whose handler is currently executing. Unqualified
   * Lingo properties bind to this script scope, not to a descendant that
   * happens to declare the same property name. */
  private readonly handlerPropertyScopes: ScriptInstance[] = [];
  /** Lowercased handler names to trace (diagnostics; set by tools). */
  readonly traceHandlers = new Set<string>();
  traceSink: (text: string) => void = (text) => console.log(text);
  constructor(private readonly host: DirectorHost = {}) {
    // Scripting objects resolve by bare name even when declared `global`.
    for (const name of ["_movie", "_player", "_system", "_sound"] as const) {
      this.globals.set(name, new ScriptingObjectRef(name));
    }
  }

  // -- registration ---------------------------------------------------------

  /** Register a generated script. Movie scripts contribute global handlers;
   * parent/behavior scripts are instantiable by member name. */
  register(module: GeneratedScriptModule, castFile: string, meta: ScriptRegistrationMeta = {}): void {
    const entry: RegisteredScript = { module, castFile, memberNumber: meta.memberNumber ?? null };
    if (module.scriptName) {
      this.scriptsByName.set(module.scriptName.toLowerCase(), entry);
    }
    if (entry.memberNumber !== null) {
      this.scriptsByMember.set(scriptMemberKey(castFile, entry.memberNumber), entry);
    }
    if (module.scriptType === "movie") {
      this.movieScripts.push(entry);
      for (const handlerName of Object.keys(module.handlers)) {
        if (!this.movieHandlers.has(handlerName)) {
          this.movieHandlers.set(handlerName, entry);
        }
      }
    }
  }

  findScript(name: string): ScriptRef | null {
    const entry = this.scriptsByName.get(name.toLowerCase());
    return entry ? new ScriptRef(entry.module) : null;
  }

  findScriptByMember(castFile: string, memberNumber: number): ScriptRef | null {
    const entry = this.scriptsByMember.get(scriptMemberKey(castFile, memberNumber));
    return entry ? new ScriptRef(entry.module) : null;
  }

  findScriptModuleByMember(castFile: string, memberNumber: number): GeneratedScriptModule | null {
    return this.scriptsByMember.get(scriptMemberKey(castFile, memberNumber))?.module ?? null;
  }

  movieEventModules(name: string): GeneratedScriptModule[] {
    const key = name.toLowerCase();
    return this.movieScripts
      .filter((entry) => entry.module.handlers[key] !== undefined)
      .map((entry) => entry.module);
  }

  hasGlobalHandler(name: string): boolean {
    return this.movieHandlers.has(name.toLowerCase());
  }

  callScriptHandler(
    module: GeneratedScriptModule,
    name: string,
    me: LingoValue,
    args: LingoValue[],
  ): LingoValue {
    const key = name.toLowerCase();
    const handler = module.handlers[key];
    if (!handler) return LINGO_VOID;
    if (this.traceHandlers.has(key)) {
      const label = this.handlerLabel(module, key);
      this.traceSink(
        `TRACE ${label}(${args.map((value) => ops.displayString(value)).join(", ")}) [from ${this.callStack.slice(-3).join(" > ")}]`,
      );
    }
    this.callStack.push(this.handlerLabel(module, key));
    this.paramFrames.push(args);
    this.handlerDispatchDepth += 1;
    try {
      return this.rememberResult(handler(this, me, args));
    } catch (error) {
      throw this.withStack(error);
    } finally {
      this.handlerDispatchDepth = Math.max(0, this.handlerDispatchDepth - 1);
      this.callStack.pop();
      this.paramFrames.pop();
      if (this.handlerDispatchDepth === 0) this.flushDeferredVisualizerWrappers();
    }
  }

  beginDirectorEvent(): DirectorEventContext {
    const context: DirectorEventContext = { stopped: false };
    this.directorEventStack.push(context);
    return context;
  }

  endDirectorEvent(context: DirectorEventContext): void {
    const active = this.directorEventStack.pop();
    if (active !== context) {
      this.directorEventStack.length = 0;
      throw new Error("Director event context stack mismatch");
    }
  }

  private activeDirectorEvent(): DirectorEventContext | null {
    return this.directorEventStack[this.directorEventStack.length - 1] ?? null;
  }

  // -- dispatch -------------------------------------------------------------

  callLocal(me: LingoValue, name: string, args: LingoValue[]): LingoValue {
    if (me instanceof ScriptInstance && this.hasHandler(me, name)) {
      return this.rememberResult(this.callHandlerOn(me, name, args));
    }
    return this.call(name, args);
  }

  call(name: string, args: LingoValue[]): LingoValue {
    const key = name.toLowerCase();
    // 1. Global handlers from loaded movie scripts (user code shadows builtins).
    const handlerEntry = this.movieHandlers.get(key);
    if (handlerEntry) {
      if (this.traceHandlers.has(key)) {
        const label = this.handlerLabel(handlerEntry.module, key);
        this.traceSink(
          `TRACE ${label}(${args.map((value) => ops.displayString(value)).join(", ")}) [from ${this.callStack.slice(-3).join(" > ")}]`,
        );
      }
      this.callStack.push(this.handlerLabel(handlerEntry.module, key));
      this.paramFrames.push(args);
      this.handlerDispatchDepth += 1;
      try {
        const result = handlerEntry.module.handlers[key]!(this, LINGO_VOID, args);
        return this.rememberResult(this.afterGlobalHandler(key, args, result));
      } catch (error) {
        throw this.withStack(error);
      } finally {
        this.handlerDispatchDepth = Math.max(0, this.handlerDispatchDepth - 1);
        this.callStack.pop();
        this.paramFrames.pop();
        if (this.handlerDispatchDepth === 0) this.flushDeferredVisualizerWrappers();
      }
    }
    // 2. Pure builtins.
    const builtin = this.builtin(key, args);
    if (builtin !== undefined) {
      return this.rememberResult(builtin);
    }
    // 3. Host builtins.
    const hostResult = this.host.call?.(key, args);
    if (hostResult !== undefined) {
      return this.rememberResult(hostResult);
    }
    return this.unsupported(`call ${key}(${args.length} args)`);
  }

  private rememberResult(result: LingoValue): LingoValue {
    this.resultRegister = result;
    return result;
  }

  private afterGlobalHandler(key: string, args: LingoValue[], result: LingoValue): LingoValue {
    if (result !== 0 || (key !== "getobject" && key !== "objectexists")) {
      return result;
    }
    const id = args[0] ?? LINGO_VOID;
    if (typeof id !== "string" && !(id instanceof LingoSymbol)) {
      return result;
    }
    const gcore = this.getGlobal("gcore");
    if (!(gcore instanceof ScriptInstance) || gcore.module.scriptName !== "Object Manager Class") {
      return result;
    }
    const objectList = this.getProp(gcore, "pobjectlist");
    if (!(objectList instanceof LingoPropList)) {
      return result;
    }

    let aliasObject: LingoValue = LINGO_VOID;
    if (typeof id === "string") {
      aliasObject = objectList.getaProp(LingoSymbol.for(id), ops.lingoKeyEquals);
    } else if (id instanceof LingoSymbol) {
      aliasObject = objectList.getaProp(id.name, ops.lingoKeyEquals);
    }
    if (aliasObject instanceof LingoVoid) {
      return result;
    }
    return key === "objectexists" ? (this.objectP(aliasObject) ? 1 : 0) : aliasObject;
  }

  private visualizerWrapperPresentationMethod(
    receiver: ScriptInstance,
    method: string,
    args: LingoValue[],
  ): LingoValue | undefined {
    if (receiver.module.scriptName !== "Visualizer Part Wrapper Class") {
      return undefined;
    }
    const key = method.toLowerCase();
    if (key === "renderimage" || key === "updatewrap") {
      this.deferredVisualizerWrappers.delete(receiver);
      return undefined;
    }
    if (key !== "removepart") {
      return undefined;
    }

    const partsOwner = this.instancePropOwner(receiver, "ppartlist");
    const parts = partsOwner?.props.get("ppartlist");
    if (!(parts instanceof LingoList)) {
      return undefined;
    }
    const partId = args[0] ?? LINGO_VOID;
    for (let index = 1; index <= parts.count(); index += 1) {
      const part = parts.items[index - 1];
      if (!(part instanceof LingoPropList)) continue;
      const id = part.getaProp(LingoSymbol.for("id"), ops.lingoKeyEquals);
      if (!ops.lingoEquals(id, partId)) continue;
      parts.deleteAt(index);
      this.markVisualizerWrapperDirty(receiver);
      if (this.handlerDispatchDepth === 0) {
        this.flushDeferredVisualizerWrappers();
      }
      return LINGO_VOID;
    }
    return LINGO_VOID;
  }

  private shadowManagerPresentationMethod(receiver: ScriptInstance, method: string): LingoValue | undefined {
    if (receiver.module.scriptName !== "Shadow Manager") {
      return undefined;
    }
    if (method.toLowerCase() !== "render") {
      return undefined;
    }
    const disabled = this.instancePropOwner(receiver, "prenderdisabled")?.props.get("prenderdisabled") ?? LINGO_VOID;
    if (ops.truthy(disabled)) {
      return 0;
    }
    const wrapper = this.instancePropOwner(receiver, "pshadowwrapper")?.props.get("pshadowwrapper");
    if (wrapper instanceof ScriptInstance && wrapper.module.scriptName === "Visualizer Part Wrapper Class") {
      this.markVisualizerWrapperDirty(wrapper);
      if (this.handlerDispatchDepth === 0) {
        this.flushDeferredVisualizerWrappers();
      }
    }
    return LINGO_VOID;
  }

  private markVisualizerWrapperDirty(wrapper: ScriptInstance): void {
    const statusOwner = this.instancePropOwner(wrapper, "pwrapperstatus");
    const status = statusOwner?.props.get("pwrapperstatus");
    if (status instanceof LingoPropList) {
      status.setaProp(LingoSymbol.for("rendered"), 0, ops.lingoKeyEquals);
      status.setaProp(LingoSymbol.for("rectOk"), 0, ops.lingoKeyEquals);
    }
    this.deferredVisualizerWrappers.add(wrapper);
  }

  private visualizerWrapperNeedsFlush(wrapper: ScriptInstance): boolean {
    if (wrapper.module.scriptName !== "Visualizer Part Wrapper Class") {
      return false;
    }
    const statusOwner = this.instancePropOwner(wrapper, "pwrapperstatus");
    const status = statusOwner?.props.get("pwrapperstatus");
    if (!(status instanceof LingoPropList)) {
      return true;
    }
    const rendered = status.getaProp(LingoSymbol.for("rendered"), ops.lingoKeyEquals);
    const rectOk = status.getaProp(LingoSymbol.for("rectOk"), ops.lingoKeyEquals);
    return !ops.truthy(rendered) || !ops.truthy(rectOk);
  }

  private flushDeferredVisualizerWrappers(): void {
    if (this.flushingDeferredVisualizerWrappers || this.deferredVisualizerWrappers.size === 0) {
      return;
    }
    this.flushingDeferredVisualizerWrappers = true;
    try {
      const wrappers = Array.from(this.deferredVisualizerWrappers);
      this.deferredVisualizerWrappers.clear();
      for (const wrapper of wrappers) {
        if (!this.visualizerWrapperNeedsFlush(wrapper)) continue;
        this.callMethod(wrapper, "updatewrap", []);
      }
    } finally {
      this.flushingDeferredVisualizerWrappers = false;
    }
  }

  callHandlerOn(instance: ScriptInstance, name: string, args: LingoValue[]): LingoValue {
    const key = name.toLowerCase();
    let target: ScriptInstance | LingoVoid = instance;
    while (target instanceof ScriptInstance) {
      const handler = target.module.handlers[key];
      if (handler) {
        if (this.traceHandlers.has(key)) {
          const label = this.handlerLabel(target.module, key);
          this.traceSink(
            `TRACE ${label}(${args.map((value) => ops.displayString(value)).join(", ")}) [from ${this.callStack.slice(-3).join(" > ")}]`,
          );
        }
        this.callStack.push(this.handlerLabel(target.module, key));
        this.paramFrames.push(args);
        this.handlerPropertyScopes.push(target);
        this.handlerDispatchDepth += 1;
        try {
          return handler(this, instance, args);
        } catch (error) {
          throw this.withStack(error);
        } finally {
          this.handlerDispatchDepth = Math.max(0, this.handlerDispatchDepth - 1);
          this.handlerPropertyScopes.pop();
          this.callStack.pop();
          this.paramFrames.pop();
          if (this.handlerDispatchDepth === 0) this.flushDeferredVisualizerWrappers();
        }
      }
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : LINGO_VOID;
    }
    // Method not on the instance: Lingo falls back to a global handler with
    // the instance as first argument? No - that is an error in Director.
    return this.unsupported(`handler ${key} on ${instance.module.scriptName}`);
  }

  private handlerLabel(module: GeneratedScriptModule, key: string): string {
    let labels = this.handlerLabels.get(module);
    if (!labels) {
      labels = new Map();
      this.handlerLabels.set(module, labels);
    }
    let label = labels.get(key);
    if (!label) {
      label = `${module.scriptName}.${key}`;
      labels.set(key, label);
    }
    return label;
  }

  /** Does the instance (or an ancestor) define a handler? */
  hasHandler(instance: ScriptInstance, name: string): boolean {
    const key = name.toLowerCase();
    let target: ScriptInstance | null = instance;
    while (target) {
      if (target.module.handlers[key]) return true;
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : null;
    }
    return false;
  }

  callMethod(receiver: LingoValue, method: string, args: LingoValue[]): LingoValue {
    if (receiver instanceof LingoVoid && method.toLowerCase() === "new") {
      return this.rememberResult(LINGO_VOID);
    }
    if (receiver instanceof ScriptInstance) {
      const objectManagerResult = this.objectManagerMethod(receiver, method, args);
      if (objectManagerResult !== undefined) {
        return this.rememberResult(objectManagerResult);
      }
      const visualizerWrapperResult = this.visualizerWrapperPresentationMethod(receiver, method, args);
      if (visualizerWrapperResult !== undefined) {
        return this.rememberResult(visualizerWrapperResult);
      }
      const shadowManagerResult = this.shadowManagerPresentationMethod(receiver, method);
      if (shadowManagerResult !== undefined) {
        return this.rememberResult(shadowManagerResult);
      }
      const methodArgs = this.managerCanonicalArgs(receiver, method, args);
      if (this.hasHandler(receiver, method)) {
        // Method dispatch passes the receiver as positional param 1
        // (`on handler me, ...`).
        const result = this.callHandlerOn(receiver, method, [receiver, ...methodArgs]);
        this.afterScriptMethod(receiver, method, methodArgs, result);
        return this.rememberResult(result);
      }
      // Director object built-ins: instances respond to handler() and the
      // property-list accessors (Object Manager relies on obj.setaProp).
      switch (method) {
        case "handler": {
          const name = args[0] instanceof LingoSymbol ? (args[0] as LingoSymbol).name : ops.stringOf(args[0] ?? LINGO_VOID);
          return this.hasHandler(receiver, name) ? 1 : 0;
        }
        case "setaprop": {
          const key = args[0] instanceof LingoSymbol ? (args[0] as LingoSymbol).name : ops.stringOf(args[0] ?? LINGO_VOID);
          receiver.props.set(key.toLowerCase(), args[1] ?? LINGO_VOID);
          return LINGO_VOID;
        }
        case "getaprop": {
          const key = args[0] instanceof LingoSymbol ? (args[0] as LingoSymbol).name : ops.stringOf(args[0] ?? LINGO_VOID);
          return receiver.props.get(key.toLowerCase()) ?? LINGO_VOID;
        }
        default:
          return this.callHandlerOn(receiver, method, methodArgs);
      }
    }
    if (receiver instanceof ScriptRef) {
      if (method === "new") {
        return this.instantiate(receiver.module, args);
      }
      return this.unsupported(`script method ${method}`);
    }
    if (receiver instanceof MissingScriptRef) {
      if (method === "new" || method === "rawnew") {
        return new MissingScriptInstance(receiver);
      }
      return this.unsupported(`missing script method ${method}`);
    }
    if (receiver instanceof MissingScriptInstance) {
      if (method === "handler") {
        return 0;
      }
      return LINGO_VOID;
    }
    if (receiver instanceof LingoList || receiver instanceof LingoPropList) {
      return this.listMethod(receiver, method, args);
    }
    if (receiver instanceof LingoImage) {
      return this.imageMethod(receiver, method, args);
    }
    if (receiver instanceof LingoColor) {
      return this.colorMethod(receiver, method, args);
    }
    if (typeof receiver === "number" || receiver instanceof LingoFloat) {
      switch (method.toLowerCase()) {
        case "sin":
          return float(Math.sin(toNumber(receiver)));
        case "cos":
          return float(Math.cos(toNumber(receiver)));
        case "tan":
          return float(Math.tan(toNumber(receiver)));
        case "atan":
          return float(Math.atan(toNumber(receiver)));
      }
    }
    if (receiver instanceof XmlParserInstance) {
      if (method === "parsestring" || method === "parsedata") {
        return receiver.parseString(ops.stringOf(args[0] ?? LINGO_VOID));
      }
      if (method === "geterror") {
        return receiver.getError();
      }
    }
    if (receiver instanceof LingoPoint) {
      switch (method) {
        case "inside": {
          const rect = args[0];
          return rect instanceof LingoRect &&
            receiver.x >= rect.left &&
            receiver.x < rect.right &&
            receiver.y >= rect.top &&
            receiver.y < rect.bottom
            ? 1
            : 0;
        }
        case "duplicate":
          return new LingoPoint(receiver.x, receiver.y);
      }
    }
    if (receiver instanceof LingoRect) {
      switch (method) {
        case "duplicate":
          return new LingoRect(receiver.left, receiver.top, receiver.right, receiver.bottom);
        case "union": {
          const other = args[0] ?? LINGO_VOID;
          return other instanceof LingoRect
            ? rectUnion(receiver, other)
            : this.unsupported(`rect.union(${describeValue(other)})`);
        }
        case "intersect": {
          const other = args[0] ?? LINGO_VOID;
          return other instanceof LingoRect
            ? rectIntersection(receiver, other)
            : this.unsupported(`rect.intersect(${describeValue(other)})`);
        }
      }
    }
    if (typeof receiver === "string") {
      return this.stringMethod(receiver, method, args);
    }
    const hostMethod = this.host.callMethod?.(receiver, method, args);
    if (hostMethod !== undefined) {
      return hostMethod;
    }
    const hostResult = this.host.call?.(method, [receiver, ...args]);
    if (hostResult !== undefined) {
      return hostResult;
    }
    if (isPrimitiveMethodReceiver(receiver)) {
      throw new ops.LingoScriptError(`method ${method} on ${describeValue(receiver)}`);
    }
    return this.unsupported(`method ${method} on ${describeValue(receiver)}`);
  }

  private objectManagerMethod(
    receiver: ScriptInstance,
    method: string,
    args: LingoValue[],
  ): LingoValue | undefined {
    if (receiver.module.scriptName !== "Object Manager Class") {
      return undefined;
    }
    if (method.toLowerCase() !== "remove") {
      return undefined;
    }
    return this.objectManagerRemove(receiver, args[0] ?? LINGO_VOID);
  }

  private managerCanonicalArgs(
    receiver: ScriptInstance,
    method: string,
    args: LingoValue[],
  ): LingoValue[] {
    const key = method.toLowerCase();
    if (
      key !== "get" &&
      key !== "remove" &&
      key !== "create" &&
      key !== "registerlistener" &&
      key !== "unregisterlistener" &&
      key !== "registercommands" &&
      key !== "unregistercommands"
    ) {
      return args;
    }
    if (!this.instanceHasScript(receiver, "Manager Template Class")) {
      return args;
    }
    const canonical = this.canonicalManagerItemId(receiver, args[0] ?? LINGO_VOID);
    if (canonical === args[0] || canonical instanceof LingoVoid) {
      return args;
    }
    return [canonical, ...args.slice(1)];
  }

  private canonicalManagerItemId(manager: ScriptInstance, id: LingoValue): LingoValue {
    const itemList = this.getProp(manager, "pitemlist");
    if (!(itemList instanceof LingoList)) {
      return id;
    }
    for (const item of itemList.items) {
      if (ops.lingoKeyEquals(item, id)) {
        return item;
      }
    }
    for (const item of itemList.items) {
      if (ops.lingoEquals(item, id)) {
        return item;
      }
    }
    return id;
  }

  private afterScriptMethod(
    receiver: ScriptInstance,
    method: string,
    args: LingoValue[],
    result: LingoValue,
  ): void {
    if (receiver.module.scriptName !== "Object Manager Class") {
      return;
    }
    const key = method.toLowerCase();
    if (key === "create") {
      const id = args[0] ?? LINGO_VOID;
      if (id instanceof LingoVoid || ops.lingoEquals(id, LingoSymbol.for("temp"))) {
        return;
      }
      if (result instanceof ScriptInstance) {
        this.host.objectRegistered?.(id, result, args[1] ?? LINGO_VOID);
      }
      return;
    }
    if (key === "registerobject") {
      const id = args[0] ?? LINGO_VOID;
      const object = args[1] ?? LINGO_VOID;
      if (id instanceof LingoVoid || object instanceof LingoVoid || !ops.truthy(result)) {
        return;
      }
      this.host.objectRegistered?.(id, object, LINGO_VOID);
    }
  }

  private objectManagerRemove(manager: ScriptInstance, objectId: LingoValue): LingoValue {
    const objectList = this.getProp(manager, "pobjectlist");
    if (!(objectList instanceof LingoPropList)) {
      return this.unsupported("Object Manager Class.remove without pObjectList");
    }

    const object = objectList.getaProp(objectId, ops.lingoKeyEquals);
    if (object instanceof LingoVoid) {
      return 0;
    }

    if (object instanceof ScriptInstance) {
      if (this.deconstructingInstances.has(object)) {
        return 0;
      }
      const valid = this.getProp(object, "valid");
      if (!ops.truthy(valid)) {
        return 0;
      }

      const delays = this.getProp(object, "delays");
      if (delays instanceof LingoPropList) {
        const delayIds: LingoValue[] = [];
        for (let index = 1; index <= delays.count(); index += 1) {
          delayIds.push(delays.getPropAt(index));
        }
        for (const delayId of delayIds) {
          this.callMethod(object, "cancel", [delayId]);
        }
      }

      const childObjects = this.visualizerWrapperChildren(object);
      this.deconstructingInstances.add(object);
      try {
        this.callMethod(object, "deconstruct", []);
      } finally {
        this.deconstructingInstances.delete(object);
      }
      this.setProp(object, "valid", 0);
      this.unregisterObjectManagerChildren(manager, objectList, childObjects);
    }

    const updateList = this.getProp(manager, "pupdatelist");
    if (updateList instanceof LingoList) {
      updateList.deleteOne(object, ops.lingoEquals);
    }
    const prepareList = this.getProp(manager, "ppreparelist");
    if (prepareList instanceof LingoList) {
      prepareList.deleteOne(object, ops.lingoEquals);
    }

    const eraseLock = this.getProp(manager, "peraselock");
    if (!ops.truthy(eraseLock)) {
      objectList.deleteProp(objectId, ops.lingoKeyEquals);
      const instanceList = this.getProp(manager, "pinstancelist");
      if (instanceList instanceof LingoList) {
        instanceList.deleteOne(objectId, ops.lingoKeyEquals);
      }
      const managerList = this.getProp(manager, "pmanagerlist");
      if (managerList instanceof LingoList) {
        managerList.deleteOne(objectId, ops.lingoKeyEquals);
      }
    }

    return 1;
  }

  private visualizerWrapperChildren(object: ScriptInstance): ScriptInstance[] {
    if (object.module.scriptName !== "Visualizer Instance Class") {
      return [];
    }
    const owner = this.instancePropOwner(object, "pwrappedparts");
    const wrappedParts = owner?.props.get("pwrappedparts");
    if (!(wrappedParts instanceof LingoPropList)) {
      return [];
    }
    return wrappedParts.values.filter(
      (value): value is ScriptInstance =>
        value instanceof ScriptInstance && value.module.scriptName === "Visualizer Part Wrapper Class",
    );
  }

  private unregisterObjectManagerChildren(
    manager: ScriptInstance,
    objectList: LingoPropList,
    children: ScriptInstance[],
  ): void {
    if (children.length === 0) {
      return;
    }
    const updateList = this.getProp(manager, "pupdatelist");
    const prepareList = this.getProp(manager, "ppreparelist");
    const instanceList = this.getProp(manager, "pinstancelist");
    const managerList = this.getProp(manager, "pmanagerlist");
    const childSet = new Set(children);
    for (let index = objectList.values.length - 1; index >= 0; index -= 1) {
      const child = objectList.values[index];
      if (!(child instanceof ScriptInstance) || !childSet.has(child)) {
        continue;
      }
      const childId = objectList.keys[index] ?? LINGO_VOID;
      this.setProp(child, "valid", 0);
      if (updateList instanceof LingoList) {
        updateList.deleteOne(child, ops.lingoEquals);
      }
      if (prepareList instanceof LingoList) {
        prepareList.deleteOne(child, ops.lingoEquals);
      }
      if (instanceList instanceof LingoList) {
        instanceList.deleteOne(childId, ops.lingoKeyEquals);
      }
      if (managerList instanceof LingoList) {
        managerList.deleteOne(childId, ops.lingoKeyEquals);
      }
      objectList.deleteAt(index + 1);
    }
  }

  private objectP(value: LingoValue): boolean {
    if (!isLingoObject(value)) {
      return false;
    }
    if (value instanceof MissingScriptRef || value instanceof MissingScriptInstance) {
      return false;
    }
    if (value instanceof ScriptInstance) {
      if (this.deconstructingInstances.has(value)) {
        return false;
      }
      const valid = value.props.get("valid");
      if (valid === 0 || (valid instanceof LingoFloat && valid.value === 0)) {
        return false;
      }
    }
    return true;
  }

  /** Built-in methods on linear and property lists. */
  private listMethod(
    receiver: LingoList | LingoPropList,
    method: string,
    args: LingoValue[],
  ): LingoValue {
    const eq = ops.lingoEquals;
    const a = (index: number): LingoValue => args[index] ?? LINGO_VOID;
    switch (method) {
      case "count":
        return receiver.count();
      case "getat":
        return receiver.getAt(toIndex(a(0)));
      case "setat":
        receiver.setAt(toIndex(a(0)), a(1));
        return LINGO_VOID;
      case "duplicate":
        return receiver.duplicate();
      case "getlast":
        return receiver.getLast();
      case "deleteat":
        receiver.deleteAt(toIndex(a(0)));
        return LINGO_VOID;
      case "getpos":
        return receiver.getPos(a(0), eq);
      case "getone":
        return receiver.getOne(a(0), eq);
      case "findpos":
        // findPos on a linear list behaves like getPos (position or 0).
        return receiver instanceof LingoPropList
          ? this.propListFindReadPos(receiver, a(0))
          : receiver.getPos(a(0), eq);
      case "sort":
        receiver.sort(receiver instanceof LingoList ? ops.compareSortValues : ops.compareValues);
        return LINGO_VOID;
    }
    if (receiver instanceof LingoList) {
      switch (method) {
        case "add":
          receiver.add(a(0));
          return LINGO_VOID;
        case "append":
          receiver.append(a(0));
          return LINGO_VOID;
        case "addat":
          receiver.addAt(toIndex(a(0)), a(1));
          return LINGO_VOID;
        case "deleteone":
          return receiver.deleteOne(a(0), eq);
      }
    }
    if (receiver instanceof LingoPropList) {
      switch (method) {
        case "getaprop":
          return this.propListGetAProp(receiver, a(0));
        case "getprop":
          return this.propListGetProp(receiver, a(0));
        case "setprop": {
          const pos = receiver.findPos(a(0), ops.lingoKeyEquals);
          if (pos instanceof LingoVoid) {
            throw new RangeError(`property not found: ${ops.displayString(a(0))}`);
          }
          receiver.setAt(pos, a(1));
          return LINGO_VOID;
        }
        case "setaprop":
          receiver.setaProp(a(0), a(1), ops.lingoKeyEquals);
          return LINGO_VOID;
        case "addprop":
          receiver.addProp(a(0), a(1), ops.compareValues);
          return LINGO_VOID;
        case "deleteprop":
          return receiver.deleteProp(a(0), ops.lingoKeyEquals);
        case "findpos":
          return this.propListFindReadPos(receiver, a(0));
        case "getpropat":
          return receiver.getPropAt(toIndex(a(0)));
      }
    }
    return this.unsupported(`list method ${method}`);
  }

  private propListFindReadPos(list: LingoPropList, key: LingoValue): number | LingoVoid {
    const exact = list.findPos(key, ops.lingoKeyEquals);
    if (!(exact instanceof LingoVoid)) {
      return exact;
    }
    return list.findPos(key, ops.lingoEquals);
  }

  private propListGetAProp(list: LingoPropList, key: LingoValue): LingoValue {
    const pos = this.propListFindReadPos(list, key);
    return pos instanceof LingoVoid ? LINGO_VOID : list.getAt(pos);
  }

  private propListGetProp(list: LingoPropList, key: LingoValue): LingoValue {
    const pos = this.propListFindReadPos(list, key);
    if (pos instanceof LingoVoid) {
      throw new RangeError(`property not found: ${ops.displayString(key)}`);
    }
    return list.getAt(pos);
  }

  /** Director image methods used by the window/visualizer compositing. */
  private imageMethod(image: LingoImage, method: string, args: LingoValue[]): LingoValue {
    image = image.resolveLiveReference();
    switch (method.toLowerCase()) {
      case "copypixels": {
        const source = args[0] instanceof LingoImage ? args[0].resolveLiveReference() : args[0];
        if (!(source instanceof LingoImage)) return LINGO_VOID;
        const dest = args[1];
        const sourceRect = args[2];
        if (!(sourceRect instanceof LingoRect)) return LINGO_VOID;
        let copyParams: CopyPixelsParams | null = null;
        const params = args[3];
        if (params instanceof LingoPropList) {
          copyParams = {};
          const blend = params.getaProp(LingoSymbol.for("blend"), ops.lingoKeyEquals);
          if (typeof blend === "number") copyParams.blend = blend;
          const blendLevel = params.getaProp(LingoSymbol.for("blendlevel"), ops.lingoKeyEquals);
          if (typeof blendLevel === "number") copyParams.blend = blendLevel;
          const ink = params.getaProp(LingoSymbol.for("ink"), ops.lingoKeyEquals);
          const inkValue = copyPixelsInkValue(ink);
          if (inkValue !== null) copyParams.ink = inkValue;
          const color = params.getaProp(LingoSymbol.for("color"), ops.lingoKeyEquals);
          if (color instanceof LingoColor) copyParams.color = color;
          const bgColor = params.getaProp(LingoSymbol.for("bgcolor"), ops.lingoKeyEquals);
          if (bgColor instanceof LingoColor) copyParams.bgColor = bgColor;
          const paletteRef = params.getaProp(LingoSymbol.for("paletteref"), ops.lingoKeyEquals);
          if (!(paletteRef instanceof LingoVoid)) {
            copyParams.paletteRef = paletteRef;
          } else {
            const palette = params.getaProp(LingoSymbol.for("palette"), ops.lingoKeyEquals);
            if (!(palette instanceof LingoVoid)) copyParams.paletteRef = palette;
          }
          const rawMaskImage = params.getaProp(LingoSymbol.for("maskimage"), ops.lingoKeyEquals);
          const maskImage = rawMaskImage instanceof LingoImage ? rawMaskImage.resolveLiveReference() : rawMaskImage;
          if (maskImage instanceof LingoImage) copyParams.maskImage = maskImage;
          const maskOffset = params.getaProp(LingoSymbol.for("maskoffset"), ops.lingoKeyEquals);
          if (maskOffset instanceof LingoPoint) copyParams.maskOffset = maskOffset;
        }
        if (dest instanceof LingoRect || dest instanceof LingoPoint) {
          image.copyPixels(source, dest, sourceRect, copyParams);
        } else if (dest instanceof LingoList && dest.items.length === 4 && dest.items.every((p) => p instanceof LingoPoint)) {
          // Quad destination [UL, UR, LR, LL]: Director maps source corners
          // to the four points. Habbo uses this for flips and 90-degree
          // rotations when building source UI image buffers.
          const [ul, ur, lr, ll] = dest.items as [LingoPoint, LingoPoint, LingoPoint, LingoPoint];
          const xs = [ul.x, ur.x, lr.x, ll.x];
          const ys = [ul.y, ur.y, lr.y, ll.y];
          const rect = new LingoRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
          copyParams = copyParams ?? {};
          const transform = classifyCopyPixelsQuadTransform([ul, ur, lr, ll], rect);
          if (transform) {
            copyParams.quadTransform = transform;
          } else {
            copyParams.quadPoints = [ul, ur, lr, ll];
          }
          image.copyPixels(source, rect, sourceRect, copyParams);
        }
        return LINGO_VOID;
      }
      case "fill": {
        let rect: LingoRect | null = null;
        let color = args[args.length - 1] ?? LINGO_VOID;
        if (args[0] instanceof LingoRect) {
          rect = args[0];
          color = args[1] ?? LINGO_VOID;
        } else if (args.length >= 5) {
          rect = new LingoRect(
            toNumber(args[0] ?? 0),
            toNumber(args[1] ?? 0),
            toNumber(args[2] ?? 0),
            toNumber(args[3] ?? 0),
          );
          color = args[4] ?? LINGO_VOID;
        }
        if (color instanceof LingoPropList) {
          // fill(rect, [#shape: #rect, #color: c]) draw-parameter form.
          color = color.getaProp(LingoSymbol.for("color"), ops.lingoKeyEquals);
        }
        if (color instanceof LingoVoid) {
          image.fill(rect, new LingoColor(255, 255, 255));
        } else if (color instanceof LingoColor) {
          image.fill(rect, color);
        }
        return LINGO_VOID;
      }
      case "setalpha": {
        const alpha = args[0];
        if (alpha instanceof LingoImage || typeof alpha === "number") {
          image.setAlpha(alpha);
        }
        return LINGO_VOID;
      }
      case "trimwhitespace":
        return image.trimWhiteSpace();
      case "setpixel": {
        const color = args[args.length - 1];
        if (color instanceof LingoColor) {
          if (args[0] instanceof LingoPoint) {
            image.setPixel(args[0].x, args[0].y, color);
          } else {
            image.setPixel(toNumber(args[0] ?? 0), toNumber(args[1] ?? 0), color);
          }
        }
        return LINGO_VOID;
      }
      case "getpixel": {
        if (args[0] instanceof LingoPoint) {
          return image.getPixel(args[0].x, args[0].y);
        }
        return image.getPixel(toNumber(args[0] ?? 0), toNumber(args[1] ?? 0));
      }
      case "duplicate":
        return image.duplicate();
      case "getrect":
        return image.getRect();
      case "createmask":
        return image.createMask();
      case "creatematte":
        return image.createMatte();
      case "draw": {
        // draw(rect, [#shapeType: ..., #color: ...]) outline drawing.
        const rect = args[0];
        const params = args[1];
        if (rect instanceof LingoRect && params instanceof LingoPropList) {
          const color = params.getaProp(LingoSymbol.for("color"), ops.lingoKeyEquals);
          if (color instanceof LingoColor) {
            image.fill(new LingoRect(rect.left, rect.top, rect.right, rect.top + 1), color);
            image.fill(new LingoRect(rect.left, rect.bottom - 1, rect.right, rect.bottom), color);
            image.fill(new LingoRect(rect.left, rect.top, rect.left + 1, rect.bottom), color);
            image.fill(new LingoRect(rect.right - 1, rect.top, rect.right, rect.bottom), color);
          }
        }
        return LINGO_VOID;
      }
      case "crop": {
        const rect = args[0];
        if (rect instanceof LingoRect) {
          const cropped = new LingoImage(rect.width, rect.height, image.depth);
          cropped.copyPixels(image, cropped.getRect(), rect, null);
          return cropped;
        }
        return image;
      }
      default:
        return this.unsupported(`image method ${method}`);
    }
  }

  /** Built-in methods on Director color values. */
  private colorMethod(color: LingoColor, method: string, args: LingoValue[]): LingoValue {
    switch (method) {
      case "hexstring":
        void args;
        return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
      case "duplicate":
        void args;
        return new LingoColor(color.r, color.g, color.b, color.paletteIndex);
      default:
        return this.unsupported(`color method ${method}`);
    }
  }

  /** Built-in methods on strings (rare; most string work uses chunks). */
  private stringMethod(receiver: string, method: string, args: LingoValue[]): LingoValue {
    switch (method) {
      case "count":
      case "length":
        return receiver.length;
      case "duplicate":
        return receiver;
      default:
        void args;
        return this.unsupported(`string method ${method}`);
    }
  }

  // -- properties and indexing ----------------------------------------------

  getProp(receiver: LingoValue, property: string): LingoValue {
    const key = property.toLowerCase();
    if (receiver instanceof ScriptInstance) {
      const direct = this.instancePropOwner(receiver, key);
      if (direct) {
        return direct.props.get(key)!;
      }
      if (key === "ilk") {
        return LingoSymbol.for("instance");
      }
      return this.unsupported(`property ${key} of ${receiver.module.scriptName}`);
    }
    if (receiver instanceof LingoList) {
      if (key === "count" || key === "length") return receiver.count();
      if (key === "ilk") return LingoSymbol.for("list");
      return this.unsupported(`property ${key} of list`);
    }
    if (receiver instanceof LingoPropList) {
      const propKey = LingoSymbol.for(key);
      const propPos = this.propListFindReadPos(receiver, propKey);
      if (!(propPos instanceof LingoVoid)) {
        return receiver.getAt(propPos);
      }
      if (key === "count") return receiver.count();
      if (key === "ilk") return LingoSymbol.for("propList");
      // Dot access reads the property entry (getProp semantics).
      return this.propListGetProp(receiver, propKey);
    }
    if (key === "ilk") {
      const kind = ilkOf(receiver);
      return LingoSymbol.for(kind === "proplist" ? "propList" : kind);
    }
    if (typeof receiver === "string") {
      if (key === "length") return receiver.length;
      if (key === "string") return receiver;
      if (key === "integer") return integerOfString(receiver);
      if (key === "char" || key === "word" || key === "item" || key === "line") {
        return new ChunkRef(receiver, key);
      }
      return this.unsupported(`property ${key} of string`);
    }
    if (receiver instanceof ChunkRef) {
      if (key === "count") {
        return this.chunkCount(receiver.source, receiver.chunkType);
      }
      const hostResult = this.host.getProp?.(receiver, key);
      if (hostResult !== undefined) {
        return hostResult;
      }
      return this.unsupported(`property ${key} of chunk`);
    }
    if (receiver instanceof XmlParserInstance) {
      // Parser root proxies the document: parser.child[i] walks top level.
      if (key === "child") return receiver.root?.child ?? new LingoList();
      if (key === "name") return "";
      return this.unsupported(`property ${key} of xmlparser`);
    }
    if (receiver instanceof XmlNode) {
      switch (key) {
        case "name":
          return receiver.name;
        case "text":
          return receiver.text;
        case "child":
          return receiver.child;
        case "attributename":
          return receiver.attributeName;
        case "attributevalue":
          return receiver.attributeValue;
        case "count":
          return receiver.child.count();
        default:
          return this.unsupported(`property ${key} of xmlnode`);
      }
    }
    if (receiver instanceof LingoImage) {
      const image = receiver.resolveLiveReference();
      switch (key) {
        case "width":
          return image.width;
        case "height":
          return image.height;
        case "depth":
          return image.depth;
        case "rect":
          return image.getRect();
        case "paletteref":
          return image.paletteRef;
        case "usealpha":
          return image.useAlpha;
        default:
          return this.unsupported(`property ${key} of image`);
      }
    }
    if (receiver instanceof LingoColor) {
      switch (key) {
        case "red":
          return receiver.r;
        case "green":
          return receiver.g;
        case "blue":
          return receiver.b;
        case "paletteindex":
          return receiver.paletteIndex ?? nearestDirectorPaletteIndex(receiver);
        case "colortype":
          return LingoSymbol.for(receiver.paletteIndex === null ? "rgb" : "paletteIndex");
        default:
          return this.unsupported(`property ${key} of color`);
      }
    }
    if (receiver instanceof LingoDate) {
      switch (key) {
        case "year":
          return receiver.year;
        case "month":
          return receiver.month;
        case "day":
          return receiver.day;
        default:
          return this.unsupported(`property ${key} of date`);
      }
    }
    if (receiver instanceof LingoPoint) {
      switch (key) {
        case "loch":
          return receiver.x;
        case "locv":
          return receiver.y;
        default:
          return this.unsupported(`property ${key} of point`);
      }
    }
    if (receiver instanceof LingoRect) {
      switch (key) {
        case "left":
          return receiver.left;
        case "top":
          return receiver.top;
        case "right":
          return receiver.right;
        case "bottom":
          return receiver.bottom;
        case "width":
          return receiver.width;
        case "height":
          return receiver.height;
        default:
          return this.unsupported(`property ${key} of rect`);
      }
    }
    if (receiver instanceof ScriptingObjectRef) {
      switch (key) {
        case "tracescript":
        case "trace":
          return 0;
        case "windowlist":
          return receiver.windowList;
        case "productversion":
          // The 2024 Origins client ships a Director 11+ projector (the
          // Steam Xtra in Client Initialization proves the 2024 build);
          // source gates Unicode handling on `>= 11`, and this runtime is
          // natively Unicode, so the D11+ path is the faithful one.
          return "12.0";
        default:
          return this.unsupported(`${receiver.lingoType}.${key}`);
      }
    }
    const hostResult = this.host.getProp?.(receiver, key);
    if (hostResult !== undefined) {
      return hostResult;
    }
    // Director value-level properties the release306 source relies on:
    // `tid.string` stringifies any scalar (Room Component addSlideObject runs
    // it on packet numbers), `tValue.integer` rounds like integer() (Active
    // Object animateSlide), `sprite.member.name` tolerates the empty member
    // sentinel 0 in optional user sprite slots, and `pEnterRoomAlert.length`
    // is read while the property is still VOID on first room entry
    // (length of VOID = 0).
    if (key === "string" && (typeof receiver === "number" || typeof receiver === "string")) {
      return ops.stringOf(receiver);
    }
    if (key === "integer" && (typeof receiver === "number" || receiver instanceof LingoFloat)) {
      return Math.round(toNumber(receiver));
    }
    if (key === "name" && receiver === 0) {
      return "";
    }
    if (receiver instanceof LingoVoid) {
      if (key === "length") return 0;
      if (key === "string") return "";
    }
    return this.unsupported(`property ${key} of ${describeValue(receiver)}`);
  }

  setProp(receiver: LingoValue, property: string, value: LingoValue): void {
    const key = property.toLowerCase();
    if (receiver instanceof ScriptInstance) {
      const owner = this.instancePropOwner(receiver, key) ?? receiver;
      owner.props.set(key, value);
      this.trackExactKeyPropList(owner, key, value);
      return;
    }
    if (receiver instanceof LingoPropList) {
      receiver.setaProp(LingoSymbol.for(key), value, ops.lingoKeyEquals);
      return;
    }
    if (receiver instanceof ScriptingObjectRef) {
      if (key === "tracescript" || key === "trace") {
        return; // debug switches accepted and ignored
      }
      this.unsupported(`set ${receiver.lingoType}.${key}`);
    }
    if (receiver instanceof LingoImage) {
      const image = receiver.resolveLiveReference();
      if (key === "paletteref") {
        image.paletteRef = value;
        return;
      }
      if (key === "usealpha") {
        image.useAlpha = toNumber(value) ? 1 : 0;
        return;
      }
      this.unsupported(`set property ${key} of image`);
    }
    if (receiver instanceof LingoColor) {
      switch (key) {
        case "red":
          receiver.r = toNumber(value);
          receiver.paletteIndex = null;
          return;
        case "green":
          receiver.g = toNumber(value);
          receiver.paletteIndex = null;
          return;
        case "blue":
          receiver.b = toNumber(value);
          receiver.paletteIndex = null;
          return;
        case "paletteindex": {
          const color = directorPaletteIndex(value);
          receiver.r = color.r;
          receiver.g = color.g;
          receiver.b = color.b;
          receiver.paletteIndex = color.paletteIndex;
          return;
        }
        default:
          this.unsupported(`set property ${key} of color`);
      }
    }
    if (receiver instanceof LingoPoint) {
      switch (key) {
        case "loch":
          receiver.x = toNumber(value);
          return;
        case "locv":
          receiver.y = toNumber(value);
          return;
        default:
          this.unsupported(`set property ${key} of point`);
      }
    }
    if (receiver instanceof LingoRect) {
      switch (key) {
        case "left":
          receiver.left = toNumber(value);
          return;
        case "top":
          receiver.top = toNumber(value);
          return;
        case "right":
          receiver.right = toNumber(value);
          return;
        case "bottom":
          receiver.bottom = toNumber(value);
          return;
        case "width":
          receiver.right = receiver.left + toNumber(value);
          return;
        case "height":
          receiver.bottom = receiver.top + toNumber(value);
          return;
        default:
          this.unsupported(`set property ${key} of rect`);
      }
    }
    if (this.host.setProp?.(receiver, key, value)) {
      return;
    }
    this.unsupported(`set property ${key} of ${describeValue(receiver)}`);
  }

  /** Walks the ancestor chain to find which instance declares a property. */
  private instancePropOwner(instance: ScriptInstance, key: string): ScriptInstance | null {
    let target: ScriptInstance | null = instance;
    while (target) {
      if (target.props.has(key)) {
        return target;
      }
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : null;
    }
    return null;
  }

  getIndex(receiver: LingoValue, indices: LingoValue[], rangeEnd: LingoValue | null): LingoValue {
    if (receiver instanceof ChunkRef) {
      const start = indices[0] ?? 1;
      const selection = this.chunkSelection(receiver.chunkType, start, rangeEnd, receiver.source);
      if (receiver.owner) {
        return receiver.withSelection(selection.text, selection.start, selection.end);
      }
      return selection.text;
    }
    if (rangeEnd !== null) {
      if (receiver instanceof LingoList) {
        const start = toIndex(indices[0]!);
        const end = toIndex(rangeEnd);
        return new LingoList(receiver.items.slice(Math.max(0, start - 1), end));
      }
      if (typeof receiver === "string") {
        return this.chunk("char", indices[0]!, rangeEnd, receiver);
      }
      return this.unsupported("range index");
    }
    let current: LingoValue = receiver;
    for (const index of indices) {
      current = this.getIndexSingle(current, index);
    }
    return current;
  }

  private getIndexSingle(receiver: LingoValue, index: LingoValue): LingoValue {
    if (receiver instanceof LingoList) {
      return receiver.getAt(toIndex(index));
    }
    if (receiver instanceof LingoPropList) {
      if (typeof index === "number" || index instanceof LingoFloat) {
        return receiver.getAt(toIndex(index));
      }
      if (this.exactKeyPropLists.has(receiver)) {
        const pos = receiver.findPos(index, ops.lingoKeyEquals);
        return pos instanceof LingoVoid ? LINGO_VOID : receiver.getAt(pos);
      }
      // Director reads exact keys first, then allows compatible string/symbol
      // keys. This keeps exact string window ids distinct from symbol thread
      // ids while preserving source-local patterns like p[#top_up] vs
      // p["top_up"] in Scrollbar Class.
      return this.propListGetAProp(receiver, index);
    }
    if (typeof receiver === "string") {
      return this.chunk("char", index, null, receiver);
    }
    if (receiver instanceof ScriptInstance) {
      // instance[#prop] reads the property (VOID when missing).
      const key = index instanceof LingoSymbol ? index.name : ops.stringOf(index);
      return receiver.props.get(key.toLowerCase()) ?? LINGO_VOID;
    }
    if (receiver instanceof LingoRect) {
      // rect[1..4] = left, top, right, bottom.
      switch (toIndex(index)) {
        case 1:
          return receiver.left;
        case 2:
          return receiver.top;
        case 3:
          return receiver.right;
        case 4:
          return receiver.bottom;
        default:
          return LINGO_VOID;
      }
    }
    if (receiver instanceof LingoPoint) {
      switch (toIndex(index)) {
        case 1:
          return receiver.x;
        case 2:
          return receiver.y;
        default:
          return LINGO_VOID;
      }
    }
    return this.unsupported(`index into ${describeValue(receiver)}`);
  }

  setIndex(
    receiver: LingoValue,
    indices: LingoValue[],
    rangeEnd: LingoValue | null,
    value: LingoValue,
  ): void {
    if (rangeEnd !== null) {
      this.unsupported("range index assignment");
    }
    let target: LingoValue = receiver;
    for (let i = 0; i < indices.length - 1; i += 1) {
      target = this.getIndexSingle(target, indices[i]!);
    }
    const last = indices[indices.length - 1]!;
    if (target instanceof LingoList) {
      target.setAt(toIndex(last), value);
      return;
    }
    if (target instanceof LingoPropList) {
      if (typeof last === "number" || last instanceof LingoFloat) {
        target.setAt(toIndex(last), value);
      } else {
        target.setaProp(last, value, ops.lingoKeyEquals);
      }
      return;
    }
    if (target instanceof ScriptInstance) {
      // instance[#prop] = value sets the property (Object Manager create
      // does `tObject[#ancestor] = tTemp`).
      const key = last instanceof LingoSymbol ? last.name : ops.stringOf(last);
      if (
        key.toLowerCase() === "ancestor" &&
        value instanceof LingoVoid &&
        target.props.get("ancestor") instanceof ScriptInstance
      ) {
        // Thread Manager pre-links Object Base to Thread Instance, then the
        // generic first loop pass writes `tObject[#ancestor] = VOID`. Keeping
        // the bridge is required for component.getInterface()/getComponent().
        return;
      }
      target.props.set(key.toLowerCase(), value);
      return;
    }
    if (target instanceof LingoRect) {
      // rect[1..4] = left, top, right, bottom.
      const n = toIndex(last);
      const v = toNumber(value);
      if (n === 1) target.left = v;
      else if (n === 2) target.top = v;
      else if (n === 3) target.right = v;
      else if (n === 4) target.bottom = v;
      return;
    }
    if (target instanceof LingoPoint) {
      const n = toIndex(last);
      const v = toNumber(value);
      if (n === 1) target.x = v;
      else if (n === 2) target.y = v;
      return;
    }
    this.unsupported(`index assignment into ${describeValue(target)}`);
  }

  // -- the-properties ---------------------------------------------------------

  theProp(property: string): LingoValue {
    property = property.toLowerCase();
    switch (property) {
      case "itemdelimiter":
        return this.itemDelimiter;
      case "floatprecision":
        return ops.getFloatPrecision();
      case "randomseed":
        return this.randomState;
      case "maxinteger":
        return 2147483647;
      case "paramcount":
        return this.paramFrames[this.paramFrames.length - 1]?.length ?? 0;
      case "tracescript":
      case "trace":
        return 0;
      case "tracelogfile":
        return "";
      case "milliseconds":
        return Math.floor(nowMs());
      case "ticks":
        return Math.floor((nowMs() / 1000) * 60);
      case "timer":
        return Math.max(0, Math.floor(((nowMs() - this.timerStartMs) / 1000) * 60));
      case "result":
        return this.resultRegister;
      default: {
        const hostResult = this.host.theProp?.(property);
        if (hostResult !== undefined) {
          return hostResult;
        }
        return this.unsupported(`the ${property}`);
      }
    }
  }

  setTheProp(property: string, value: LingoValue): void {
    property = property.toLowerCase();
    switch (property) {
      case "itemdelimiter":
        this.itemDelimiter = ops.stringOf(value);
        return;
      case "floatprecision":
        ops.setFloatPrecision(toIndex(value));
        return;
      case "randomseed":
        this.randomState = toIndex(value) || 1;
        return;
      case "tracescript":
      case "trace":
      case "tracelogfile":
        // Debug-output switches; accepted and ignored at runtime.
        return;
      default:
        if (this.host.setTheProp?.(property, value)) {
          return;
        }
        this.unsupported(`set the ${property}`);
    }
  }

  theOf(property: string, object: LingoValue): LingoValue {
    if (object instanceof ScriptInstance) {
      return this.getProp(object, property);
    }
    if (object instanceof LingoList || object instanceof LingoPropList) {
      if (property === "count") return object.count();
      if (property === "last") return object.getLast();
    }
    if (typeof object === "string" && property === "length") {
      return object.length;
    }
    const hostResult = this.host.theOf?.(property, object);
    if (hostResult !== undefined) {
      return hostResult;
    }
    return this.unsupported(`the ${property} of ...`);
  }

  setTheOf(property: string, object: LingoValue, value: LingoValue): void {
    if (object instanceof ScriptInstance) {
      this.setProp(object, property, value);
      return;
    }
    if (this.host.setTheOf?.(property, object, value)) {
      return;
    }
    this.unsupported(`set the ${property} of ...`);
  }

  objectRef(refType: string, id: LingoValue, castLib: LingoValue | null): LingoValue {
    if (refType === "script") {
      const ref = this.findScript(ops.stringOf(id));
      if (ref) return ref;
    }
    const hostResult = this.host.objectRef?.(refType, id, castLib);
    if (hostResult !== undefined) {
      return hostResult;
    }
    return this.unsupported(`${refType} reference`);
  }

  // -- globals / instance props ----------------------------------------------

  getGlobal(name: string): LingoValue {
    return this.globals.get(name.toLowerCase()) ?? LINGO_VOID;
  }

  setGlobal(name: string, value: LingoValue): void {
    this.globals.set(name.toLowerCase(), value);
  }

  getInstanceProp(me: LingoValue, name: string): LingoValue {
    if (me instanceof ScriptInstance) {
      const key = name.toLowerCase();
      const scope = this.handlerPropertyScopes[this.handlerPropertyScopes.length - 1];
      if (scope?.props.has(key) && this.instanceHasAncestor(me, scope)) {
        return scope.props.get(key)!;
      }
      return this.getProp(me, name);
    }
    return this.unsupported(`property ${name} outside instance`);
  }

  setInstanceProp(me: LingoValue, name: string, value: LingoValue): void {
    if (me instanceof ScriptInstance) {
      const key = name.toLowerCase();
      const scope = this.handlerPropertyScopes[this.handlerPropertyScopes.length - 1];
      if (scope?.props.has(key) && this.instanceHasAncestor(me, scope)) {
        scope.props.set(key, value);
        this.trackExactKeyPropList(scope, key, value);
        return;
      }
      this.setProp(me, name, value);
      return;
    }
    this.unsupported(`set property ${name} outside instance`);
  }

  private instanceHasAncestor(instance: ScriptInstance, wanted: ScriptInstance): boolean {
    let target: ScriptInstance | null = instance;
    while (target) {
      if (target === wanted) return true;
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : null;
    }
    return false;
  }

  private instanceHasScript(instance: ScriptInstance, scriptName: string): boolean {
    const wanted = scriptName.toLowerCase();
    let target: ScriptInstance | null = instance;
    while (target) {
      if (target.module.scriptName.toLowerCase() === wanted) {
        return true;
      }
      const ancestor = target.props.get("ancestor");
      target = ancestor instanceof ScriptInstance ? ancestor : null;
    }
    return false;
  }

  private trackExactKeyPropList(owner: ScriptInstance, key: string, value: LingoValue): void {
    if (
      owner.module.scriptName === "Object Manager Class" &&
      key === "pobjectlist" &&
      value instanceof LingoPropList
    ) {
      this.exactKeyPropLists.add(value);
    }
  }

  // -- put / chunks ------------------------------------------------------------

  put(values: LingoValue[]): void {
    const text = values.map((value) => ops.displayString(value)).join(" ");
    if (this.host.put) {
      this.host.put(text);
    } else {
      console.log(`-- ${text}`);
    }
  }

  putInto(): void {
    this.unsupported("put into member/field target");
  }

  /** Chunk pieces as [start, end) spans over the source text. Ranges return
   * the original substring spanning the pieces (Director preserves internal
   * whitespace/delimiters; the `s.word[1..s.word.count]` idiom in
   * convertToPropList trims only outer whitespace). */
  private chunkRanges(text: string, chunkType: string): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];
    switch (chunkType) {
      case "char":
        for (let i = 0; i < text.length; i += 1) ranges.push({ start: i, end: i + 1 });
        return ranges;
      case "word": {
        let index = 0;
        while (index < text.length) {
          while (index < text.length && /\s/.test(text[index]!)) index += 1;
          if (index >= text.length) break;
          const start = index;
          while (index < text.length && !/\s/.test(text[index]!)) index += 1;
          ranges.push({ start, end: index });
        }
        return ranges;
      }
      case "item": {
        const delim = this.itemDelimiter || ",";
        let start = 0;
        for (;;) {
          const pos = text.indexOf(delim, start);
          if (pos === -1) {
            ranges.push({ start, end: text.length });
            return ranges;
          }
          ranges.push({ start, end: pos });
          start = pos + delim.length;
        }
      }
      case "line": {
        // Shockwave server text can use CR followed by char(2), or a bare
        // char(2), as a record boundary inside one packet body. Catalogue
        // rows also carry char(2) immediately before a tab inside the
        // currency field; release source expects that embedded marker to
        // remain in the same line so integer("-1" & char(2)) can coerce it.
        const re = /\r\x02|\r\n|\r|\n|\x02(?!\t)/g;
        let start = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          ranges.push({ start, end: match.index });
          start = match.index + match[0].length;
        }
        ranges.push({ start, end: text.length });
        return ranges;
      }
      default:
        return this.unsupported(`chunk type ${chunkType}`);
    }
  }

  chunk(
    chunkType: string,
    start: LingoValue,
    end: LingoValue | null,
    source: LingoValue,
  ): LingoValue {
    return this.chunkSelection(chunkType, start, end, source).text;
  }

  private chunkSelection(
    chunkType: string,
    start: LingoValue,
    end: LingoValue | null,
    source: LingoValue,
  ): { text: string; start: number; end: number } {
    const text = ops.stringOf(source);
    if (chunkType === "char") {
      return this.charChunkSelection(text, start, end);
    }
    const ranges = this.chunkRanges(text, chunkType);
    const from = toIndex(start);
    const to = end === null ? from : toIndex(end);
    if (end !== null && to < from) {
      const insertionStart =
        from >= 1 && from <= ranges.length
          ? ranges[from - 1]!.start + 1
          : Math.max(1, text.length + 1);
      return { text: "", start: insertionStart, end: insertionStart - 1 };
    }
    if (from < 1 || ranges.length === 0 || from > ranges.length) {
      return { text: "", start: 1, end: 0 };
    }
    const clampedTo = Math.min(Math.max(to, from), ranges.length);
    const first = ranges[from - 1]!;
    const last = ranges[clampedTo - 1]!;
    return {
      text: text.slice(first.start, last.end),
      start: first.start + 1,
      end: last.end,
    };
  }

  chunkCount(source: LingoValue, chunkType: string): number {
    const text = ops.stringOf(source);
    if (chunkType === "char") return text.length;
    return this.chunkRanges(text, chunkType).length;
  }

  private charChunkSelection(
    text: string,
    start: LingoValue,
    end: LingoValue | null,
  ): { text: string; start: number; end: number } {
    const from = toIndex(start);
    const to = end === null ? from : toIndex(end);
    const length = text.length;
    if (end !== null && to < from) {
      const insertionStart = from >= 1 && from <= length ? from : Math.max(1, length + 1);
      return { text: "", start: insertionStart, end: insertionStart - 1 };
    }
    if (from < 1 || length === 0 || from > length) {
      return { text: "", start: 1, end: 0 };
    }
    const clampedTo = Math.min(Math.max(to, from), length);
    return {
      text: text.slice(from - 1, clampedTo),
      start: from,
      end: clampedTo,
    };
  }

  countOf(chunkType: string, source: LingoValue | null): LingoValue {
    if (source === null) {
      const hostResult = this.host.theProp?.(`number_of_${chunkType}s`);
      if (hostResult !== undefined) return hostResult;
      return this.unsupported(`the number of ${chunkType}s`);
    }
    if (chunkType === "member" || chunkType === "castlib" || chunkType === "sprite") {
      const hostResult = this.host.theOf?.(`number_of_${chunkType}s`, source);
      if (hostResult !== undefined) return hostResult;
      return this.unsupported(`the number of ${chunkType}s`);
    }
    return this.chunkCount(source, chunkType);
  }

  lastChunk(chunkType: string, source: LingoValue): LingoValue {
    const text = ops.stringOf(source);
    const ranges = this.chunkRanges(text, chunkType);
    if (ranges.length === 0) return "";
    const last = ranges[ranges.length - 1]!;
    return text.slice(last.start, last.end);
  }

  /** Deletes a chunk from a string and returns the new string. Negative
   * start positions address from the end; release306 hex2int relies on
   * `delete char -30000 of s` removing the last character (verified against
   * the bytecode and the algorithm's required behavior). Deleting a word/
   * item/line also removes one adjacent separator, like Director. */
  deleteChunk(source: string, chunkType: string, start: number, end: number | null): string {
    const ranges = this.chunkRanges(source, chunkType);
    let from = start;
    if (from < 0) {
      from = ranges.length + 1 + from;
      if (from < 1) from = ranges.length; // clamp from-the-end overshoot to last
    }
    let to = end === null ? from : end;
    if (to < 0) {
      to = ranges.length + 1 + to;
    }
    if (ranges.length === 0 || from < 1 || from > ranges.length) {
      return source;
    }
    to = Math.min(Math.max(to, from), ranges.length);
    let cutStart = ranges[from - 1]!.start;
    let cutEnd = ranges[to - 1]!.end;
    if (chunkType !== "char") {
      if (to < ranges.length) {
        cutEnd = ranges[to]!.start; // take the following separator
      } else if (from > 1) {
        cutStart = ranges[from - 2]!.end; // or the preceding one
      }
    }
    return source.slice(0, cutStart) + source.slice(cutEnd);
  }

  /** Replaces or inserts next to a selected chunk and returns the new string.
   * This backs `put x into s.char[i]` and the verbal `put x into char i of s`
   * forms used by release306 layout and room-map code. */
  replaceChunk(
    source: string,
    chunkType: string,
    start: number,
    end: number | null,
    value: LingoValue,
    mode: "into" | "after" | "before",
  ): string {
    const text = ops.stringOf(value);
    const ranges = this.chunkRanges(source, chunkType);
    let from = start;
    if (from < 0) from = ranges.length + 1 + from;
    let to = end === null ? from : end;
    if (to < 0) to = ranges.length + 1 + to;
    if (ranges.length === 0 || from < 1 || from > ranges.length) {
      if (mode === "before") return text + source;
      if (mode === "after") return source + text;
      return source;
    }
    to = Math.min(Math.max(to, from), ranges.length);
    const first = ranges[from - 1]!;
    const last = ranges[to - 1]!;
    if (mode === "before") {
      return source.slice(0, first.start) + text + source.slice(first.start);
    }
    if (mode === "after") {
      return source.slice(0, last.end) + text + source.slice(last.end);
    }
    return source.slice(0, first.start) + text + source.slice(last.end);
  }

  listCount(list: LingoValue): number {
    if (list instanceof LingoList || list instanceof LingoPropList) {
      return list.count();
    }
    if (list instanceof LingoVoid) {
      return 0;
    }
    return this.unsupported("repeat with..in over non-list");
  }

  /** Tags an escaping error with the Lingo call stack once, at throw depth. */
  private withStack(error: unknown): unknown {
    if (error instanceof DirectorPassSignal) return error;
    if (error instanceof Error && !error.message.includes("[in ")) {
      error.message += ` [in ${this.callStack.slice(-5).join(" > ")}]`;
    }
    return error;
  }

  private callTargets(handlerName: string, targets: LingoValue[], args: LingoValue[]): LingoValue {
    const method = handlerName.toLowerCase();
    let result: LingoValue = LINGO_VOID;
    for (const target of targets) {
      const resolvedTarget = this.resolveManagerCallTarget(target);
      if (resolvedTarget instanceof MissingScriptInstance || resolvedTarget instanceof MissingScriptRef) {
        continue;
      }

      if (resolvedTarget instanceof ScriptInstance) {
        if (!this.hasHandler(resolvedTarget, method)) {
          continue;
        }
        try {
          result = this.callMethod(resolvedTarget, method, args);
        } catch (error) {
          this.reportCallTargetError(handlerName, error);
        }
        continue;
      }

      if (!isLingoObject(resolvedTarget)) {
        continue;
      }

      try {
        const hostMethodResult = this.host.callMethod?.(resolvedTarget, method, args);
        if (hostMethodResult !== undefined) {
          result = hostMethodResult;
        }
      } catch (error) {
        this.reportCallTargetError(handlerName, error);
      }
    }
    return result;
  }

  private resolveManagerCallTarget(target: LingoValue): LingoValue {
    if (typeof target !== "string" && !(target instanceof LingoSymbol)) {
      return target;
    }
    const manager = this.handlerPropertyScopes[this.handlerPropertyScopes.length - 1];
    if (!(manager instanceof ScriptInstance) || !this.instanceHasScript(manager, "Manager Template Class")) {
      return target;
    }
    if (!this.managerItemListContains(manager, target) || !this.hasHandler(manager, "get")) {
      return target;
    }

    try {
      const resolved = this.callMethod(manager, "get", [target]);
      return resolved instanceof LingoVoid || resolved === 0 ? target : resolved;
    } catch (error) {
      this.reportCallTargetError("call target resolution", error);
      return target;
    }
  }

  private managerItemListContains(manager: ScriptInstance, id: LingoValue): boolean {
    const itemList = this.getProp(manager, "pitemlist");
    if (itemList instanceof LingoList) {
      return itemList.items.some((item) => ops.lingoKeyEquals(item, id) || ops.lingoEquals(item, id));
    }
    if (itemList instanceof LingoPropList) {
      return itemList.keys.some((item) => ops.lingoKeyEquals(item, id) || ops.lingoEquals(item, id));
    }
    return false;
  }

  private reportCallTargetError(handlerName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UnsupportedFeatureError) {
      if (this.recordUnsupportedSeen(message)) {
        this.host.put?.(`script error in #${handlerName}: ${message}`);
      }
      return;
    }

    if (!this.rememberCallTargetError(message)) {
      return;
    }
    this.host.put?.(`script error in #${handlerName}: ${message}`);
  }

  private rememberCallTargetError(message: string): boolean {
    if (this.callTargetErrorKeys.has(message)) return false;
    if (this.callTargetErrorKeys.size >= Runtime.MAX_DIAGNOSTIC_DEDUPE_KEYS - 1) {
      const notice = `[call target errors truncated at ${Runtime.MAX_DIAGNOSTIC_DEDUPE_KEYS} unique entries]`;
      if (!this.callTargetErrorKeys.has(notice)) {
        this.callTargetErrorKeys.add(notice);
        this.host.put?.(notice);
      }
      return false;
    }
    this.callTargetErrorKeys.add(message);
    return true;
  }

  unsupported(feature: string): never {
    const where = this.callStack.slice(-4).join(" > ");
    const detail = where ? `${feature} [in ${where}]` : feature;
    this.recordUnsupportedSeen(detail);
    throw new UnsupportedFeatureError(detail);
  }

  unsupportedDiagnostics(): UnsupportedDiagnostics {
    return {
      entries: [...this.unsupportedSeen],
      count: this.unsupportedSeen.length,
      cap: Runtime.MAX_UNSUPPORTED_SEEN,
      truncated: this.unsupportedSeenTruncated,
      callStack: [...this.callStack],
    };
  }

  clearUnsupportedDiagnostics(): void {
    this.unsupportedSeen.length = 0;
    this.unsupportedSeenKeys.clear();
    this.unsupportedSeenTruncated = false;
  }

  private recordUnsupportedSeen(detail: string): boolean {
    if (this.unsupportedSeenKeys.has(detail)) return false;
    if (this.unsupportedSeenKeys.size >= Runtime.MAX_UNSUPPORTED_SEEN - 1) {
      if (!this.unsupportedSeenTruncated) {
        const notice = `[unsupportedSeen truncated at ${Runtime.MAX_UNSUPPORTED_SEEN} unique entries]`;
        this.unsupportedSeenKeys.add(notice);
        this.unsupportedSeen.push(notice);
        this.unsupportedSeenTruncated = true;
      }
      return false;
    }
    this.unsupportedSeenKeys.add(detail);
    this.unsupportedSeen.push(detail);
    return true;
  }

  // -- instances ---------------------------------------------------------------

  instantiate(module: GeneratedScriptModule, args: LingoValue[]): LingoValue {
    const instance = new ScriptInstance(module);
    const constructor = module.handlers["new"];
    if (constructor) {
      return constructor(this, instance, [instance, ...args]);
    }
    return instance;
  }

  // -- builtins ------------------------------------------------------------------

  /** Pure builtins; returns undefined when the name is not handled here. */
  private builtin(name: string, args: LingoValue[]): LingoValue | undefined {
    const a = (index: number): LingoValue => args[index] ?? LINGO_VOID;
    switch (name) {
      case "voidp":
        return a(0) instanceof LingoVoid ? 1 : 0;
      case "listp":
        return a(0) instanceof LingoList || a(0) instanceof LingoPropList ? 1 : 0;
      case "stringp":
        return typeof a(0) === "string" ? 1 : 0;
      case "integerp":
        return typeof a(0) === "number" ? 1 : 0;
      case "floatp":
        return a(0) instanceof LingoFloat ? 1 : 0;
      case "symbolp":
        return a(0) instanceof LingoSymbol ? 1 : 0;
      case "objectp": {
        const value = a(0);
        return this.objectP(value) ? 1 : 0;
      }
      case "getpref": {
        const key = this.normalizePreferenceKey(a(0));
        if (!key) return LINGO_VOID;
        return this.readPreference(key) ?? LINGO_VOID;
      }
      case "setpref": {
        const key = this.normalizePreferenceKey(a(0));
        if (!key) return 0;
        this.writePreference(key, ops.stringOf(a(1)));
        return 1;
      }
      case "starttimer":
        this.timerStartMs = nowMs();
        return LINGO_VOID;
      case "outputlist": {
        this.host.put?.(ops.displayString(a(0)));
        return LINGO_VOID;
      }
      case "ilk": {
        const value = a(0);
        const kind = ilkOf(value);
        if (args.length >= 2) {
          const wanted = a(1);
          return wanted instanceof LingoSymbol &&
            (wanted.name.toLowerCase() === kind ||
              (kind === "proplist" && wanted.name.toLowerCase() === "list"))
            ? 1
            : 0;
        }
        return LingoSymbol.for(kind === "proplist" ? "propList" : kind);
      }
      case "string":
        return ops.stringOf(a(0));
      case "integer": {
        const value = a(0);
        if (typeof value === "number") return value;
        if (value instanceof LingoFloat) return Math.round(value.value);
        if (typeof value === "string") {
          return integerOfString(value);
        }
        // Director: integer(sprite n) yields the channel number. The
        // Visualizer wrapper wiring relies on it (setProperty(#sprite, tSpr)
        // -> sprite(integer(tValue))).
        const spriteLike = value as { lingoType?: string; number?: number };
        if (spriteLike && spriteLike.lingoType === "sprite" && typeof spriteLike.number === "number") {
          return spriteLike.number;
        }
        return LINGO_VOID;
      }
      case "float": {
        const value = a(0);
        if (typeof value === "number") return float(value);
        if (value instanceof LingoFloat) return value;
        if (typeof value === "string") {
          const parsed = floatOfString(value);
          return parsed === undefined ? LINGO_VOID : float(parsed);
        }
        return LINGO_VOID;
      }
      case "value":
        return lingoValueOfString(a(0));
      case "length":
        return ops.stringOf(a(0)).length;
      case "offset": {
        // offset(needle, haystack), case-insensitive, 0 when absent.
        const needle = ops.stringOf(a(0)).toLowerCase();
        const haystack = ops.stringOf(a(1)).toLowerCase();
        if (needle === "") return 0;
        return haystack.indexOf(needle) + 1;
      }
      case "chars": {
        const text = ops.stringOf(a(0));
        const from = toIndex(a(1));
        const to = toIndex(a(2));
        if (from < 1 || from > text.length || to < from) return "";
        return text.slice(from - 1, Math.min(to, text.length));
      }
      case "numtochar":
        return directorNumToChar(toIndex(a(0)));
      case "chartonum": {
        const text = ops.stringOf(a(0));
        return directorCharToNum(text);
      }
      case "abs": {
        const value = a(0);
        if (value instanceof LingoFloat) return float(Math.abs(value.value));
        return Math.abs(toIndex(value));
      }
      case "sin":
        return float(Math.sin(toNumber(a(0))));
      case "cos":
        return float(Math.cos(toNumber(a(0))));
      case "tan":
        return float(Math.tan(toNumber(a(0))));
      case "atan":
        return float(Math.atan(toNumber(a(0))));
      case "power":
        return float(Math.pow(toNumber(a(0)), toNumber(a(1))));
      case "max":
        return listAwareExtrema(args, (value, best) => ops.compareValues(value, best) > 0);
      case "min":
        return listAwareExtrema(args, (value, best) => ops.compareValues(value, best) < 0);
      case "random": {
        // Lingo LCG-style deterministic random, 1..n.
        const n = toIndex(a(0));
        if (n <= 0) return 1;
        this.randomState = (Math.imul(this.randomState, 1103515245) + 12345) & 0x7fffffff;
        return (this.randomState % n) + 1;
      }
      case "bitand":
        return (toIndex(a(0)) & toIndex(a(1))) | 0;
      case "bitor":
        return (toIndex(a(0)) | toIndex(a(1))) | 0;
      case "bitxor":
        return (toIndex(a(0)) ^ toIndex(a(1))) | 0;
      case "bitnot":
        return ~toIndex(a(0)) | 0;
      case "count":
        return this.callMethod(a(0), "count", []);
      case "symbol":
        return LingoSymbol.for(ops.stringOf(a(0)));
      case "list":
        return new LingoList([...args]);
      case "duplicate":
        return duplicateValue(a(0));
      case "createmask": {
        const source = a(0);
        return source instanceof LingoImage ? source.createMask() : LINGO_VOID;
      }
      case "creatematte": {
        const source = a(0);
        return source instanceof LingoImage ? source.createMatte() : LINGO_VOID;
      }
      case "union": {
        const left = a(0);
        const right = a(1);
        return left instanceof LingoRect && right instanceof LingoRect
          ? rectUnion(left, right)
          : this.unsupported(`union(${args.length} args)`);
      }
      case "intersect": {
        const left = a(0);
        const right = a(1);
        return left instanceof LingoRect && right instanceof LingoRect
          ? rectIntersection(left, right)
          : this.unsupported(`intersect(${args.length} args)`);
      }
      case "new": {
        const ref = a(0);
        if (ref instanceof LingoVoid) {
          return LINGO_VOID;
        }
        if (ref instanceof ScriptRef) {
          return this.instantiate(ref.module, args.slice(1));
        }
        if (ref instanceof MissingScriptRef) {
          return new MissingScriptInstance(ref);
        }
        if (ref instanceof XmlParserXtraRef) {
          return new XmlParserInstance();
        }
        const hostResult = this.host.call?.("new", args);
        if (hostResult !== undefined) return hostResult;
        if (ref instanceof LingoSymbol) {
          // new(#field, castLib n): member creation, host-resolved.
          const memberResult = this.host.call?.("newmember", args);
          if (memberResult !== undefined) return memberResult;
        }
        return undefined;
      }
      case "script": {
        // Director resolves script members only in LOADED casts; the host
        // checks the member registry first (load-order faithful). Falling
        // back to the global module table only when no host exists (tests).
        const hostResult = this.host.call?.("script", args);
        if (hostResult !== undefined) return hostResult;
        if (!this.host.call) {
          const byName = typeof a(0) === "string" ? this.findScript(a(0) as string) : null;
          if (byName) return byName;
        }
        return this.unsupported(`script ${ops.stringOf(a(0))}`);
      }
      case "call": {
        // call(#handler, target, args...) - target may be one object or a
        // list of objects. Director sends the message to script instances and
        // host objects such as sprites; objects without the handler are
        // skipped.
        const handlerName = a(0) instanceof LingoSymbol ? (a(0) as LingoSymbol).name : ops.stringOf(a(0));
        const target = a(1);
        const callArgs = args.slice(2);
        if (target instanceof LingoList || target instanceof LingoPropList) {
          return this.callTargets(handlerName, target instanceof LingoList ? [...target.items] : [...target.values], callArgs);
        }
        return this.callTargets(handlerName, [target], callArgs);
      }
      case "callancestor": {
        // callAncestor(#h, [me], ...): handler lookup starts at the ancestor,
        // but `me` and the explicit positional params stay source-visible.
        const handlerName = (
          a(0) instanceof LingoSymbol ? (a(0) as LingoSymbol).name : ops.stringOf(a(0))
        ).toLowerCase();
        const targetArg = a(1);
        const callTargets =
          targetArg instanceof LingoList
            ? targetArg.items
            : targetArg instanceof LingoPropList
              ? targetArg.values
              : [targetArg];
        const target = callTargets.find((value) => value instanceof ScriptInstance);
        const handlerArgs =
          targetArg instanceof LingoList
            ? [...targetArg.items, ...args.slice(2)]
            : targetArg instanceof LingoPropList
              ? [...targetArg.values, ...args.slice(2)]
              : args.slice(1);
        if (target instanceof ScriptInstance) {
          const currentScope = this.handlerPropertyScopes[this.handlerPropertyScopes.length - 1];
          const searchBase =
            currentScope instanceof ScriptInstance && this.instanceHasAncestor(target, currentScope)
              ? currentScope
              : target;
          let search = searchBase.props.get("ancestor");
          while (search instanceof ScriptInstance) {
            const handler = search.module.handlers[handlerName];
            if (handler) {
              if (this.traceHandlers.has(handlerName) || this.traceHandlers.has("callancestor")) {
                const label = this.handlerLabel(search.module, handlerName);
                this.traceSink(
                  `TRACE ${label} via callAncestor(${handlerArgs.map((value) => ops.displayString(value)).join(", ")}) [from ${this.callStack.slice(-3).join(" > ")}]`,
                );
              }
              this.callStack.push(this.handlerLabel(search.module, handlerName));
              this.paramFrames.push(handlerArgs);
              this.handlerPropertyScopes.push(search);
              try {
                return handler(this, target, handlerArgs);
              } catch (error) {
                throw this.withStack(error);
              } finally {
                this.handlerPropertyScopes.pop();
                this.callStack.pop();
                this.paramFrames.pop();
              }
            }
            search = search.props.get("ancestor");
          }
        }
        return LINGO_VOID;
      }
      case "param": {
        const frame = this.paramFrames[this.paramFrames.length - 1] ?? [];
        return frame[toIndex(a(0)) - 1] ?? LINGO_VOID;
      }
      // Command forms of list/object accessors: `setaProp tList, #k, v`
      // dispatches like tList.setaProp(#k, v).
      case "setaprop":
      case "addprop":
      case "getaprop":
      case "getprop":
      case "setprop":
      case "deleteprop":
      case "findpos":
      case "getpropat":
      case "getat":
      case "setat":
      case "add":
      case "append":
      case "addat":
      case "deleteat":
      case "deleteone":
      case "getpos":
      case "getone":
      case "getlast":
      case "sort": {
        const receiver = a(0);
        if (
          receiver instanceof LingoList ||
          receiver instanceof LingoPropList ||
          receiver instanceof ScriptInstance
        ) {
          return this.callMethod(receiver, name, args.slice(1));
        }
        return undefined;
      }
      case "rgb": {
        // rgb(r,g,b) or rgb("#RRGGBB").
        if (args.length === 1 && typeof a(0) === "string") {
          const hex = (a(0) as string).replace(/^#/, "");
          const value = Number.parseInt(hex, 16);
          return new LingoColor((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
        }
        return new LingoColor(toIndex(a(0)) & 0xff, toIndex(a(1)) & 0xff, toIndex(a(2)) & 0xff);
      }
      case "paletteindex":
        return directorPaletteIndex(a(0));
      case "color": {
        const type = args[0];
        if (type instanceof LingoSymbol) {
          const colorType = type.name.toLowerCase();
          if (colorType === "paletteindex") {
            return directorPaletteIndex(a(1));
          }
          if (colorType === "rgb") {
            return new LingoColor(toIndex(a(1)) & 0xff, toIndex(a(2)) & 0xff, toIndex(a(3)) & 0xff);
          }
        }
        if (args.length >= 3) {
          return new LingoColor(toIndex(a(0)) & 0xff, toIndex(a(1)) & 0xff, toIndex(a(2)) & 0xff);
        }
        return directorPaletteIndex(a(0));
      }
      case "image": {
        // image(width, height [, depth [, paletteRef]]).
        const width = toIndex(a(0));
        const height = toIndex(a(1));
        const depth = args.length >= 3 ? toIndex(a(2)) : 32;
        const paletteRef = args.length >= 4 ? a(3) : LingoSymbol.for("systemMac");
        return new LingoImage(width, height, depth, paletteRef);
      }
      case "point":
        return new LingoPoint(toNumber(a(0)), toNumber(a(1)));
      case "rect": {
        if (args.length === 2 && a(0) instanceof LingoPoint && a(1) instanceof LingoPoint) {
          const p1 = a(0) as LingoPoint;
          const p2 = a(1) as LingoPoint;
          return new LingoRect(p1.x, p1.y, p2.x, p2.y);
        }
        return new LingoRect(toNumber(a(0)), toNumber(a(1)), toNumber(a(2)), toNumber(a(3)));
      }
      case "_movie":
      case "_player":
      case "_system":
      case "_sound":
        return this.globals.get(name);
      case "void":
        return LINGO_VOID;
      case "nothing":
        return LINGO_VOID;
      case "pass":
        if (this.activeDirectorEvent()) throw new DirectorPassSignal();
        return LINGO_VOID;
      case "stopevent":
      case "dontpassevent": {
        const event = this.activeDirectorEvent();
        if (event) event.stopped = true;
        return LINGO_VOID;
      }
      case "xtra": {
        const requestedName = ops.stringOf(a(0)).trim();
        const registration = directorXtraRegistration(requestedName);
        if (registration?.provider === "runtime" && registration.name.toLowerCase() === "xmlparser") {
          return new XmlParserXtraRef();
        }
        const hostResult = this.host.call?.("xtra", args);
        if (hostResult !== undefined) return hostResult;
        if (registration?.status === "implemented") {
          return this.unsupported(`xtra ${requestedName} is registered as implemented but its ${registration.provider} provider is unavailable`);
        }
        if (registration?.status === "fatal") {
          return this.unsupported(`xtra ${requestedName} is unavailable by policy: ${registration.detail}`);
        }
        return this.unavailableXtra(requestedName, registration);
      }
      case "not":
        return ops.not(a(0));
      default:
        return undefined;
    }
  }

  private normalizePreferenceKey(value: LingoValue): string {
    if (value instanceof LingoVoid) return "";
    return ops.stringOf(value).toLowerCase();
  }

  private unavailableXtra(name: string, registration: DirectorXtraRegistration | null): LingoValue {
    const where = this.callStack.slice(-4).join(" > ");
    const status = registration ? `${registration.status}: ${registration.detail}` : "not registered";
    const detail = `xtra ${name || "<empty>"} unavailable (${status})${where ? ` [in ${where}]` : ""}`;
    this.recordUnsupportedSeen(detail);
    return LINGO_VOID;
  }

  private readPreference(key: string): string | undefined {
    const cached = this.preferences.get(key);
    if (cached !== undefined) return cached;
    const storage = runtimeLocalStorage();
    if (!storage) return undefined;
    const stored = storage.getItem(`${Runtime.PREF_STORAGE_PREFIX}${key}`);
    if (stored === null) return undefined;
    this.preferences.set(key, stored);
    return stored;
  }

  private writePreference(key: string, value: string): void {
    this.preferences.set(key, value);
    const storage = runtimeLocalStorage();
    if (!storage) return;
    storage.setItem(`${Runtime.PREF_STORAGE_PREFIX}${key}`, value);
  }
}

/** Director's integer(string): collect digits, `-` only leading, `.` fails,
 * leading C0 packet separators are ignored, and junk after a valid digit is
 * ignored (release306 System Props carries a stray  after
 * "tooltip.active = 0" in the original .cst; room wall-item packets can carry
 * char(2) before the second item id). Behavior cross-checked with dirplayer
 * for trailing junk; the control-prefix case is release306 packet evidence.
 */
function integerOfString(input: string): LingoValue {
  if (input === "") return LINGO_VOID;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "-") return 0;
  let digits = "";
  let foundDigit = false;
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if (ch >= "0" && ch <= "9") {
      digits += ch;
      foundDigit = true;
    } else if (ch === ".") {
      return LINGO_VOID;
    } else if (ch === "-") {
      if (digits !== "") return LINGO_VOID;
      digits = "-";
    } else if (!foundDigit && digits === "" && code >= 0 && code < 32) {
      continue;
    } else if (!foundDigit) {
      return LINGO_VOID;
    }
  }
  if (!foundDigit) return LINGO_VOID;
  const parsed = Number.parseInt(digits, 10);
  return Number.isNaN(parsed) ? LINGO_VOID : parsed;
}

function floatOfString(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(trimmed);
  if (!match) return undefined;
  const trailing = trimmed.slice(match[0].length);
  for (const ch of trailing) {
    const code = ch.charCodeAt(0);
    if (code > 32 && code !== 127) return undefined;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runtimeLocalStorage():
  | { getItem(key: string): string | null; setItem(key: string, value: string): void }
  | undefined {
  const globalWithStorage = globalThis as typeof globalThis & {
    localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  };
  return globalWithStorage.localStorage;
}

function describeValue(value: LingoValue): string {
  if (value instanceof LingoVoid) return "<void>";
  if (typeof value === "object" && value !== null && "lingoType" in value) {
    return `<${(value as { lingoType: string }).lingoType}>`;
  }
  return `<${typeof value}>`;
}

function isPrimitiveMethodReceiver(value: LingoValue): boolean {
  return (
    value instanceof LingoVoid ||
    value instanceof LingoFloat ||
    typeof value === "number" ||
    typeof value === "string"
  );
}

function toNumber(value: LingoValue): number {
  if (typeof value === "number") return value;
  if (value instanceof LingoFloat) return value.value;
  if (value instanceof LingoVoid) return 0;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  throw new ops.LingoScriptError("expected a number");
}

function toIndex(value: LingoValue): number {
  if (typeof value === "number") return Math.trunc(value);
  if (value instanceof LingoFloat) return Math.trunc(value.value);
  if (value instanceof LingoVoid) return 0;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Math.trunc(Number(value));
  }
  throw new ops.LingoScriptError("expected an integer");
}

function listAwareExtrema(
  args: LingoValue[],
  shouldReplace: (value: LingoValue, best: LingoValue) => boolean,
): LingoValue {
  const values = args.length === 1 && args[0] instanceof LingoList ? args[0].items : args;
  if (values.length === 0) return LINGO_VOID;
  return values.reduce((best, value) => (shouldReplace(value, best) ? value : best));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

function hexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, "0").toUpperCase();
}

const DIRECTOR_SYSTEM_MAC_PALETTE = createDirectorSystemMacPalette();

function directorPaletteIndex(value: LingoValue): LingoColor {
  const index = clampByte(toIndex(value));
  const color = DIRECTOR_SYSTEM_MAC_PALETTE[index] ?? { red: 0, green: 0, blue: 0 };
  return new LingoColor(color.red, color.green, color.blue, index);
}

function nearestDirectorPaletteIndex(color: LingoColor): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < DIRECTOR_SYSTEM_MAC_PALETTE.length; i += 1) {
    const candidate = DIRECTOR_SYSTEM_MAC_PALETTE[i]!;
    const dr = candidate.red - color.r;
    const dg = candidate.green - color.g;
    const db = candidate.blue - color.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function rectUnion(left: LingoRect, right: LingoRect): LingoRect {
  return new LingoRect(
    Math.min(left.left, right.left),
    Math.min(left.top, right.top),
    Math.max(left.right, right.right),
    Math.max(left.bottom, right.bottom),
  );
}

function rectIntersection(left: LingoRect, right: LingoRect): LingoRect {
  const resultLeft = Math.max(left.left, right.left);
  const resultTop = Math.max(left.top, right.top);
  const resultRight = Math.min(left.right, right.right);
  const resultBottom = Math.min(left.bottom, right.bottom);
  if (resultRight < resultLeft || resultBottom < resultTop) {
    return new LingoRect(0, 0, 0, 0);
  }
  return new LingoRect(resultLeft, resultTop, resultRight, resultBottom);
}

function createDirectorSystemMacPalette(): readonly { readonly red: number; readonly green: number; readonly blue: number }[] {
  const colors: { red: number; green: number; blue: number }[] = [];
  const cube = [255, 204, 153, 102, 51, 0];
  for (const red of cube) {
    for (const green of cube) {
      for (const blue of cube) {
        if (red === 0 && green === 0 && blue === 0) continue;
        colors.push({ red, green, blue });
      }
    }
  }

  const ramps = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const red of ramps) colors.push({ red, green: 0, blue: 0 });
  for (const green of ramps) colors.push({ red: 0, green, blue: 0 });
  for (const blue of ramps) colors.push({ red: 0, green: 0, blue });
  for (const value of ramps) colors.push({ red: value, green: value, blue: value });
  colors.push({ red: 0, green: 0, blue: 0 });
  return colors;
}

function ilkOf(value: LingoValue): string {
  if (typeof value === "number") return "integer";
  if (value instanceof LingoFloat) return "float";
  if (typeof value === "string") return "string";
  if (value instanceof LingoSymbol) return "symbol";
  if (value instanceof LingoVoid) return "void";
  if (value instanceof LingoList) return "list";
  if (value instanceof LingoPropList) return "proplist";
  if (value instanceof ScriptInstance) return "instance";
  if (isLingoObject(value)) {
    // CastMember -> #member, LingoPoint -> #point, LingoRect -> #rect, ...
    return value.lingoType.toLowerCase();
  }
  return "object";
}

/** value(): evaluate a Lingo literal expression from a string, exactly like
 * Director evaluates field/server data (`["Object Manager Class"]`,
 * `[#a: 1]`, numbers, symbols). Anything that cannot be evaluated yields
 * VOID (RC4 setKey branches on `voidp(value(tMyKey))` for key strings). */
function lingoValueOfString(input: LingoValue): LingoValue {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed === "") return LINGO_VOID;
  const parseLiteralValue = (source: string): LingoValue => {
    const expression = parseLingoExpression(source);
    const result = evalLiteral(expression);
    return result === undefined ? LINGO_VOID : result;
  };
  try {
    return parseLiteralValue(trimmed);
  } catch {
    const balanced = trimExcessTrailingSquareBrackets(trimmed);
    if (balanced !== trimmed) {
      try {
        return parseLiteralValue(balanced);
      } catch {
        return LINGO_VOID;
      }
    }
  }
  return LINGO_VOID;
}

function trimExcessTrailingSquareBrackets(source: string): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const char of source) {
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    }
  }
  let trimmed = source.trimEnd();
  while (depth < 0 && trimmed.endsWith("]")) {
    trimmed = trimmed.slice(0, -1).trimEnd();
    depth += 1;
  }
  return depth === 0 ? trimmed : source;
}

function evalLiteral(expression: Expression): LingoValue | undefined {
  switch (expression.kind) {
    case "integer":
      return expression.value;
    case "float":
      return float(expression.value);
    case "string":
      return expression.value;
    case "symbol":
      return LingoSymbol.for(expression.name);
    case "paren":
      return evalLiteral(expression.expression);
    case "unary": {
      const operand = evalLiteral(expression.operand);
      if (operand === undefined) return undefined;
      if (expression.operator === "+") {
        if (typeof operand === "number" || operand instanceof LingoFloat) return operand;
        return undefined;
      }
      if (expression.operator !== "-") return undefined;
      if (typeof operand === "number") return -operand;
      if (operand instanceof LingoFloat) return float(-operand.value);
      return undefined;
    }
    case "identifier": {
      switch (expression.name.toLowerCase()) {
        case "void":
          return LINGO_VOID;
        case "true":
          return 1;
        case "false":
          return 0;
        case "empty":
          return "";
        case "return":
          return "\r";
        case "quote":
          return "\"";
        case "space":
          return " ";
        case "tab":
          return "\t";
        default:
          return undefined;
      }
    }
    case "list": {
      const items: LingoValue[] = [];
      for (const element of expression.elements) {
        const value = evalLiteral(element);
        if (value === undefined) return undefined;
        items.push(value);
      }
      return new LingoList(items);
    }
    case "propertyList": {
      const result = new LingoPropList();
      for (const entry of expression.entries) {
        const key =
          entry.key.kind === "identifier"
            ? LingoSymbol.for(entry.key.name)
            : evalLiteral(entry.key);
        const value = evalLiteral(entry.value);
        if (key === undefined || value === undefined) return undefined;
        result.addProp(key, value);
      }
      return result;
    }
    case "callExpression": {
      // value() evaluates expressions; the variable data uses the value
      // constructors rgb/color/point/rect (loading.bar.props, struct.font.*).
      const args: number[] = [];
      let stringArg: string | null = null;
      let symbolArg: string | null = null;
      for (const argument of expression.arguments) {
        const value = evalLiteral(argument);
        if (typeof value === "number") args.push(value);
        else if (value instanceof LingoFloat) args.push(value.value);
        else if (typeof value === "string") stringArg = value;
        else if (value instanceof LingoSymbol) symbolArg = value.name.toLowerCase();
        else return undefined;
      }
      switch (expression.callee.toLowerCase()) {
        case "rgb":
          if (stringArg !== null) {
            const hex = Number.parseInt(stringArg.replace(/^#/, ""), 16);
            return new LingoColor((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
          }
          return new LingoColor(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        case "color":
          if (symbolArg === "paletteindex") return directorPaletteIndex(args[0] ?? 0);
          if (symbolArg === "rgb") return new LingoColor(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
          return new LingoColor(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        case "paletteindex":
          return directorPaletteIndex(args[0] ?? 0);
        case "point":
          return new LingoPoint(args[0] ?? 0, args[1] ?? 0);
        case "rect":
          return new LingoRect(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
