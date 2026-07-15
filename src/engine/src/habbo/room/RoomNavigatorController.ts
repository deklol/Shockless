import type { DirectorMovie } from "@director/Movie";
import { ScriptInstance } from "@director/Runtime";
import {
  LINGO_VOID,
  LingoPropList,
  LingoVoid,
  type LingoValue,
} from "@director/values";

interface NavigatorNodeEntry {
  readonly node: LingoPropList;
  readonly cacheKey: LingoValue | null;
  readonly parentCacheKey: LingoValue | null;
}

export interface NavigatorCacheResult {
  readonly route: string;
  readonly sendResult: unknown;
  readonly expandedCategories: unknown[];
  readonly publicNodes: Array<Record<string, unknown>>;
  readonly errors: string[];
}

export interface PublicRoomEntryStartResult {
  readonly route: string;
  readonly query: string | number | null;
  readonly node: unknown;
  readonly cache: NavigatorCacheResult;
  readonly result: unknown;
  readonly errors: string[];
}

interface RoomNavigatorControllerOptions<TRoomReady> {
  readonly movie: DirectorMovie;
  readonly navigatorComponent: () => ScriptInstance | null;
  readonly instancePropValue: (instance: ScriptInstance, name: string) => LingoValue | undefined;
  readonly propListValue: (list: LingoPropList, key: string) => LingoValue;
  readonly debugValue: (value: LingoValue | undefined) => unknown;
  readonly summarizeValue: (value: LingoValue, depth: number) => unknown;
  readonly valueToNumber: (value: LingoValue | undefined, fallback?: number) => number;
  readonly delay: (milliseconds: number) => Promise<void>;
  readonly waitForRoomReady: (timeoutMs?: number) => Promise<TRoomReady>;
}

/**
 * Owns the source navigator node cache and public-room entry workflow.
 * The controller delegates entry to the generated Lingo handlers rather than
 * constructing room state or protocol messages in the host runtime.
 */
export class RoomNavigatorController<TRoomReady> {
  constructor(private readonly options: RoomNavigatorControllerOptions<TRoomReady>) {}

  nodes(): Array<Record<string, unknown>> {
    return this.collectNodes().map((entry) => this.summarizeNode(entry));
  }

  publicNodes(): Array<Record<string, unknown>> {
    return this.collectNodes(new Set([1])).map((entry) => this.summarizeNode(entry));
  }

  async ensurePublicNodes(timeoutMs = 15000, query?: string | number): Promise<NavigatorCacheResult> {
    const errors: string[] = [];
    const expandedCategories: unknown[] = [];
    const navigatorComponent = this.options.navigatorComponent();
    let route = "Navigator Component cached node data";
    let sendResult: unknown = LINGO_VOID;
    if (!(navigatorComponent instanceof ScriptInstance)) {
      return { route, sendResult: null, expandedCategories, publicNodes: [], errors: ["Navigator Component not available"] };
    }

    const sendNavigate = (category: LingoValue): unknown => {
      if (category instanceof LingoVoid || !this.options.movie.runtime.hasHandler(navigatorComponent, "sendnavigate")) {
        return null;
      }
      try {
        return this.options.summarizeValue(this.options.movie.runtime.callMethod(navigatorComponent, "sendnavigate", [category]), 2);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        return null;
      }
    };

    if (this.publicNodes().length === 0) {
      const rootUnitCatId = this.options.instancePropValue(navigatorComponent, "prootunitcatid");
      const targetCategory = rootUnitCatId instanceof LingoVoid || rootUnitCatId === undefined ? LINGO_VOID : rootUnitCatId;
      route = "Navigator Component.sendNavigate(public root)";
      if (!(targetCategory instanceof LingoVoid)) {
        sendResult = sendNavigate(targetCategory);
      } else {
        errors.push("Navigator public root category is not available");
      }
    }

    const deadline = performance.now() + Math.max(1, Number(timeoutMs) || 15000);
    let publicNodes = this.publicNodes();
    while (publicNodes.length === 0 && performance.now() < deadline) {
      await this.options.delay(100);
      publicNodes = this.publicNodes();
    }

    if (query !== undefined && !this.findPublicNode(query) && performance.now() < deadline) {
      route = "Navigator Component.sendNavigate(public categories)";
      const expandedIds = new Set<string>();
      while (!this.findPublicNode(query) && performance.now() < deadline) {
        const categoryEntry = this.collectNodes(new Set([0])).find((entry) => {
          const id = String(this.options.debugValue(this.options.propListValue(entry.node, "id")) ?? "");
          return id.length > 0 && !expandedIds.has(id);
        });
        if (!categoryEntry) break;

        const categoryId = this.options.propListValue(categoryEntry.node, "id");
        const categoryIdText = String(this.options.debugValue(categoryId) ?? "");
        if (categoryIdText.length === 0) break;
        expandedIds.add(categoryIdText);
        expandedCategories.push({
          node: this.summarizeNode(categoryEntry),
          sendResult: sendNavigate(categoryId),
        });

        while (!this.findPublicNode(query) && performance.now() < deadline) {
          await this.options.delay(100);
          const newerCategories = this.collectNodes(new Set([0])).filter((entry) => {
            const id = String(this.options.debugValue(this.options.propListValue(entry.node, "id")) ?? "");
            return id.length > 0 && !expandedIds.has(id);
          });
          if (this.findPublicNode(query) || newerCategories.length > 0) break;
        }
      }
      publicNodes = this.publicNodes();
    }

    return { route, sendResult, expandedCategories, publicNodes, errors };
  }

