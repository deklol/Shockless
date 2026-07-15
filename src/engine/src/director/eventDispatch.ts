import { LINGO_VOID, type LingoValue } from "./values";

export type DirectorEventTier = "primary" | "behavior" | "cast" | "frame" | "movie";

export class DirectorPassSignal extends Error {
  constructor() {
    super("Director event pass");
    this.name = "DirectorPassSignal";
  }
}

export interface DirectorEventContext {
  stopped: boolean;
}

export interface DirectorEventRuntime {
  beginDirectorEvent(): DirectorEventContext;
  endDirectorEvent(context: DirectorEventContext): void;
}

export interface DirectorEventHandler {
  readonly tier: DirectorEventTier;
  readonly label: string;
  readonly invoke: () => LingoValue;
}

export interface DirectorEventLocation {
  readonly tier: DirectorEventTier;
  readonly handlers: readonly DirectorEventHandler[];
  /** Sprite and frame locations offer the event to attached behaviors in order. */
  readonly broadcast?: boolean;
}

export interface DirectorEventDispatchResult {
  readonly handled: boolean;
  readonly consumed: boolean;
  readonly defaultAllowed: boolean;
  readonly stopped: boolean;
  readonly passed: boolean;
  readonly behaviorHandlerFound: boolean;
  readonly lastResult: LingoValue;
  readonly route: readonly string[];
}

/**
 * Dispatches one Director message through its ordered handler locations.
 * A normal handler consumes the message at its hierarchy level. `pass`
 * branches immediately to the next level, while stopEvent prevents later
 * attached behaviors and every lower level. Each call owns an independent
 * context so nested sendSprite traffic cannot leak state into its caller.
 */
export function dispatchDirectorEvent(
  runtime: DirectorEventRuntime,
  locations: readonly DirectorEventLocation[],
): DirectorEventDispatchResult {
  const context = runtime.beginDirectorEvent();
  let handled = false;
  let passed = false;
  let behaviorHandlerFound = false;
  let lastResult: LingoValue = LINGO_VOID;
  const route: string[] = [];

  try {
    for (const location of locations) {
      if (location.handlers.length === 0) continue;
      const handlers = location.broadcast ? location.handlers : location.handlers.slice(0, 1);
      let locationPassed = false;

      for (const handler of handlers) {
        handled = true;
        behaviorHandlerFound ||= handler.tier === "behavior";
        route.push(handler.label);
        try {
          lastResult = handler.invoke();
        } catch (error) {
          if (!(error instanceof DirectorPassSignal)) throw error;
          passed = true;
          locationPassed = true;
          break;
        }
        if (context.stopped) {
          return {
            handled,
            consumed: true,
            defaultAllowed: false,
            stopped: true,
            passed,
            behaviorHandlerFound,
            lastResult,
            route,
          };
        }
      }

      if (locationPassed) continue;
      return {
        handled,
        consumed: true,
        defaultAllowed: false,
        stopped: false,
        passed,
        behaviorHandlerFound,
        lastResult,
        route,
      };
    }

    return {
      handled,
      consumed: false,
      defaultAllowed: true,
      stopped: false,
      passed,
      behaviorHandlerFound,
      lastResult,
      route,
    };
  } finally {
    runtime.endDirectorEvent(context);
  }
}
