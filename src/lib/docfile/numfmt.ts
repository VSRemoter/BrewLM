/**
 * How a spreadsheet number looks: currency or other text before and after,
 * decimals, thousands separators, percent, or a date/time pattern. Requests
 * can name one ("money"), describe one ({"prefix": "€", "decimals": 2}) or
 * write an Excel-style code ("€#,##0.00", "0.0%", "dd/mm/yyyy"); whatever
 * comes in is rebuilt from these parts, so the Excel code written to the
 * file is always one Excel accepts (a malformed code makes it call the whole
 * file damaged), and the preview shows the same thing.
 */

export type NumFormat =
  | { kind: "number"; prefix: string; suffix: string; decimals: number; thousands: boolean; percent: boolean }
  | { kind: "date"; pattern: string }
  | { kind: "text" };

/** Date and time patterns, in Excel's own codes. */
export const DATE_PATTERNS = [
  "yyyy-mm-dd",
  "dd/mm/yyyy",
  "mm/dd/yyyy",
  "d mmm yyyy",
  "mmm d, yyyy",
  "mmmm d, yyyy",
  "dddd, mmmm d, yyyy",
  "mmm yyyy",
  "mmmm yyyy",
  "yyyy",
  "h:mm",
  "h:mm AM/PM",
  "yyyy-mm-dd h:mm",
  "dd/mm/yyyy h:mm",
  "mm/dd/yyyy h:mm AM/PM",
] as const;

const number = (decimals: number, o: Partial<{ prefix: string; suffix: string; thousands: boolean; percent: boolean }> = {}): NumFormat => ({
  kind: "number",
  prefix: o.prefix ?? "",
  suffix: o.suffix ?? "",
  decimals,
  thousands: o.thousands ?? true,
  percent: o.percent ?? false,
});

const NAMED: Record<string, NumFormat | null> = {
  general: null,
  text: { kind: "text" },
  integer: number(0),
  number: number(2),
  decimal: number(2),
  money: number(2),
  currency: number(2),
  percent: number(1, { percent: true, thousands: false }),
  percentage: number(1, { percent: true, thousands: false }),
  date: { kind: "date", pattern: "yyyy-mm-dd" },
  time: { kind: "date", pattern: "h:mm" },
  datetime: { kind: "date", pattern: "yyyy-mm-dd h:mm" },
};

/** Literal text in a format: no quotes, backslashes or other code characters. */
const literal = (s: unknown) => (typeof s === "string" ? s.replace(/["\\;[\]@*_]/g, "").slice(0, 12) : "");

/** Read one Excel-style number code ("$#,##0.00", "#,##0 \"km\"", "0.0%"); null when it isn't a simple one. */
function parseCode(code: string): NumFormat | null {
  // Only the positive section; locale tags like [$€-407] become their symbol.
  const c = code.split(";")[0].replace(/\[\$([^\]-]*)[^\]]*\]/g, "$1").trim();
  const m = /^((?:"[^"]*"|[^0#?,.%"])*)([#0?,]*[0#])(?:\.([0#]+))?(%?)((?:"[^"]*"|[^0#?,.%"])*)$/.exec(c);
  if (!m) return null;
  const unquote = (s: string) => literal(s.replace(/"([^"]*)"/g, "$1").replace(/\\(.)/g, "$1"));
  return {
    kind: "number",
    prefix: unquote(m[1]),
    suffix: unquote(m[5]),
    decimals: m[3] ? Math.min(10, m[3].length) : 0,
    thousands: m[2].includes(","),
    percent: m[4] === "%",
  };
}

/** A format from a name, an Excel-style code or a description object; null = General. */
export function numFormat(v: unknown): NumFormat | null {
  if (typeof v === "string") {
    const t = v.trim();
    const lower = t.toLowerCase();
    if (lower in NAMED) return NAMED[lower];
    const date = DATE_PATTERNS.find((p) => p.toLowerCase() === lower.replace(/^date:\s*/, ""));
    if (date) return { kind: "date", pattern: date };
    if (t === "@") return { kind: "text" };
    return parseCode(t);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind === "text") return { kind: "text" };
  if (typeof o.date === "string" || o.type === "date" || o.kind === "date") {
    const p = DATE_PATTERNS.find((x) => x.toLowerCase() === String(o.pattern ?? o.date ?? "").toLowerCase());
    return { kind: "date", pattern: p ?? "yyyy-mm-dd" };
  }
  const decimals = typeof o.decimals === "number" ? Math.min(10, Math.max(0, Math.round(o.decimals))) : 2;
  return number(decimals, {
    prefix: literal(o.prefix ?? o.symbol ?? o.currency),
    suffix: literal(o.suffix ?? o.unit),
    thousands: o.thousands !== false,
    percent: o.percent === true,
  });
}

/** The format's code as an Excel file stores it (null = General). */
export function excelCode(f: NumFormat | null): string | null {
  if (!f) return null;
  if (f.kind === "text") return "@";
  if (f.kind === "date") return f.pattern;
  const q = (s: string) => (s ? `"${s}"` : "");
  return `${q(f.prefix)}${f.thousands ? "#,##0" : "0"}${f.decimals ? `.${"0".repeat(f.decimals)}` : ""}${f.percent ? "%" : ""}${q(f.suffix)}`;
}

/* --------------------------------- display -------------------------------- */

/** Rounded to 15 significant digits, as spreadsheets show numbers (0.1 + 0.2 = 0.3). */
export const tidy = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);

