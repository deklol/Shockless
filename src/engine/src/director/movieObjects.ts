import { LINGO_VOID, type LingoObjectLike, type LingoValue } from "./values";

export interface TimeoutOwner {
  dropTimeout(name: string): void;
}

export class CastLibRef implements LingoObjectLike {
  readonly lingoType = "castLibRef";
  preloadMode = 0;
  name: string;
  /** Setting fileName is Director's dynamic cast-load trigger. */
  fileName: string;

  constructor(
    public readonly number: number,
    initialName: string,
  ) {
    this.name = initialName;
    this.fileName = `${initialName}.cst`;
  }

  lingoToString(): string {
    return `(castLib ${this.number})`;
  }
}

export class StageRef implements LingoObjectLike {
  readonly lingoType = "stageRef";
}

export class TimeoutRef implements LingoObjectLike {
  readonly lingoType = "timeout";
  periodMs = 0;
  handler: LingoValue = LINGO_VOID;
  target: LingoValue = LINGO_VOID;
  nextFireAt = 0;
  active = false;

  constructor(
    public readonly name: string,
    private readonly owner: TimeoutOwner,
  ) {}

  schedule(periodMs: number, handler: LingoValue, target: LingoValue): void {
    this.periodMs = Math.max(1, periodMs);
    this.handler = handler;
    this.target = target;
    this.nextFireAt = Date.now() + this.periodMs;
    this.active = true;
  }

  forget(): void {
    this.active = false;
    this.owner.dropTimeout(this.name);
  }
}

export function formatDirectorTime(now: Date, long: boolean): string {
  let hours = now.getHours();
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return long ? `${hours}:${minutes}:${seconds} ${suffix}` : `${hours}:${minutes} ${suffix}`;
}
