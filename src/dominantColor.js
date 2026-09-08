// Pulls one representative color out of a song's cover art so the graph
// and the playing card can tint themselves to match it — the same idea as
// Spotify/Apple Music's now-playing backgrounds — instead of every song
// rendering in the same fixed accent blue regardless of its actual art.
//
// Deliberately coarse: this draws the image down to a tiny canvas and
// averages pixels (skipping near-white/near-black ones, which tend to be
// letterboxing or background rather than the actual subject), not a real
// k-means/quantized "dominant cluster" — good enough to feel like it
// matches the art without pulling in a color-quantization library for it.

// url -> {r,g,b} | null (cached even on failure, so a bad/untaintable image
// isn't retried every render). Capped so a long session that cycles through
// many covers (local-upload blob: URLs especially — a fresh one every time
// a song's art gets replaced) can't grow this without bound; a plain FIFO
// evict-the-oldest is enough since this is a speed cache, not a source of
// truth — losing an old entry only costs one re-decode if that exact URL
// ever comes back.
const colorCache = new Map();
const COLOR_CACHE_MAX = 300;
function cacheColor(url, result) {
  if (colorCache.size >= COLOR_CACHE_MAX) {
    const oldest = colorCache.keys().next().value;
    colorCache.delete(oldest);
  }
  colorCache.set(url, result);
}

function averageFromImage(img) {
  const SIZE = 24;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE); // throws (tainted canvas) if the source isn't same-origin/CORS-cleared
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const pr = data[i], pg = data[i + 1], pb = data[i + 2];
    const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
    if (lum < 12 || lum > 246) continue; // skip near-black/near-white letterboxing
    r += pr; g += pg; b += pb; n++;
  }
  if (n === 0) { r = 128; g = 128; b = 128; n = 1; } // genuinely monochrome art — flat grey rather than nothing
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

// `url` should already be a real, fetchable URL (a resolved `blob:`/data:/
// https: URL, not a `local:` marker) — see useDominantColor, shared.jsx.
export function extractDominantColor(url) {
  if (!url) return Promise.resolve(null);
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // harmless for blob:/data:, needed for a same-origin-CORS http(s) cover
    img.onload = () => {
      let result = null;
      try { result = averageFromImage(img); } catch (e) { result = null; } // tainted canvas (no CORS) — fall back to the default palette
      cacheColor(url, result);
      resolve(result);
    };
    img.onerror = () => { cacheColor(url, null); resolve(null); };
    img.src = url;
  });
}

function mix(rgb, target, amount) {
  return {
    r: Math.round(rgb.r + (target.r - rgb.r) * amount),
    g: Math.round(rgb.g + (target.g - rgb.g) * amount),
    b: Math.round(rgb.b + (target.b - rgb.b) * amount),
  };
}
function css({ r, g, b }) { return `rgb(${r}, ${g}, ${b})`; }
const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

// Turns one extracted color into the same playing/next/later + background
// tones the app's fixed blue palette already uses (--state-playing/-next/
// -later, see styles.css) — "playing" is darkened enough to keep the
// playing card's white text readable regardless of how light the source
// art is; "next"/"later" progressively lighten toward white, same
// relationship as the static palette's own three blues.
export function derivePalette(rgb) {
  // Guards against more than just a missing `rgb` — a malformed-but-truthy
  // value (any future bug upstream that hands this something other than a
  // real {r,g,b} triple) falls back to null (the fixed accent-blue
  // palette) the same as no color at all, rather than computing/rendering
  // `rgb(NaN, NaN, NaN)` on every consumer of this palette.
  if (!rgb || !Number.isFinite(rgb.r) || !Number.isFinite(rgb.g) || !Number.isFinite(rgb.b)) return null;
  const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  // A light cover (e.g. mostly-white art) needs a bigger push toward black
  // to still read as a dark "playing" background; a color that's already
  // dark only needs a small push for visual depth/consistency.
  const darkenAmount = Math.max(0.15, Math.min(0.75, (luminance - 60) / 220));
  return {
    playing: css(mix(rgb, BLACK, darkenAmount)),
    next: css(mix(rgb, WHITE, 0.35)),
    nextBg: css(mix(rgb, WHITE, 0.9)),
    later: css(mix(rgb, WHITE, 0.55)),
    laterBg: css(mix(rgb, WHITE, 0.94)),
  };
}
