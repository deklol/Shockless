import { LingoObjectLike, LingoValue } from "./values";

/** Director point/rect values. Lingo allows arithmetic and indexing on
 * these; capabilities are added as release306 source exercises them. */

export class LingoPoint implements LingoObjectLike {
  readonly lingoType = "point";
  constructor(
    public x: number,
    public y: number,
  ) {}

  lingoEquals(other: LingoValue): boolean {
    return other instanceof LingoPoint && other.x === this.x && other.y === this.y;
  }

  lingoToString(): string {
    return `point(${this.x}, ${this.y})`;
  }
}

export class LingoColor implements LingoObjectLike {
  readonly lingoType = "color";
  constructor(
    public r: number,
    public g: number,
    public b: number,
    public paletteIndex: number | null = null,
  ) {}

  get hex(): number {
    return ((this.r & 0xff) << 16) | ((this.g & 0xff) << 8) | (this.b & 0xff);
  }

  lingoEquals(other: LingoValue): boolean {
    return other instanceof LingoColor && other.r === this.r && other.g === this.g && other.b === this.b;
  }

  lingoToString(): string {
    if (this.paletteIndex !== null) {
      return `paletteIndex(${this.paletteIndex})`;
    }
    return `color(${this.r}, ${this.g}, ${this.b})`;
  }
}

export class LingoDate implements LingoObjectLike {
  readonly lingoType = "date";
  constructor(
    public year: number,
    public month: number,
    public day: number,
  ) {}

  lingoEquals(other: LingoValue): boolean {
    return other instanceof LingoDate && other.year === this.year && other.month === this.month && other.day === this.day;
  }

  lingoToString(): string {
    return `date( ${this.year}, ${this.month}, ${this.day} )`;
  }
}

export class LingoRect implements LingoObjectLike {
  readonly lingoType = "rect";
  constructor(
    public left: number,
    public top: number,
    public right: number,
    public bottom: number,
  ) {}

  get width(): number {
    return this.right - this.left;
  }

  get height(): number {
    return this.bottom - this.top;
  }

  lingoEquals(other: LingoValue): boolean {
    return (
      other instanceof LingoRect &&
      other.left === this.left &&
      other.top === this.top &&
      other.right === this.right &&
      other.bottom === this.bottom
    );
  }

  lingoToString(): string {
    return `rect(${this.left}, ${this.top}, ${this.right}, ${this.bottom})`;
  }
}
