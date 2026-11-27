/**
 * Spreadsheet formulas: check them, write them the way Excel stores them, and
 * work out their values for the preview and the file's cached values (Excel
 * recalculates on open, but phone previews and some viewers only show what's
 * cached, and without it formula cells look empty there).
 *
 * Each sheet is its grid of cells as the file lays them out (row 1 first).
 * Covers arithmetic, comparisons, & joins, cell and range references (also on
 * other sheets) and the common functions the document prompt names. Anything
 * else is still written as a formula for Excel to work out; it just has no
 * value here.
 */

import { formatNumber, tidy, type NumFormat } from "./numfmt";

export type Cell = string | number | boolean | null;

export interface GridSheet {
  name: string;
  /** Row 1 first; strings starting with "=" are formulas. */
  grid: Cell[][];
}

/** What a cell works out to. */
export type Computed =
  | { kind: "value"; value: number | string | boolean }
  | { kind: "error"; code: string }
  /** A formula this can't evaluate (an unsupported function, a loop): Excel will. */
  | { kind: "unknown" }
  | { kind: "blank" };

/** A formula cell ("=…"); not a type guard, since plain text is a string too. */
export const isFormula = (v: Cell): boolean => typeof v === "string" && /^=\s*\S/.test(v);

/* --------------------------------- tokens --------------------------------- */

