import type { LingoContext } from "./context";
import { LINGO_VOID, LingoList, type LingoObjectLike, type LingoValue } from "./values";

export interface GeneratedScriptModule {
  scriptName: string;
  scriptType: string;
  scriptProperties: string[];
  scriptGlobals: string[];
  handlers: Record<string, (ctx: LingoContext, me: LingoValue, args: LingoValue[]) => LingoValue>;
}

export class UnsupportedFeatureError extends Error {
  constructor(public readonly feature: string) {
    super(`unsupported: ${feature}`);
  }
}

export class ScriptingObjectRef implements LingoObjectLike {
  readonly lingoType: string;
  readonly windowList = new LingoList();

  constructor(name: "_movie" | "_player" | "_system" | "_sound") {
    this.lingoType = name;
  }
}

export class ScriptRef implements LingoObjectLike {
  readonly lingoType = "scriptRef";
  constructor(public readonly module: GeneratedScriptModule) {}

  lingoToString(): string {
    return `(script "${this.module.scriptName}")`;
  }
}

export class MissingScriptRef implements LingoObjectLike {
  readonly lingoType = "missingScriptRef";

  constructor(
    public readonly requested: string,
    public readonly memberName: string,
    public readonly slotNumber: number,
    public readonly castName: string,
  ) {}

  lingoToString(): string {
    return `(missing script "${this.memberName}" requested as ${this.requested})`;
  }
}

export class MissingScriptInstance implements LingoObjectLike {
  readonly lingoType = "missingScriptInstance";

  constructor(public readonly ref: MissingScriptRef) {}

  lingoToString(): string {
    return `<missing offspring "${this.ref.memberName}">`;
  }
}

export class ScriptInstance implements LingoObjectLike {
  readonly lingoType = "instance";
  readonly props = new Map<string, LingoValue>();

  constructor(public readonly module: GeneratedScriptModule) {
    for (const property of module.scriptProperties) this.props.set(property.toLowerCase(), LINGO_VOID);
    if (!this.props.has("ancestor")) this.props.set("ancestor", LINGO_VOID);
  }

  lingoToString(): string {
    return `<offspring "${this.module.scriptName}">`;
  }
}

/** Lazy accessor produced by `someString.char`, consumed by chunk indexing. */
export class ChunkRef implements LingoObjectLike {
  readonly lingoType = "chunkRef";

  constructor(
    public readonly source: string,
    public readonly chunkType: string,
    public readonly owner: LingoValue | null = null,
    public readonly start: number | null = null,
    public readonly end: number | null = null,
  ) {}

  withSelection(source: string, start: number, end: number): ChunkRef {
    return new ChunkRef(source, this.chunkType, this.owner, start, end);
  }

  lingoToString(): string {
    return this.source;
  }
}
