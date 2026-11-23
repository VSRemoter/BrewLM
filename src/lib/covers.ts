/**
 * Ready-made notebook covers, drawn on the spot: a gradient with a light
 * pattern. The result is an ordinary JPEG file, so it goes through the same
 * path as an uploaded cover (compressed, stored, synced, shared).
 */

export interface CoverStyle {
  id: string;
  name: string;
  stops: [string, string, string];
  pattern: "dots" | "waves" | "grid" | "rings" | "none";
}

export const COVER_STYLES: CoverStyle[] = [
  { id: "ember", name: "Ember", stops: ["#c2410c", "#f2541b", "#fbbf24"], pattern: "waves" },
  { id: "latte", name: "Latte", stops: ["#a47148", "#d4a373", "#faedcd"], pattern: "dots" },
  { id: "matcha", name: "Matcha", stops: ["#14532d", "#2e9a5e", "#bbf7d0"], pattern: "rings" },
  { id: "coldbrew", name: "Cold Brew", stops: ["#0b1d4f", "#2563eb", "#7dd3fc"], pattern: "grid" },
  { id: "berry", name: "Berry", stops: ["#6b0f35", "#db2777", "#f9a8d4"], pattern: "waves" },
  { id: "lavender", name: "Lavender", stops: ["#3b22a8", "#7c5cff", "#ddd6fe"], pattern: "dots" },
  { id: "night", name: "Night", stops: ["#0e0e11", "#27272f", "#52525b"], pattern: "rings" },
  { id: "sunrise", name: "Sunrise", stops: ["#f472b6", "#fb923c", "#fde68a"], pattern: "none" },
];

/** A CSS preview of a cover, for the picker. */
export function coverPreview(c: CoverStyle): string {
  return `linear-gradient(120deg, ${c.stops[0]}, ${c.stops[1]} 55%, ${c.stops[2]})`;
}

const W = 1200;
const H = 400;

function drawPattern(ctx: CanvasRenderingContext2D, pattern: CoverStyle["pattern"]): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 3;
  if (pattern === "dots") {
    for (let y = 20; y < H; y += 34) for (let x = (y / 34) % 2 ? 37 : 20; x < W; x += 34) {
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (pattern === "waves") {
    for (let row = -1; row < 9; row++) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 10) {
        const y = row * 52 + Math.sin(x / 70 + row) * 16;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (pattern === "grid") {
    ctx.lineWidth = 1.5;
    for (let x = 0; x <= W; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  } else if (pattern === "rings") {
    for (let r = 60; r < 900; r += 56) {
      ctx.beginPath();
      ctx.arc(W * 0.82, H * 0.2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Draws a ready-made cover as a JPEG file. */
export async function makeCover(id: string): Promise<File> {
  const c = COVER_STYLES.find((x) => x.id === id) ?? COVER_STYLES[0];
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  const g = ctx.createLinearGradient(0, H, W, 0);
  g.addColorStop(0, c.stops[0]);
  g.addColorStop(0.55, c.stops[1]);
  g.addColorStop(1, c.stops[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A soft light from the top right.
  const glow = ctx.createRadialGradient(W * 0.85, 0, 0, W * 0.85, 0, W * 0.6);
  glow.addColorStop(0, "rgba(255,255,255,0.28)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  drawPattern(ctx, c.pattern);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error("couldn't draw the cover");
  return new File([blob], `${c.id}-cover.jpg`, { type: "image/jpeg" });
}