  async beginPublicRoomEntry(query?: string | number, cacheTimeoutMs = 20000): Promise<PublicRoomEntryStartResult> {
    const errors: string[] = [];
    const cache = await this.ensurePublicNodes(cacheTimeoutMs, query);
    errors.push(...cache.errors);
    const navigatorComponent = this.options.navigatorComponent();
    let result: LingoValue = LINGO_VOID;
    const node = this.findPublicNode(query);

    if (!(navigatorComponent instanceof ScriptInstance) || !this.options.movie.runtime.hasHandler(navigatorComponent, "prepareroomentry")) {
      errors.push("Navigator Component.prepareRoomEntry not available");
    } else if (!(node instanceof LingoPropList)) {
      errors.push(`public room node not found: ${query ?? "<first>"}`);
    } else {
      try {
        result = this.options.movie.runtime.callMethod(navigatorComponent, "prepareroomentry", [node]);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      route: "Navigator Component.prepareRoomEntry(public node)",
      query: query ?? null,
      node: node instanceof LingoPropList ? this.options.summarizeValue(node, 2) : null,
      cache,
      result: this.options.summarizeValue(result, 2),
      errors,
    };
  }

  async enterPublicRoom(query?: string | number, timeoutMs = 90000): Promise<PublicRoomEntryStartResult & { roomReady: TRoomReady }> {
    const started = await this.beginPublicRoomEntry(query, Math.min(timeoutMs, 20000));
    const roomReady = await this.options.waitForRoomReady(timeoutMs);
    return { ...started, roomReady };
  }

  private collectNodes(nodeTypes?: Set<number>): NavigatorNodeEntry[] {
    const navigatorComponent = this.options.navigatorComponent();
    if (!(navigatorComponent instanceof ScriptInstance)) return [];
    const cache = this.options.instancePropValue(navigatorComponent, "pnodecache");
    if (!(cache instanceof LingoPropList)) return [];

    const result: NavigatorNodeEntry[] = [];
    const seen = new Set<LingoPropList>();
    const visitNode = (node: LingoValue, cacheKey: LingoValue | null, parentCacheKey: LingoValue | null): void => {
      if (!(node instanceof LingoPropList) || seen.has(node)) return;
      seen.add(node);
      const nodeType = this.options.propListValue(node, "nodeType");
      if (typeof nodeType === "number" && (!nodeTypes || nodeTypes.has(nodeType))) {
        result.push({ node, cacheKey, parentCacheKey });
      }
      const children = this.options.propListValue(node, "children");
      if (children instanceof LingoPropList) {
        for (let index = 0; index < children.values.length; index += 1) {
          visitNode(children.values[index]!, children.keys[index] ?? null, cacheKey);
        }
      }
    };

    for (let index = 0; index < cache.values.length; index += 1) {
      visitNode(cache.values[index]!, cache.keys[index] ?? null, null);
    }
    return result;
  }

  private summarizeNode(entry: NavigatorNodeEntry): Record<string, unknown> {
    const value = (key: string): LingoValue => this.options.propListValue(entry.node, key);
    return {
      cacheKey: entry.cacheKey === null ? null : this.options.debugValue(entry.cacheKey),
      parentCacheKey: entry.parentCacheKey === null ? null : this.options.debugValue(entry.parentCacheKey),
      nodeType: this.options.debugValue(value("nodeType")),
      id: this.options.debugValue(value("id")),
      name: this.options.debugValue(value("name")),
      parentId: this.options.debugValue(value("parentid")),
      unitStrId: this.options.debugValue(value("unitStrId")),
      port: this.options.debugValue(value("port")),
      door: this.options.debugValue(value("door")),
      users: this.options.debugValue(value("usercount")),
      maxUsers: this.options.debugValue(value("maxUsers")),
      casts: this.options.summarizeValue(value("casts"), 1),
      hidden: this.options.debugValue(value("hidden")),
      halfRoomID: this.options.debugValue(value("halfRoomID")),
    };
  }

  private findNode(query: string | number | undefined, nodeTypes?: Set<number>): LingoPropList | null {
    const raw = query === undefined ? "" : String(query).trim();
    const rawLower = raw.toLowerCase();
    const rawNumber = raw.length > 0 && /^\d+$/.test(raw) ? Number(raw) : null;
    const nodes = this.collectNodes(nodeTypes).map((entry) => entry.node);
    if (nodes.length === 0) return null;
    if (raw.length === 0) return nodes[0] ?? null;
    const field = (node: LingoPropList, key: string): string => {
      const debug = this.options.debugValue(this.options.propListValue(node, key));
      return debug === undefined || debug === null ? "" : String(debug);
    };
    return (
      nodes.find((node) => field(node, "id") === raw) ??
      nodes.find((node) => field(node, "unitStrId").toLowerCase() === rawLower) ??
      nodes.find((node) => field(node, "name").toLowerCase() === rawLower) ??
      (rawNumber === null
        ? undefined
        : nodes.find((node) => this.options.valueToNumber(this.options.propListValue(node, "port"), -1) === rawNumber)) ??
      nodes.find((node) => field(node, "name").toLowerCase().includes(rawLower)) ??
      null
    );
  }

  private findPublicNode(query: string | number | undefined): LingoPropList | null {
    return this.findNode(query, new Set([1]));
  }
}