const group = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A number as its format shows it; General shows it as typed. */
export function formatNumber(n: number, f: NumFormat | null): string {
  const t = tidy(n);
  if (!f || f.kind === "text" || Math.abs(t) >= 1e15) return String(t);
  if (f.kind === "date") return formatDate(t, f.pattern);
  const v = f.percent ? t * 100 : t;
  const [int, frac] = Math.abs(v).toFixed(f.decimals).split(".");
  const digits = `${f.thousands ? group(int) : int}${frac ? `.${frac}` : ""}`;
  const shown = `${f.prefix}${digits}${f.percent ? "%" : ""}${f.suffix}`;
  return v < 0 && Number(digits.replace(/,/g, "")) !== 0 ? `-${shown}` : shown;
}

/* ---------------------------------- dates --------------------------------- */

const DAY_MS = 86_400_000;
/** Excel's day 0 (it counts 1900 as a leap year, so serials from March 1900 on line up with this). */
const EPOCH = Date.UTC(1899, 11, 30);

/** "2026-12-25", "2026-12-25 14:30" or "2026-12-25T14:30" as an Excel date serial; null otherwise. */
export function dateSerial(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  if (new Date(ms).getUTCDate() !== d) return null;
  return tidy((ms - EPOCH) / DAY_MS);
}

/** Does this value look like a date the sheet should keep as one? */
export const hasTime = (v: string) => /[T ]\d{1,2}:\d{2}/.test(v);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** An Excel date serial in one of DATE_PATTERNS. */
export function formatDate(serial: number, pattern: string): string {
  const d = new Date(EPOCH + Math.round(serial * DAY_MS));
  const ampm = /AM\/PM/.test(pattern);
  const hours = d.getUTCHours();
  let afterHour = false;
  return pattern.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|AM\/PM/g, (tok) => {
    const minutes = afterHour && (tok === "mm" || tok === "m");
    if (tok === "h" || tok === "hh") afterHour = true;
    else if (tok !== "AM/PM") afterHour = false;
    if (minutes) return String(d.getUTCMinutes()).padStart(tok.length, "0");
    switch (tok) {
      case "yyyy":
        return String(d.getUTCFullYear());
      case "yy":
        return String(d.getUTCFullYear() % 100).padStart(2, "0");
      case "mmmm":
        return MONTHS[d.getUTCMonth()];
      case "mmm":
        return MONTHS[d.getUTCMonth()].slice(0, 3);
      case "mm":
        return String(d.getUTCMonth() + 1).padStart(2, "0");
      case "m":
        return String(d.getUTCMonth() + 1);
      case "dddd":
        return DAYS[d.getUTCDay()];
      case "ddd":
        return DAYS[d.getUTCDay()].slice(0, 3);
      case "dd":
        return String(d.getUTCDate()).padStart(2, "0");
      case "d":
        return String(d.getUTCDate());
      case "hh":
      case "h": {
        const h = ampm ? hours % 12 || 12 : hours;
        return tok === "hh" ? String(h).padStart(2, "0") : String(h);
      }
      case "ss":
        return String(d.getUTCSeconds()).padStart(2, "0");
      default:
        return hours < 12 ? "AM" : "PM";
    }
  });
}