type Tok =
  | { t: "num"; v: number; text: string }
  | { t: "str"; v: string; text: string }
  | { t: "ref"; text: string; sheet?: string; a: string; b?: string }
  | { t: "fn"; name: string }
  | { t: "bool"; v: boolean; text: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const COL = String.raw`\$?[A-Za-z]{1,3}`;
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`;
const REF_RE = new RegExp(`^(?:${SHEET})?(?:(${CELL})(?::(${CELL}))?|(${COL}):(${COL}))(?![\\w(])`);

class Bad extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let v = "";
      for (;;) {
        if (j >= src.length) throw new Bad("unclosed text");
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += src[j++];
      }
      out.push({ t: "str", v, text: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const num = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (num && !/^[A-Za-z]/.test(rest.slice(num[0].length, num[0].length + 1))) {
      out.push({ t: "num", v: Number(num[0]), text: num[0] });
      i += num[0].length;
      continue;
    }
    const fn = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(rest);
    if (fn) {
      out.push({ t: "fn", name: fn[1].toUpperCase().replace(/^_XLFN\./, "") });
      out.push({ t: "(" });
      i += fn[0].length;
      continue;
    }
    const ref = REF_RE.exec(rest);
    if (ref) {
      const sheet = ref[1] !== undefined ? ref[1].replace(/''/g, "'") : ref[2];
      const a = (ref[3] ?? ref[5]).toUpperCase();
      const b = (ref[4] ?? ref[6])?.toUpperCase();
      out.push({ t: "ref", text: ref[0], sheet, a, b });
      i += ref[0].length;
      continue;
    }
    const word = /^(TRUE|FALSE)(?![\w(])/i.exec(rest);
    if (word) {
      out.push({ t: "bool", v: word[1].toUpperCase() === "TRUE", text: word[1].toUpperCase() });
      i += word[0].length;
      continue;
    }
    const op = /^(<=|>=|<>|[-+*/^&=<>%])/.exec(rest);
    if (op) {
      out.push({ t: "op", v: op[1] });
      i += op[1].length;
      continue;
    }
    if (c === "(") out.push({ t: "(" });
    else if (c === ")") out.push({ t: ")" });
    // Some locales separate arguments with ";": files always use ",".
    else if (c === "," || c === ";") out.push({ t: "," });
    else throw new Bad(`unexpected “${c}”`);
    i++;
  }
  return out;
}

/* --------------------------------- syntax --------------------------------- */

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; sheet?: string; a: string; b?: string; whole?: boolean }
  | { t: "fn"; name: string; args: Node[] }
  | { t: "un"; op: string; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

function parse(tokens: Tok[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (...ops: string[]) => {
    const k = tokens[p];
    return k?.t === "op" && ops.includes(k.v);
  };
  const binary = (next: () => Node, ...ops: string[]) => (): Node => {
    let a = next();
    while (isOp(...ops)) {
      const op = (tokens[p++] as { v: string }).v;
      a = { t: "bin", op, a, b: next() };
    }
    return a;
  };
  const primary = (): Node => {
    const k = tokens[p++];
    if (!k) throw new Bad("formula ends early");
    switch (k.t) {
      case "num":
        return { t: "num", v: k.v };
      case "str":
        return { t: "str", v: k.v };
      case "bool":
        return { t: "bool", v: k.v };
      case "ref":
        return { t: "ref", sheet: k.sheet, a: k.a, b: k.b, whole: !/\d/.test(k.a) };
      case "(": {
        const e = comparison();
        if (peek()?.t !== ")") throw new Bad("missing )");
        p++;
        return e;
      }
      case "fn": {
        p++; // its "("
        const args: Node[] = [];
        if (peek()?.t === ")") {
          p++;
          return { t: "fn", name: k.name, args };
        }
        for (;;) {
          args.push(comparison());
          const n = tokens[p++];
          if (n?.t === ")") break;
          if (n?.t !== ",") throw new Bad("missing )");
        }
        return { t: "fn", name: k.name, args };
      }
      default:
        throw new Bad("unexpected token");
    }
  };
  const postfix = (): Node => {
    let a = primary();
    while (isOp("%")) {
      p++;
      a = { t: "un", op: "%", a };
    }
    return a;
  };
  const unary = (): Node => {
    if (isOp("-", "+")) {
      const op = (tokens[p++] as { v: string }).v;
      return { t: "un", op, a: unary() };
    }
    return postfix();
  };
  const power = binary(unary, "^");
  const product = binary(power, "*", "/");
  const sum = binary(product, "+", "-");
  const concat = binary(sum, "&");
  const comparison = binary(concat, "=", "<>", "<", ">", "<=", ">=");
  const tree = comparison();
  if (p !== tokens.length) throw new Bad("unexpected text after the formula");
  return tree;
}

/** Functions newer Excel stores with a prefix, or older readers show #NAME?. */
const XLFN = new Set(["CONCAT", "TEXTJOIN", "IFS", "SWITCH", "MAXIFS", "MINIFS", "IFNA", "XLOOKUP", "XMATCH", "STDEV.S", "STDEV.P", "VAR.S", "VAR.P"]);

/**
 * A formula as a file stores it: no "=", "," between arguments, function
 * names in capitals (prefixed where Excel wants it). Null when it doesn't
 * parse: Excel would call the whole file damaged, so it's kept as text.
 */
export function formulaForFile(formula: string): string | null {
  const src = formula.trim().replace(/^=/, "");
  let tokens: Tok[];
  try {
    tokens = tokenize(src);
    if (!tokens.length) return null;
    parse(tokens);
  } catch (e) {
    if (e instanceof Bad) return null;
    throw e;
  }
  return tokens
    .map((k) => {
      switch (k.t) {
        case "fn":
          return `${XLFN.has(k.name) ? "_xlfn." : ""}${k.name}(`;
        case "(":
          return "";
        case ")":
          return ")";
        case ",":
          return ",";
        case "op":
          return k.v;
        default:
          return k.text;
      }
    })
    .join("");
}

/* -------------------------------- addresses ------------------------------- */

/** "AB" → 27 (0-based). */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.replace(/\$/g, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 27 → "AB". */
export function colName(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellAt(a1: string): { r: number; c: number } {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(a1)!;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]) };
}

/* ------------------------------- evaluation ------------------------------- */

class FErr {
  constructor(public code: string) {}
}
class Unknown {}

type Scalar = number | string | boolean | null | FErr;
/** A range's cells, row by row. */
type RangeVal = { range: Scalar[] };
type Val = Scalar | RangeVal;

const isRange = (v: Val): v is RangeVal => typeof v === "object" && v !== null && "range" in v;

function toNum(v: Scalar): number {
  if (v instanceof FErr) throw v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const t = v.trim().replace(/,/g, "");
  if (t && !Number.isNaN(Number(t))) return Number(t);
  throw new FErr("#VALUE!");
}

function toText(v: Scalar): string {
  if (v instanceof FErr) throw v;
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(tidy(v));
  return v;
}

function toBool(v: Scalar): boolean {
  if (v instanceof FErr) throw v;
  if (typeof v === "string") {
    const t = v.trim().toUpperCase();
    if (t === "TRUE") return true;
    if (t === "FALSE") return false;
    throw new FErr("#VALUE!");
  }
  return toNum(v) !== 0;
}

/** Excel's ordering: numbers < text < booleans; text ignores case. */
function compare(a: Scalar, b: Scalar): number {
  if (a instanceof FErr) throw a;
  if (b instanceof FErr) throw b;
  const blankAs = (x: Scalar, other: Scalar): Scalar => (x === null ? (typeof other === "string" ? "" : typeof other === "boolean" ? false : 0) : x);
  const x = blankAs(a, b);
  const y = blankAs(b, a);
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (typeof x === "string") return x.toLowerCase().localeCompare((y as string).toLowerCase());
  return Number(x) - Number(y);
}

/** A COUNTIF-style criterion: ">10", "<>done", "apple", 5. */
function matches(v: Scalar, crit: Scalar): boolean {
  if (v instanceof FErr) return false;
  if (typeof crit !== "string") return v !== null && compare(v, crit) === 0;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(crit)!;
  const op = m[1] ?? "=";
  const raw = m[2];
  const asNum = raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : null;
  const target: Scalar = asNum ?? raw;
  if (typeof target === "string" && (op === "=" || op === "<>") && /[*?]/.test(target)) {
    const re = new RegExp(`^${target.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    const hit = v !== null && re.test(toText(v));
    return op === "=" ? hit : !hit;
  }
  if (v === null) return op === "<>" ? target !== "" : target === "" && op === "=";
  if (typeof target === "number" && typeof v !== "number") return op === "<>";
  const d = compare(v, target);
  switch (op) {
    case "<":
      return d < 0;
    case ">":
      return d > 0;
    case "<=":
      return d <= 0;
    case ">=":
      return d >= 0;
    case "<>":
      return d !== 0;
    default:
      return d === 0;
  }
}

/**
 * Work out every cell of a workbook on demand. Returns a lookup by sheet
 * index and 0-based grid row/column (row 0 = row 1).
 */
export function evaluateBook(sheets: GridSheet[]): (sheet: number, r: number, c: number) => Computed {
  const memo = new Map<string, Scalar | Unknown>();
  const busy = new Set<string>();
  const trees = new Map<string, Node | null>();

  const sheetIndex = (name: string | undefined, from: number): number => {
    if (name === undefined) return from;
    const i = sheets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i < 0) throw new FErr("#REF!");
    return i;
  };
  const raw = (s: number, r: number, c: number): Cell => sheets[s]?.grid[r]?.[c] ?? null;
  const height = (s: number) => sheets[s].grid.length;

  const cell = (s: number, r: number, c: number): Scalar => {
    const key = `${s}:${r}:${c}`;
    if (memo.has(key)) {
      const v = memo.get(key)!;
      if (v instanceof Unknown) throw v;
      return v;
    }
    const v = raw(s, r, c);
    if (typeof v !== "string" || !isFormula(v)) return v === "" ? null : v;
    if (busy.has(key)) throw new Unknown(); // a loop: Excel will say so
    busy.add(key);
    try {
      let tree = trees.get(key);
      if (tree === undefined) {
        try {
          tree = parse(tokenize(v.trim().slice(1)));
        } catch (e) {
          if (!(e instanceof Bad)) throw e;
          tree = null;
        }
        trees.set(key, tree);
      }
      // Kept as text (it doesn't parse): its value is the text itself.
      let out: Scalar;
      if (!tree) out = v;
      else {
        try {
          const val = evaluate(tree, s);
          out = isRange(val) ? new FErr("#VALUE!") : val;
        } catch (e) {
          if (e instanceof FErr) out = e;
          else throw e;
        }
      }
      if (typeof out === "number") out = Number.isFinite(out) ? tidy(out) : new FErr("#NUM!");
      memo.set(key, out);
      return out;
    } catch (e) {
      if (e instanceof Unknown) memo.set(key, e);
      throw e;
    } finally {
      busy.delete(key);
    }
  };

  const rangeOf = (n: Extract<Node, { t: "ref" }>, from: number): Scalar[] => {
    const s = sheetIndex(n.sheet, from);
    let r1: number, c1: number, r2: number, c2: number;
    if (n.whole) {
      c1 = colIndex(n.a);
      c2 = colIndex(n.b ?? n.a);
      r1 = 0;
      r2 = height(s) - 1;
    } else {
      const a = cellAt(n.a);
      const b = n.b ? cellAt(n.b) : a;
      r1 = a.r;
      c1 = a.c;
      r2 = b.r;
      c2 = b.c;
    }
    if (r1 > r2) [r1, r2] = [r2, r1];
    if (c1 > c2) [c1, c2] = [c2, c1];
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200_000) throw new Unknown();
    const out: Scalar[] = [];
    for (let r = r1; r <= Math.min(r2, height(s) - 1); r++) for (let c = c1; c <= c2; c++) out.push(cell(s, r, c));
    return out;
  };

  /** Numbers for SUM-style functions: ranges skip text and booleans; direct values must be numbers. */
  const numbers = (args: Val[]): number[] => {
    const out: number[] = [];
    for (const a of args) {
      if (isRange(a)) {
        for (const v of a.range) {
          if (v instanceof FErr) throw v;
          if (typeof v === "number") out.push(v);
        }
      } else out.push(toNum(a));
    }
    return out;
  };
  const scalar = (v: Val): Scalar => {
    if (!isRange(v)) return v;
    if (v.range.length === 1) return v.range[0];
    throw new FErr("#VALUE!");
  };
  const roundTo = (x: number, digits: number, mode: "round" | "up" | "down") => {
    const f = 10 ** Math.trunc(digits);
    const y = Math.abs(x) * f;
    const r = mode === "round" ? Math.round(Number(y.toPrecision(15))) : mode === "up" ? Math.ceil(Number(y.toPrecision(15))) : Math.floor(Number(y.toPrecision(15)));
    return (Math.sign(x) * r) / f;
  };

  const call = (name: string, argNodes: Node[], from: number): Val => {
    // A reference argument is a range, even of one cell: SUM(A2) skips text there as SUM(A2:A3) does.
    const ev = (i: number): Val => {
      const n = argNodes[i];
      return n.t === "ref" ? { range: rangeOf(n, from) } : evaluate(n, from);
    };
    const sc = (i: number): Scalar => scalar(ev(i));
    const all = () => argNodes.map((_, i) => ev(i));
    const need = (min: number, max = min) => {
      if (argNodes.length < min || argNodes.length > max) throw new FErr("#VALUE!");
    };
    const ifRange = (fn: "SUMIF" | "COUNTIF" | "AVERAGEIF") => {
      need(2, fn === "COUNTIF" ? 2 : 3);
      const range = ev(0);
      const crit = sc(1);
      const values = isRange(range) ? range.range : [range];
      const target = argNodes[2] ? ev(2) : range;
      const sums = isRange(target) ? target.range : [target];
      let total = 0;
      let count = 0;
      values.forEach((v, i) => {
        if (!matches(v, crit)) return;
        count++;
        const s = sums[i];
        if (typeof s === "number") total += s;
      });
      if (fn === "COUNTIF") return count;
      if (fn === "SUMIF") return total;
      if (count === 0) throw new FErr("#DIV/0!");
      return total / count;
    };
    switch (name) {
      case "SUM":
        return numbers(all()).reduce((a, b) => a + b, 0);
      case "PRODUCT":
        return numbers(all()).reduce((a, b) => a * b, 1);
      case "AVERAGE": {
        const n = numbers(all());
        if (!n.length) throw new FErr("#DIV/0!");
        return n.reduce((a, b) => a + b, 0) / n.length;
      }
      case "MEDIAN": {
        const n = numbers(all()).sort((a, b) => a - b);
        if (!n.length) throw new FErr("#NUM!");
        const m = Math.floor(n.length / 2);
        return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
      }
      case "MIN": {
        const n = numbers(all());
        return n.length ? Math.min(...n) : 0;
      }
      case "MAX": {
        const n = numbers(all());
        return n.length ? Math.max(...n) : 0;
      }
      case "COUNT":
        return all().reduce<number>((k, a) => k + (isRange(a) ? a.range.filter((v) => typeof v === "number").length : typeof a === "number" ? 1 : 0), 0);
      case "COUNTA":
        return all().reduce<number>((k, a) => k + (isRange(a) ? a.range.filter((v) => v !== null && v !== "").length : a !== null ? 1 : 0), 0);
      case "SUMIF":
      case "COUNTIF":
      case "AVERAGEIF":
        return ifRange(name);
      case "ROUND":
      case "ROUNDUP":
      case "ROUNDDOWN":
        need(1, 2);
        return roundTo(toNum(sc(0)), argNodes[1] ? toNum(sc(1)) : 0, name === "ROUND" ? "round" : name === "ROUNDUP" ? "up" : "down");
      case "INT":
        need(1);
        return Math.floor(toNum(sc(0)));
      case "ABS":
        need(1);
        return Math.abs(toNum(sc(0)));
      case "SQRT": {
        need(1);
        const x = toNum(sc(0));
        if (x < 0) throw new FErr("#NUM!");
        return Math.sqrt(x);
      }
      case "POWER":
        need(2);
        return toNum(sc(0)) ** toNum(sc(1));
      case "MOD": {
        need(2);
        const d = toNum(sc(1));
        if (d === 0) throw new FErr("#DIV/0!");
        const x = toNum(sc(0));
        return x - d * Math.floor(x / d);
      }
      case "PI":
        need(0);
        return Math.PI;
      case "IF": {
        need(2, 3);
        if (toBool(sc(0))) return sc(1);
        return argNodes[2] ? sc(2) : false;
      }
      case "IFERROR":
        need(2);
        try {
          const v = sc(0);
          if (v instanceof FErr) return sc(1);
          return v;
        } catch (e) {
          if (e instanceof FErr) return sc(1);
          throw e;
        }
      case "AND":
      case "OR": {
        const vals: boolean[] = [];
        for (const a of all()) {
          if (isRange(a)) for (const v of a.range) {
            if (v instanceof FErr) throw v;
            if (typeof v === "number" || typeof v === "boolean") vals.push(toBool(v));
          }
          else vals.push(toBool(a));
        }
        if (!vals.length) throw new FErr("#VALUE!");
        return name === "AND" ? vals.every(Boolean) : vals.some(Boolean);
      }
      case "NOT":
        need(1);
        return !toBool(sc(0));
      case "CONCAT":
      case "CONCATENATE":
        return all()
          .map((a) => (isRange(a) ? a.range.map(toText).join("") : toText(a)))
          .join("");
      case "LEN":
        need(1);
        return toText(sc(0)).length;
      case "UPPER":
        need(1);
        return toText(sc(0)).toUpperCase();
      case "LOWER":
        need(1);
        return toText(sc(0)).toLowerCase();
      case "TRIM":
        need(1);
        return toText(sc(0)).trim().replace(/ +/g, " ");
      case "LEFT":
      case "RIGHT": {
        need(1, 2);
        const t = toText(sc(0));
        const n = argNodes[1] ? Math.max(0, Math.floor(toNum(sc(1)))) : 1;
        return name === "LEFT" ? t.slice(0, n) : n === 0 ? "" : t.slice(-n);
      }
      case "PMT": {
        need(3, 5);
        const rate = toNum(sc(0));
        const nper = toNum(sc(1));
        const pv = toNum(sc(2));
        const fv = argNodes[3] ? toNum(sc(3)) : 0;
        const type = argNodes[4] ? toNum(sc(4)) : 0;
        if (nper === 0) throw new FErr("#NUM!");
        if (rate === 0) return -(pv + fv) / nper;
        const f = (1 + rate) ** nper;
        return (-(pv * f + fv) * rate) / ((1 + rate * (type ? 1 : 0)) * (f - 1));
      }
      default:
        throw new Unknown();
    }
  };

  const evaluate = (n: Node, from: number): Val => {
    switch (n.t) {
      case "num":
      case "str":
      case "bool":
        return n.v;
      case "ref": {
        if (n.b || n.whole) return { range: rangeOf(n, from) };
        const s = sheetIndex(n.sheet, from);
        const { r, c } = cellAt(n.a);
        return cell(s, r, c);
      }
      case "fn":
        return call(n.name, n.args, from);
      case "un": {
        const a = toNum(scalar(evaluate(n.a, from)));
        return n.op === "-" ? -a : n.op === "%" ? a / 100 : a;
      }
      case "bin": {
        const a = scalar(evaluate(n.a, from));
        const b = scalar(evaluate(n.b, from));
        switch (n.op) {
          case "+":
            return toNum(a) + toNum(b);
          case "-":
            return toNum(a) - toNum(b);
          case "*":
            return toNum(a) * toNum(b);
          case "/": {
            const d = toNum(b);
            const x = toNum(a);
            if (d === 0) throw new FErr("#DIV/0!");
            return x / d;
          }
          case "^":
            return toNum(a) ** toNum(b);
          case "&":
            return toText(a) + toText(b);
          case "=":
            return compare(a, b) === 0;
          case "<>":
            return compare(a, b) !== 0;
          case "<":
            return compare(a, b) < 0;
          case ">":
            return compare(a, b) > 0;
          case "<=":
            return compare(a, b) <= 0;
          default:
            return compare(a, b) >= 0;
        }
      }
    }
  };

  return (s, r, c) => {
    try {
      const v = cell(s, r, c);
      if (v === null) return { kind: "blank" };
      if (v instanceof FErr) return { kind: "error", code: v.code };
      return { kind: "value", value: v };
    } catch (e) {
      if (e instanceof Unknown) return { kind: "unknown" };
      if (e instanceof FErr) return { kind: "error", code: e.code };
      throw e;
    }
  };
}

/** A computed value as a spreadsheet would show it, in its number format. */
export function showComputed(v: Computed, format?: NumFormat | null, formula?: string): string {
  switch (v.kind) {
    case "blank":
      return "";
    case "error":
      return v.code;
    case "unknown":
      return formula ?? "";
    case "value":
      return typeof v.value === "boolean" ? (v.value ? "TRUE" : "FALSE") : typeof v.value === "number" ? formatNumber(v.value, format ?? null) : v.value;
  }
}
