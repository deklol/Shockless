import { LingoScript } from "../ast";
import { walkHandler } from "./walk";

/**
 * Project-wide semantic index over every parsed release306 script.
 *
 * Script identity comes from the ProjectorRays output layout:
 *   <castFile>/casts/<castName>/<ScriptType> <memberNumber>[ - <memberName>].ls
 * ProjectorRays names files from the cast member metadata, so the member name
 * in the filename is source data, not a guess.
 */

export type ScriptType = "movie" | "parent" | "behavior" | "cast" | "score" | "unknown";

export interface ScriptInfo {
  /** Path relative to the source root, forward slashes. */
  id: string;
  castFile: string;
  castName: string;
  scriptType: ScriptType;
  memberNumber: number | null;
  /** Member name from the filename, e.g. "Active Object Class". */
  memberName: string | null;
  properties: string[];
  globals: string[];
  handlers: { name: string; parameters: string[] }[];
}

export interface CallSite {
  scriptId: string;
  handler: string;
  line: number;
}

export interface ProjectIndex {
  scripts: ScriptInfo[];
  /** lowercased handler name -> scripts defining it */
  handlersByName: Map<string, ScriptInfo[]>;
  /** lowercased parent-script member name -> script */
  classByName: Map<string, ScriptInfo>;
  /** lowercased callee -> call sites (free function/command calls) */
  freeCalls: Map<string, CallSite[]>;
  /** lowercased method name -> call sites (receiver.method(...) calls) */
  methodCalls: Map<string, CallSite[]>;
  /** lowercased `the X` property -> use count */
  theProperties: Map<string, number>;
  /** lowercased `the X of obj` property -> use count */
  theOfProperties: Map<string, number>;
  /** objectRef type (member/sprite/...) -> use count */
  objectRefs: Map<string, number>;
  /** lowercased global name -> declaring scripts */
  globals: Map<string, Set<string>>;
}

const SCRIPT_TYPE_BY_PREFIX: Record<string, ScriptType> = {
  moviescript: "movie",
  parentscript: "parent",
  behaviorscript: "behavior",
  castscript: "cast",
  scorescript: "score",
};

export function parseScriptFileName(relativePath: string): {
  castFile: string;
  castName: string;
  scriptType: ScriptType;
  memberNumber: number | null;
  memberName: string | null;
} {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const castFile = parts[0] ?? "";
  const castName = parts.length >= 3 ? parts[parts.length - 2]! : "";
  const fileName = parts[parts.length - 1]!.replace(/\.ls$/i, "");
  const match = /^([A-Za-z]+)\s+(\d+)(?:\s*-\s*(.*))?$/.exec(fileName);
  if (!match) {
    return { castFile, castName, scriptType: "unknown", memberNumber: null, memberName: fileName };
  }
  const scriptType = SCRIPT_TYPE_BY_PREFIX[match[1]!.toLowerCase()] ?? "unknown";
  const memberName = match[3]?.trim() ?? null;
  return {
    castFile,
    castName,
    scriptType,
    memberNumber: Number(match[2]),
    memberName: memberName === "" ? null : memberName,
  };
}

function addCall(map: Map<string, CallSite[]>, name: string, site: CallSite): void {
  const key = name.toLowerCase();
  let sites = map.get(key);
  if (!sites) {
    sites = [];
    map.set(key, sites);
  }
  sites.push(site);
}

function bump(map: Map<string, number>, name: string): void {
  const key = name.toLowerCase();
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function buildProjectIndex(
  parsed: { relativePath: string; script: LingoScript }[],
): ProjectIndex {
  const index: ProjectIndex = {
    scripts: [],
    handlersByName: new Map(),
    classByName: new Map(),
    freeCalls: new Map(),
    methodCalls: new Map(),
    theProperties: new Map(),
    theOfProperties: new Map(),
    objectRefs: new Map(),
    globals: new Map(),
  };

  for (const { relativePath, script } of parsed) {
    const id = relativePath.replace(/\\/g, "/");
    const nameInfo = parseScriptFileName(id);
    const info: ScriptInfo = {
      id,
      ...nameInfo,
      properties: script.properties,
      globals: script.globals,
      handlers: script.handlers.map((h) => ({ name: h.name, parameters: h.parameters })),
    };
    index.scripts.push(info);

    for (const handler of script.handlers) {
      const key = handler.name.toLowerCase();
      let definers = index.handlersByName.get(key);
      if (!definers) {
        definers = [];
        index.handlersByName.set(key, definers);
      }
      definers.push(info);
    }

    if (info.scriptType === "parent" && info.memberName) {
      index.classByName.set(info.memberName.toLowerCase(), info);
    }

    const allGlobals = new Set(script.globals.map((g) => g.toLowerCase()));
    for (const handler of script.handlers) {
      walkHandler(handler, {
        statement: (statement) => {
          if (statement.kind === "global") {
            for (const name of statement.names) allGlobals.add(name.toLowerCase());
          }
        },
        expression: (expression) => {
          const site: CallSite = { scriptId: id, handler: handler.name, line: expression.line };
          switch (expression.kind) {
            case "callExpression":
              addCall(index.freeCalls, expression.callee, site);
              break;
            case "methodCall":
              addCall(index.methodCalls, expression.method, site);
              break;
            case "the":
              bump(index.theProperties, expression.property);
              break;
            case "theOf":
              bump(index.theOfProperties, expression.property);
              break;
            case "objectRef":
              bump(index.objectRefs, expression.refType);
              break;
            default:
              break;
          }
        },
      });
    }
    for (const globalName of allGlobals) {
      let scripts = index.globals.get(globalName);
      if (!scripts) {
        scripts = new Set();
        index.globals.set(globalName, scripts);
      }
      scripts.add(id);
    }
  }

  return index;
}

/** Free calls with no source handler definition anywhere: the Director/Lingo
 * builtin surface the runtime must provide. */
export function unresolvedFreeCalls(index: ProjectIndex): Map<string, CallSite[]> {
  const unresolved = new Map<string, CallSite[]>();
  for (const [name, sites] of index.freeCalls) {
    if (!index.handlersByName.has(name)) {
      unresolved.set(name, sites);
    }
  }
  return unresolved;
}

/** Method calls with no source handler definition anywhere: list/string/
 * object builtin methods. */
export function unresolvedMethodCalls(index: ProjectIndex): Map<string, CallSite[]> {
  const unresolved = new Map<string, CallSite[]>();
  for (const [name, sites] of index.methodCalls) {
    if (!index.handlersByName.has(name)) {
      unresolved.set(name, sites);
    }
  }
  return unresolved;
}
