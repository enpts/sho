/*
 * sho.js — brush calligraphy engine
 *
 * The writer (e.g., LLM) writes each stroke only as a list of points (each with position, pressure, brush angle, speed and pause) plus the corner mark "k",
 * and expresses hidden tip, exposed tip, stop, turning corner, hook, sweep, dew-drop ending and hanging needle entirely through how the points are placed.
 * The engine handles only the physics of brush, paper and ink:
 *   - The brush angle can point in any direction (tip → belly: 0 right, 90 down, 180 left, 270 up). Aligned with the direction of travel, the tip runs down the center of the line (centered tip)
 *   - Pressure is 0–2. At 1 the line is as wide as the declared brush size, at 2 twice as wide. If omitted, 1
 *   - A point is where the tip touches the paper. The belly spreads along the axis (tip → belly) in proportion to the pressure, and as the pressure falls the area on the paper
 *     shrinks toward the tip. So a thin entry or the end of a sweep lands exactly on the point
 *   - Points are joined by centripetal Catmull-Rom, and pressure, angle and speed are interpolated too. A "k" point (turning corner), however, makes a corner instead of joining smoothly
 *   - Ink has two parameters: amount (ink_load: how easily the line goes dry) and darkness (ink_tone: the depth of the color and how easily it bleeds).
 *     The faster the brush, the less ink reaches the paper and the drier the line; where it is slow or pauses, ink pools. Where it pauses the outline rounds, and
 *     the paler the ink, the more it bleeds past the line
 *   - All randomness is derived from things like point positions, so the same data at the same resolution always gives the same picture
 */
(function (global) {
  'use strict';

  // ---------- tuning ----------
  const KASURE = 2;     // How strongly dry brush takes effect: for how ink comes out (ink core, pooling, bleed), the brush speed counts as this many times faster (writing speed and time do not change)
  const INK_MULT = 1.3; // Multiplier for the ink the brush holds at ink amount 1
  // Speed (the data's value) → share of the ink that reaches the paper, linear between entries. It keeps falling with speed, so dry brush grows steadily stronger
  // (Roughly: no dry brush up to speed 1, faint at 1.5, slight at 2, just over half at 3, about a tenth of the line left at 6)
  const TRANSFER = [[0.5, 1], [1, 0.72], [1.5, 0.4], [2, 0.29], [2.5, 0.25], [3, 0.23], [4, 0.2], [5, 0.172], [6, 0.15]];
  function transferAt(v) {
    if (v <= TRANSFER[0][0]) return TRANSFER[0][1];
    for (let i = 1; i < TRANSFER.length; i++) {
      const [v1, t1] = TRANSFER[i], [v0, t0] = TRANSFER[i - 1];
      if (v <= v1) return t0 + ((t1 - t0) * (v - v0)) / (v1 - v0);
    }
    return TRANSFER[TRANSFER.length - 1][1];
  }
  // Reference brush size for bristles and paper grain (paper units). bristles is the bristle count at this size, and the count is proportional to brush size.
  // The paper grain is fixed to the paper, so streak width and length do not depend on brush size (at this size, about 14 cells across the brush)
  const REF_SIZE = 60;
  // Dry-brush mottle: along the direction of travel, splits the stroke into large patches of more and less dry brush (a slow variation, separate from the streaks of the paper grain)
  const MOTTLE_DEPTH = 0.5;     // Depth of the variation (raises and lowers the ink reaching the paper by ± this share. 0 for none)
  const MOTTLE_SIZE = 1;        // Multiplier for the mottle size (at 1, one patch is about 3 times the brush width)
  const MOTTLE_CONTRAST = 2.2;  // Contrast (the higher, the sharper the boundary between areas of more and less)
  // Pause: where the brush stops, ink pools (the inside of the line darkens) and the outline of the brush mark gradually rounds
  const POOL_FULL = 0.12;  // Pause (seconds) at which pooling inside the line reaches its maximum
  const POOL_RANGE = 1.0;  // Extent of pooling (before and after the paused point, as a share of the brush size)
  const ROUND_TAU = 1.6;   // Speed of rounding (seconds. About 60% rounded after this time, about 90% after 4 seconds)
  const ROUND_SWELL = 0.2; // Swelling when fully rounded (share added to the radius of the brush mark)
  const ROUND_REACH = 0.8; // Extent of rounding (before and after the paused point, as a share of the radius of the brush mark)
  const ROUND_RIM = 0.45;  // How pale the edge is when fully rounded (0: same darkness as the body, 1: paper color)
  const FRINGE = 0.25;     // Width of the pale ink bleed (how far it spreads past the line at ink darkness 0, as a share of the brush size)
  // Ellipse of the brush mark (ink core): length FOOT_A·r × width FOOT_B·r, shifted a little toward the belly (further as ink pools)
  const FOOT_A = 0.86, FOOT_B = 0.56;
  // autoDip: 'dry' reloads before a stroke when the brush's average ink is below this: the line would barely mark the paper
  const DRY_INK = 0.2;

  // Ink darkness (0–1) → color lightness (0–255). The paler the ink, the grayer
  // (Ink amount does not change the color. Amount affects dry brush; darkness affects the depth of the color and how easily it bleeds)
  function inkTone(value) {
    const d = Math.min(1, Math.max(0.05, value == null ? 1 : value));
    const L = (a, b) => a + (b - a) * d;
    // Bristles, core and rounding are layered with "keep the darker" (_mixStroke), so for dark ink each one is made dark enough
    const hair = L(200, -20); // Base lightness of bristle lines (per-bristle variation is added, and the result is kept at 2 or more)
    const pool = L(140, 4);   // Lightness of bristles where ink has pooled (ink stays dark where it has pooled)
    const core = L(215, 4);   // Lightness of the ink core (fills the gaps between bristles)
    const body = Math.max(2, Math.round(Math.min(pool, core))); // Lightness where ink has pooled (used for the inside of rounded areas)
    // Pale ink bleed: lighter than the line, with a slightly darker rim on the outside
    const line = Math.max(2, hair + 9);
    const fringe = line + (255 - line) * 0.55, rim = line + (255 - line) * 0.38;
    return { d, hair, pool, core, body, fringe, coreCss: inkCss(core), fringeCss: inkCss(fringe), rimCss: inkCss(rim) };
  }
  // Ink color: a very slightly warm gray at lightness l (0–255). The tint is subtractive, so even pale ink does not turn brown
  function inkCss(l) {
    const v = Math.max(0, Math.min(255, l));
    return `rgb(${v | 0},${Math.max(0, v - 3) | 0},${Math.max(0, v - 6) | 0})`;
  }

  // ---------- utils ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash2(a, b) {
    let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(seed, x) {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return hash2(seed, i) * (1 - u) + hash2(seed, i + 1) * u;
  }
  const fnoise = (seed, x) => vnoise(seed, x) * 0.65 + vnoise(seed + 7919, x * 2.7) * 0.35;
  // 2-D value noise (used to make neighbouring bristles hold similar amounts of ink)
  function vnoise2(seed, x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const at = (a, b) => hash2(seed + Math.imul(a, 92821), b);
    return lerp(lerp(at(ix, iy), at(ix + 1, iy), ux), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), ux), uy);
  }
  // Dry-brush mottle (0–1, drier toward 1): lat is the position across the brush (-1 to 1), s is the distance from the start of the stroke (brush units; the brush is about 7 wide).
  // Three octaves of mottle, slow along the direction of travel and very coarse across the width, with the contrast raised to form patches
  function mottleAt(seed, lat, s, size, contrast) {
    const f = 0.048 / (size || 1), y = lat + 1;
    const n = 0.57 * vnoise2(seed, y * 0.6, s * f) + 0.29 * vnoise2(seed + 31, y * 1.3, s * f * 2.1) + 0.14 * vnoise2(seed + 67, y * 2.4, s * f * 4.3);
    return smooth(clamp((n - 0.5) * contrast + 0.5, 0, 1));
  }

  // a 32-bit seed from a point in paper units (0.1 steps), so it does not depend on the render resolution
  const seedAt = (px, py, scale, salt) => (hash2(Math.round((px / scale) * 10) ^ (salt | 0), Math.round((py / scale) * 10)) * 4294967296) | 0;

  // Ellipse of the brush mark (sample j, radius r). round (0–1) moves it toward a circle, wet (0–1) shifts it toward the belly
  function footEllipse(job, j, r, wet, round) {
    const ca = job.ca[j], sa = job.sa[j], lean = 0.08 + 0.1 * wet;
    return {
      cx: job.x[j] + job.sx[j] + ca * lean * r, cy: job.y[j] + job.sy[j] + sa * lean * r,
      ax: r * lerp(FOOT_A, 1, round), bx: r * lerp(FOOT_B, 1, round), ca, sa, ang: Math.atan2(sa, ca),
    };
  }
  // Adds an ellipse to path (a Path2D or a 2D context)
  function addEllipse(path, cx, cy, ca, sa, ax, bx, ang) {
    path.moveTo(cx + ca * ax, cy + sa * ax);
    path.ellipse(cx, cy, ax, bx, ang, 0, Math.PI * 2);
  }
  // Rounding when pause ps has run for elapsed seconds (the calculation shared by _plan and _drawRound). The paler the ink (more water) and the harder the press,
  // the faster it rounds and the more it swells (internal pressure 0.6, that is pressure 1.2, counts as 1). Uses the pressure specified at the paused point
  // q: amount of rounding, lo to hi: the samples it reaches, weight(j): rounding at sample j, swell(w): swelling multiplier at rounding w
  function roundOf(job, ps, elapsed, tone) {
    const flow = lerp(2.2, 1, tone.d), swellK = lerp(1.6, 1, tone.d);
    const press = clamp(ps.p / 0.6, 0, 1.3), q = 1 - Math.exp(-(elapsed * flow * press) / ROUND_TAU);
    const reach = ROUND_REACH * Math.max(1, ps.p * job.R), span = Math.ceil(reach / job.h);
    return {
      q, lo: Math.max(0, ps.k - span), hi: Math.min(job.n - 1, ps.k + span),
      weight: (j) => q * smooth(clamp(1 - (Math.abs(j - ps.k) * job.h) / reach, 0, 1)),
      swell: (w) => 1 + ROUND_SWELL * w * press * swellK,
    };
  }

  // Capillary bleed (opts.bleed = 'capillary'): ink spreading radially outward along the paper fibers from the outline of the area the brush touched.
  // For each point outside the body, finds the nearest body point and carries ink out to a length set by that point. Because the body point sets the length,
  // equal lengths line up perpendicular to the outline and form radial streaks. Built at 1 pixel per paper unit (independent of resolution) and scaled up for use
  const CAPILLARY_REACH = 5; // Maximum reach of the bleed (multiplier on the width ext derived from FRINGE)
  const CAPILLARY_EDGE = 12;   // Width of the dark bleed just outside the body's outline (paper units). Wider for paler ink (× (1 - ink darkness))
  function capillaryHalo(FE, box, px, seed, tone, core, edgeWidth, layers) {
    const w = Math.max(1, Math.ceil((box[2] - box[0]) / px)), h = Math.max(1, Math.ceil((box[3] - box[1]) / px));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    // Map of bleed width: the red channel holds the width at that place. Bristle lines extend past the brush mark's ellipse (in proportion to brush size), so
    // it is painted larger by that much
    g.setTransform(1 / px, 0, 0, 1 / px, -box[0] / px, -box[1] / px);
    const margin = 3 * px;
    for (let i = 0; i < FE.length; i += 9) {
      const ext = FE[i + 8];
      g.fillStyle = `rgb(${clamp(Math.round((ext / px) * 4), 1, 255)},0,0)`;
      g.beginPath(); g.ellipse(FE[i], FE[i + 1], (FE[i + 4] - ext) * 1.4 + margin, (FE[i + 5] - ext) * 1.4 + margin, FE[i + 6], 0, Math.PI * 2); g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    const img = g.getImageData(0, 0, w, h), d = img.data, N = w * h;
    const extOf = (n) => (d[n * 4 + 3] > 0 ? d[n * 4] / 4 : 0);
    // The body is the lines actually drawn (bristle lines, ink core, pause balls)
    g.clearRect(0, 0, w, h);
    for (const l of layers) g.drawImage(l, box[0], box[1], box[2] - box[0], box[3] - box[1], 0, 0, w, h);
    const body = g.getImageData(0, 0, w, h).data;
    const ox = box[0] / px, oy = box[1] / px;
    // Chooses a body point (approximated with two passes, forward and backward). Points with a larger cost(n) reach farther
    const nearest = (cost) => {
      const near = new Int32Array(N).fill(-1), dist = new Float32Array(N).fill(1e12), score = new Float32Array(N).fill(1e12);
      for (let i = 0; i < N; i++) if (body[i * 4 + 3] > 127) { near[i] = i; dist[i] = 0; score[i] = 0; }
      const look = (i, x, y, j) => {
        const n = near[j]; if (n < 0 || score[i] === 0) return;
        const dx = x - n % w, dy = y - ((n / w) | 0), dd = dx * dx + dy * dy, s = dd / cost(n);
        if (s < score[i]) { score[i] = s; dist[i] = dd; near[i] = n; }
      };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x) look(i, x, y, i - 1);
        if (y) { look(i, x, y, i - w); if (x) look(i, x, y, i - w - 1); if (x < w - 1) look(i, x, y, i - w + 1); }
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        if (x < w - 1) look(i, x, y, i + 1);
        if (y < h - 1) { look(i, x, y, i + w); if (x < w - 1) look(i, x, y, i + w + 1); if (x) look(i, x, y, i + w - 1); }
      }
      return { near, dist };
    };
    // Reach of the bleed: width × a large undulation. The point with the smallest distance ÷ length is chosen, so the darkness joins smoothly between areas that bleed wide and narrow,
    // and where the bleeds of facing lines overlap
    const slowOf = new Float32Array(N).fill(-1);
    const slowReach = (n) => {
      if (slowOf[n] >= 0) return slowOf[n];
      return (slowOf[n] = extOf(n) * CAPILLARY_REACH * (0.5 + 0.5 * vnoise2(seed, (ox + n % w) * 0.02, (oy + ((n / w) | 0)) * 0.02)));
    };
    const reachField = nearest((n) => { const e = Math.max(0.25, slowReach(n)); return e * e; });
    // Radial streaks: set per truly nearest outline point. Equal lengths line up perpendicular to the outline, so they look radial
    const outline = nearest(() => 1);
    const fiberOf = new Float32Array(N).fill(-1);
    const fiber = (n) => {
      if (fiberOf[n] >= 0) return fiberOf[n];
      const nx = ox + n % w, ny = oy + ((n / w) | 0);
      return (fiberOf[n] = (0.78 + 0.22 * vnoise2(seed + 11, nx * 0.22, ny * 0.22)) * (0.72 + 0.28 * vnoise2(seed + 23, nx * 1.1, ny * 1.1)));
    };
    const out = new Uint8ClampedArray(d.length);
    for (let i = 0; i < N; i++) {
      if (reachField.near[i] < 0) continue;
      // Even inside the area the brush touched, do not paint where no ink transferred (dry brush)
      let a = smooth(clamp(extOf(i) / 4, 0, 1)), v = tone;
      if (outline.dist[i] > 0) {
        const m = outline.near[i], ext = extOf(m), dOut = Math.sqrt(outline.dist[i]);
        const slow = Math.max(0.5, slowReach(reachField.near[i])), ratio = Math.sqrt(reachField.dist[i]) / slow;
        // Skip without sampling noise where neither the bleed nor the outline bleed reaches
        const edgeMax = Math.min(edgeWidth, ext * 0.7) * 1.5;
        if (ratio >= 1.11 && dOut >= Math.max(0.5, edgeMax)) continue;
        // The outer edge is broken up finely by the paper grain and fades outward
        // Streaks appear only when the bleed's source is on the nearby outline. The nearby outline's streaks are not laid over a bleed arriving from elsewhere
        const r = reachField.near[i], gap = Math.hypot(r % w - m % w, ((r / w) | 0) - ((m / w) | 0));
        const f = lerp(fiber(m), 0.77, smooth(clamp((gap - 8) / 40, 0, 1)));
        const t = ratio / f + (vnoise2(seed + 37, (ox + i % w) * 0.8, (oy + ((i / w) | 0)) * 0.8) - 0.5) * 0.22;
        a = 1 - smooth(clamp((t - 0.45) / 0.55, 0, 1));
        // Just outside the outline of the area the brush touched, ink close to the body's darkness bleeds a little (its width is broken up by the paper grain; none where there is no bleed)
        const edge = Math.min(edgeWidth, ext * 0.7) * (0.5 + vnoise2(seed + 53, (ox + i % w) * 0.9, (oy + ((i / w) | 0)) * 0.9));
        const e = 1 - smooth(clamp(dOut / Math.max(0.5, edge), 0, 1));
        if (e > 0) { v = lerp(tone, core, e); a = Math.max(a, e); }
      }
      out[i * 4] = v; out[i * 4 + 1] = Math.max(0, v - 3); out[i * 4 + 2] = Math.max(0, v - 6); out[i * 4 + 3] = a * 255;
    }
    img.data.set(out);
    g.putImageData(img, 0, 0);
    return cv;
  }

  // ---------- point parsing ----------
  // [x, y, pressure, angle, speed, pause] — trailing values may be left out, null keeps a slot; "k" anywhere marks a corner.
  // Or {x, y, p, a, v, d, k}.
  function parsePoint(q) {
    if (Array.isArray(q)) {
      const nums = q.filter((v) => typeof v === 'number' || v === null);
      const k = q.includes('k');
      const num = (v) => (typeof v === 'number' ? v : undefined);
      return { x: nums[0], y: nums[1], p: num(nums[2]), a: num(nums[3]), v: num(nums[4]), d: num(nums[5]), k };
    }
    if (!q || typeof q !== 'object') return {}; // An unreadable point has no position, so it is discarded later
    return { x: q.x, y: q.y, p: q.p, a: q.a, v: q.v, d: typeof q.d === 'number' ? q.d : undefined, k: !!q.k };
  }

  // fill a missing per-point value by interpolating between the points that have one
  // (held constant before the first and after the last); `base` when no point has it
  function fillAttr(pts, key, base) {
    const idx = pts.map((p, i) => (typeof p[key] === 'number' ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) { pts.forEach((p) => (p[key] = base)); return; }
    for (let i = 0; i < pts.length; i++) {
      if (typeof pts[i][key] === 'number') continue;
      let a = -1, b = -1;
      for (const j of idx) { if (j < i) a = j; if (j > i && b < 0) b = j; }
      if (a < 0) pts[i][key] = pts[b][key];
      else if (b < 0) pts[i][key] = pts[a][key];
      else pts[i][key] = lerp(pts[a][key], pts[b][key], (i - a) / (b - a));
    }
  }

  // centripetal Catmull-Rom
  function crPiece(P0, P1, P2, P3, out, withFirst) {
    const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
    const t0 = 0, t1 = d(P0, P1), t2 = t1 + d(P1, P2), t3 = t2 + d(P2, P3);
    const chord = Math.hypot(P2.x - P1.x, P2.y - P1.y);
    const n = Math.max(2, Math.ceil(chord / 0.5));
    for (let i = withFirst ? 0 : 1; i <= n; i++) {
      const u = i / n, t = lerp(t1, t2, u);
      const m = (A, B, ta, tb) => {
        const w = (t - ta) / (tb - ta);
        return { x: A.x + (B.x - A.x) * w, y: A.y + (B.y - A.y) * w };
      };
      const A1 = m(P0, P1, t0, t1), A2 = m(P1, P2, t1, t2), A3 = m(P2, P3, t2, t3);
      const B1 = m(A1, A2, t0, t2), B2 = m(A2, A3, t1, t3);
      const C = m(B1, B2, t1, t2);
      out.push({ x: C.x, y: C.y, p: lerp(P1.p, P2.p, u), a: lerp(P1.a, P2.a, u), v: lerp(P1.v, P2.v, u) });
    }
  }

  function splineSegment(pts, out, withFirst, ends) {
    const n = pts.length;
    const at = (i) => {
      if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y, p: pts[0].p, a: pts[0].a, v: pts[0].v };
      if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y, p: pts[n - 1].p, a: pts[n - 1].a, v: pts[n - 1].v };
      return pts[i];
    };
    for (let i = 0; i < n - 1; i++) {
      crPiece(at(i - 1), at(i), at(i + 1), at(i + 2), out, withFirst && i === 0);
      if (ends) ends.push(out.length - 1); // where control point i + 1 landed
    }
  }

  function resample(raw, h) {
    const X = [], Y = [], P = [], A = [], V = [];
    let acc = 0;
    X.push(raw[0].x); Y.push(raw[0].y); P.push(raw[0].p); A.push(raw[0].a); V.push(raw[0].v);
    let next = h;
    const cum = [0];
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      while (L > 0 && next <= acc + L) {
        const t = (next - acc) / L;
        X.push(lerp(a.x, b.x, t)); Y.push(lerp(a.y, b.y, t)); P.push(lerp(a.p, b.p, t)); A.push(lerp(a.a, b.a, t)); V.push(lerp(a.v, b.v, t));
        next += h;
      }
      acc += L; cum.push(acc);
    }
    const last = raw[raw.length - 1];
    if (acc - (next - h) > h * 0.3) { X.push(last.x); Y.push(last.y); P.push(last.p); A.push(last.a); V.push(last.v); }
    return { X, Y, P, A, V, cum };
  }

  // ---------- stroke builder ----------
  // tf: { toPx(x,y)->[X,Y], unit (px per brush unit: 1/14 of twice the declared brush size), R (px: the declared brush size) }
  function buildStroke(cmd, tf, opts) {
    const h = opts.step;
    const R = tf.R;
    let pts = (Array.isArray(cmd.p) ? cmd.p : []).map(parsePoint).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
    if (!pts.length) return null;
    fillAttr(pts, 'p', 1);
    fillAttr(pts, 'v', 1);
    // brush angle: the first point starts at the engine's angle unless it gives one, later points keep the previous
    // angle until one is given, and the angle turns gradually toward it, the shorter way round
    // any direction (degrees, tip → belly: 0 right, 90 down, 180 left, 270 up), so the tip can trail behind the
    // travel along the middle of the line (centered tip) whichever way the stroke goes
    let ang = opts.angle;
    pts.forEach((q, i) => {
      if (typeof q.a === 'number' && Number.isFinite(q.a)) {
        ang = q.a;
        // When more than 180 degrees apart, change to the shorter turn toward the same direction (350 → 10 turns 20 degrees)
        if (i > 0 && Math.abs(ang - pts[i - 1].a) > 180) ang = pts[i - 1].a + ((((ang - pts[i - 1].a) % 360) + 540) % 360) - 180;
      }
      q.a = ang;
    });
    pts = pts.map((q) => {
      const [X, Y] = tf.toPx(q.x, q.y);
      // Pressure is 0–2 (at 1, the same width as the brush size). Internally it is halved to 0–1 (_tf's R treats the brush as twice the size)
      return { x: X, y: Y, p: clamp(q.p, 0, 2) / 2, a: q.a, v: clamp(q.v, 0.05, 6), d: Math.max(0, q.d || 0), k: q.k };
    });
    // a point that repeats the previous one adds its pause and corner mark to it (a press in place)
    pts = pts.reduce((kept, q) => {
      const last = kept[kept.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y) <= 0.01) {
        last.k = last.k || q.k; last.d += q.d; last.p = Math.max(last.p, q.p); return kept;
      }
      kept.push(q);
      return kept;
    }, []);
    if (pts.length === 1) {
      const q = pts[0];
      pts.push({ ...q, x: q.x + 0.05 * R, y: q.y + 0.05 * R, d: 0 });
    }

    // spline through the points; a "k" point is a corner (the curve is not smoothed across it)
    const segs = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      cur.push(pts[i]);
      if (pts[i].k && i < pts.length - 1) { segs.push(cur); cur = [pts[i]]; }
    }
    segs.push(cur);
    const raw = [];
    const marks = [0]; // raw index of every control point, to place the pauses
    segs.forEach((sg, si) => splineSegment(sg, raw, si === 0, marks));
    const rs = resample(raw, h);
    const n = rs.X.length;
    const S = (k) => k * h;
    // pauses: the arc length of each control point that asks to rest there
    const pauses = [];
    const ctl = segs.flatMap((sg, si) => (si === 0 ? sg : sg.slice(1)));
    ctl.forEach((q, i) => { if (q.d > 0 && marks[i] != null) pauses.push({ s: rs.cum[Math.min(marks[i], rs.cum.length - 1)], d: q.d, p: q.p }); });

    // hand tremor (subtle), seeded by where the stroke enters like the brush shape
    const seed = seedAt(pts[0].x, pts[0].y, opts.scale, 0x5bd1e995);

    const job = {
      x: new Float32Array(n), y: new Float32Array(n), p: new Float32Array(n), t: new Float32Array(n),
      ca: new Float32Array(n), sa: new Float32Array(n), // brush axis direction per sample
      wet: new Float32Array(n), // where ink pools (slow travel, pressing, resting): no dry brush, core spreads
      sx: new Float32Array(n), sy: new Float32Array(n), // footprint offset: the patch lies from the tip toward the belly
      sv: new Float32Array(n), // The speed that decides how ink comes out (the data's speed × KASURE)
      n, h, R, unit: tf.unit,
      start: [pts[0].x, pts[0].y], // where the stroke enters (px); seeds the brush shape
    };
    const v0 = tf.unit * 100 * 1.4; // px / sec at v = 1
    const pr = POOL_RANGE * R; // Extent of pooling (px). R is the declared brush size (px)
    let t = 0;
    for (let k = 0; k < n; k++) {
      const p = Math.max(0, rs.P[k] * (1 + 0.05 * (vnoise(seed, S(k) / (2.5 * R)) - 0.5)));
      const a = (rs.A[k] * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a), v = rs.V[k];
      const vk = v * KASURE;
      job.x[k] = rs.X[k]; job.y[k] = rs.Y[k]; job.p[k] = p; job.sv[k] = vk;
      job.ca[k] = ca; job.sa[k] = sa;
      // the skeleton point is the tip: the patch (radius p·R) lies toward the belly, so a light touch stays on the point
      job.sx[k] = ca * p * R; job.sy[k] = sa * p * R;
      // ink pools where the brush moves slowly with some pressure, and around a pause
      let pool = clamp((0.5 - vk) / 0.35, 0, 1) * smooth(clamp(p / 0.45, 0, 1));
      for (const ps of pauses) { const dd = Math.abs(S(k) - ps.s); if (dd < pr) pool = Math.max(pool, clamp(ps.d / POOL_FULL, 0, 1) * smooth(1 - dd / pr)); }
      job.wet[k] = pool;
      if (k > 0) t += h / (v0 * v);
      // On reaching a paused point, add the time stopped there. For the outline rounding (_drawRound), remember the time the stop began and
      // the sample (a pause on the first point counts too)
      for (const ps of pauses) {
        if (ps.k == null && (k === 0 ? ps.s <= 0 : S(k - 1) < ps.s && S(k) >= ps.s)) { ps.k = k; ps.t0 = t; t += ps.d; }
      }
      job.t[k] = t;
    }
    job.pauses = pauses.filter((ps) => ps.k != null);
    job.duration = t;
    return job;
  }

  // ---------- brush (bristles) ----------
  class Brush {
    constructor(count, seed) {
      const rnd = mulberry32(seed || 1234);
      this.count = count;
      // each line stands for a bundle of hairs: with more lines each gets thinner so the ink coverage stays the same
      this.width = 0.24 * Math.sqrt(110 / count);
      this.u = new Float32Array(count); this.v = new Float32Array(count);
      this.wf = new Float32Array(count); this.cap = new Float32Array(count);
      this.ink = new Float32Array(count); this.edge = new Float32Array(count);
      this.seed = new Int32Array(count); this.tone = new Float32Array(count); this.drain = new Float32Array(count);
      const clumpSeed = (rnd() * 1e9) | 0;
      this.grainSeed = (rnd() * 1e9) | 0;
      const B = 0.68;
      let i = 0;
      while (i < count) {
        const u = rnd() * 2 - 1, v = (rnd() * 2 - 1) * B;
        // teardrop: tip (u=-1) narrower than belly (u=+1)
        const hw = B * Math.sqrt(Math.max(0, 1 - u * u)) * (0.6 + 0.4 * (u + 1) / 2);
        if (Math.abs(v) > hw) continue;
        this.u[i] = u; this.v[i] = v;
        this.edge[i] = clamp(Math.hypot(u, v / B), 0, 1);
        this.wf[i] = 0.75 + rnd() * 0.5;
        // how much ink this bristle takes up when dipped: clumps of richer and poorer bristles across the brush,
        // a little individual scatter, and slightly less at the edge
        const clump = vnoise2(clumpSeed, (u + 1) * 2.2, (v / B + 1) * 2.6) * 2 - 1;
        // the tip (u → -1) holds ink well, so a sweep's point keeps a trace to the end
        this.cap[i] = clamp(1 + 0.25 * clump + 0.12 * (rnd() * 2 - 1) - 0.12 * this.edge[i] * this.edge[i] + 0.18 * Math.max(0, -u), 0.6, 1.4);
        this.seed[i] = (rnd() * 1e9) | 0;
        this.tone[i] = (rnd() - 0.5) * 16; // Per-bristle color variation
        this.drain[i] = 0.7 + 0.6 * rnd(); // how fast it gives its ink to the paper
        i++;
      }
      this.dip(1);
    }
    dip(level) { for (let i = 0; i < this.count; i++) this.ink[i] = this.cap[i] * level * INK_MULT; }
    meanInk() { let sum = 0; for (let i = 0; i < this.count; i++) sum += this.ink[i]; return sum / this.count; }

    // the brush as it touches the paper for one stroke: the same hairs (and the ink each holds), but the bundle
    // settles a little differently every time. Derived only from `seed`, so the same stroke data always gives the
    // same shape.
    variant(seed) {
      const rnd = mulberry32(seed);
      const flat = 0.92 + 0.16 * rnd(); // cross-section width ±8%
      const reach = 0.85 + 0.3 * rnd(); // how far the tip reaches ±15%
      const n = this.count;
      const sh = { u: new Float32Array(n), v: new Float32Array(n), wf: new Float32Array(n), sd: new Int32Array(n) };
      const mix = Math.imul(seed, 2654435761) | 0;
      for (let i = 0; i < n; i++) {
        const u = this.u[i];
        sh.u[i] = clamp((u < 0 ? u * reach : u) + (rnd() - 0.5) * 0.08, -1.2, 1.05);
        sh.v[i] = this.v[i] * flat + (rnd() - 0.5) * 0.06;
        sh.wf[i] = this.wf[i] * (0.88 + 0.24 * rnd());
        sh.sd[i] = this.seed[i] ^ mix; // the hairs meet the paper grain differently too
      }
      return sh;
    }
  }

  // ---------- paper ----------
  // The paper is an image drawn under the ink and cropped to the paper's shape: opts.paper (a URL), or by default
  // paper.webp next to this script; opts.paper = null gives plain paper. Until it has loaded the paper is plain;
  // engines repaint once it arrives. engine.ready resolves when the engine's image has loaded (or failed), and
  // Sho.ready does the same for the default image, for code that exports pictures.
  const PAPER_COLOR = '#f2ebdc';
  const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : location.href;
  const papers = new Map(); // URL → { image, ready, waiting }. Engines with the same paper share one image
  function loadPaper(url) {
    const href = new URL(url, url === 'paper.webp' ? scriptUrl : location.href).href;
    if (papers.has(href)) return papers.get(href);
    const image = new Image(), waiting = new Set();
    const ready = new Promise((resolve) => {
      // engines made before the image arrives are repainted once, then forgotten (no lasting references)
      image.onload = image.onerror = () => { waiting.forEach((e) => e.refresh()); waiting.clear(); resolve(); };
    });
    image.src = href;
    const paper = { image, ready, waiting };
    papers.set(href, paper);
    return paper;
  }
  function drawPaper(g, W, H, image, color) {
    g.fillStyle = color;
    g.fillRect(0, 0, W, H);
    if (!image || !image.complete || !image.naturalWidth) return;
    const iw = image.naturalWidth, ih = image.naturalHeight;
    const k = Math.max(W / iw, H / ih); // cover: fill the paper, crop the overflow evenly
    const sw = W / k, sh = H / k;
    g.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, W, H);
  }

  // ---------- engine ----------
  const T_COMMANDS = new Set(['brush', 'sign', 'dip', 'wait']); // Commands written as {"t":…}
  // strokes are given in paper coordinates (1000 × 1376 by default: opts.width, opts.height)
  class Shodo {
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      // Defaults. The work's brush and ink (set by brush declarations) are held per work by _resetWork and are not written back here
      this.opts = Object.assign({
        pxPerUnit: 1,       // internal px per paper unit
        paper: 'paper.webp', // Paper image URL (the default is paper.webp next to sho.js). null gives plain paper
        paperColor: PAPER_COLOR, // Plain paper color (used when paper is null, and while the image is loading or if it fails to load)
        width: 1000, height: 1376, // Paper size (paper units)
        brushSize: 40,      // default brush (paper units: the line width at pressure 1), used when the writer declares none
        angle: 42,          // brush axis angle (deg, tip→belly), screen coords
        bristles: 300,
        inkLoad: 1,         // Ink amount: how much ink each dip loads (with speed and pressure it decides dry brush). It does not change the tone
        inkTone: 1,         // Ink darkness (0–1): 1 is black dark ink, lower is gray pale ink. Paler ink holds more water, rounds at pauses and bleeds past the line
        inkRate: 1,         // How fast ink runs out
        mottle: MOTTLE_DEPTH,       // Depth of the dry-brush mottle (0 for none)
        mottleSize: MOTTLE_SIZE,    // Multiplier for the size of the dry-brush mottle
        mottleContrast: MOTTLE_CONTRAST, // Contrast of the dry-brush mottle
        bleed: 'capillary', // Pale ink bleed: 'capillary' (spreads radially by capillary action) or 'ring' (a band with a darker rim)
        speed: 1,           // animation speed
        autoDip: true,      // When to reload the brush: 'char' (same as true), 'stroke', 'dry' (when it runs out) or false
        autoDipEvery: 1,    // With 'char' or 'stroke': reload at every this many characters or strokes
        instant: false,
      }, options || {});
      this.queue = [];
      this.listeners = {};
      this.brush = new Brush(this.opts.bristles, 20240930);
      this._last = null;
      this._running = false;
      this._paper = this.opts.paper ? loadPaper(this.opts.paper) : null;
      this.ready = this._paper ? this._paper.ready : Promise.resolve();
      if (this._paper && !this._paper.image.complete) this._paper.waiting.add(this);
      this._resetWork();
      this.setPaper(this.opts.width, this.opts.height);
    }

    // Resets the work's brush and ink (set by brush declarations) to the defaults. Called when clearing the paper
    _resetWork() {
      this.brushSize = null;              // the work's brush, fixed by its declaration or by its first stroke
      this.inkTone = this.opts.inkTone;   // Ink darkness
      this.inkLoad = this.opts.inkLoad;   // Ink amount
      this.inkRate = this.opts.inkRate;   // How fast ink runs out
      this.bristles = this.opts.bristles; // Bristle density (the count at size 60)
      this.angle = this.opts.angle;       // Default brush angle
      this._dipCount = 0;                 // Characters or strokes counted for autoDipEvery
    }

    // the frame loop runs only while something is queued, being drawn or waiting to be shown.
    // rAF drives it; a timer keeps it going where rAF is throttled (headless, occluded windows).
    get dirty() { return this._dirty; }
    set dirty(v) { this._dirty = v; if (v) this._wake(); }
    refresh() { this._baseDirty = true; this.dirty = true; } // Redraws everything, for example when the paper image arrives
    _wake() {
      if (this._running || this._destroyed) return;
      this._running = true;
      this._last = null;
      const step = () => {
        if (!this._running) return;
        this._tick(performance.now());
        if (!this.busy && !this._dirty) { this._stop(); return; }
        cancelAnimationFrame(this._raf); // So that a call from the timer does not double up with the one already waiting
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
      this._timer = setInterval(() => { if (this._running && performance.now() - (this._last || 0) > 80) step(); }, 40);
    }
    _stop() {
      this._running = false;
      cancelAnimationFrame(this._raf);
      clearInterval(this._timer);
    }
    // stop the loop for good (the canvas keeps its last picture)
    destroy() { this._destroyed = true; this._stop(); this.queue.length = 0; if (this._paper) this._paper.waiting.delete(this); }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    emit(ev, a) { (this.listeners[ev] || []).forEach((f) => f(a)); }

    setPaper(w, h) {
      this.paper = { w, h };
      const s = this.opts.pxPerUnit;
      const W = Math.round(w * s), H = Math.round(h * s);
      if (W !== this.W || H !== this.H) {
        // new size: (re)create the layers; the same size just clears them
        this.W = W; this.H = H;
        this.canvas.width = W; this.canvas.height = H;
        const layer = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
        this.inkCanvas = layer(); this.ink = this.inkCanvas.getContext('2d');   // Strokes drawn so far
        this.mixCanvas = layer(); this.mix = this.mixCanvas.getContext('2d');   // Work layer that combines the current stroke's layers
        // Layers of the stroke being drawn (combined by _mixStroke; when it is finished, _commit lays them onto ink and clears them)
        this.strokeCanvas = layer(); this.stroke = this.strokeCanvas.getContext('2d');          // Bristle lines
        this.coreCanvas = layer(); this.core = this.coreCanvas.getContext('2d');                // Ink core
        this.roundCanvas = layer(); this.round = this.roundCanvas.getContext('2d');             // Areas rounded by pauses
        this.fringeCanvas = layer(); this.fringe = this.fringeCanvas.getContext('2d');          // Pale ink bleed (inner part)
        this.fringeRimCanvas = layer(); this.fringeRim = this.fringeRimCanvas.getContext('2d'); // Rim of the pale ink bleed
        this.baseCanvas = layer(); this.base = this.baseCanvas.getContext('2d');                // Paper + the strokes so far (_composite)
      } else {
        this.ink.clearRect(0, 0, W, H);
        this._clearStroke();
      }
      this._box = null;       // Area drawn on the current stroke's layers ([x0, y0, x1, y1] px)
      this._shown = null;     // Area where the previous frame overlaid the current stroke on the screen
      this._baseDirty = true; // Rebuild base (the paper or the earlier strokes changed)
      this.job = null; this.pending = null; this.wait = 0; this.lastEnd = null;
      this.brush.dip(this.inkLoad);
      this.dirty = true;
    }
    // Clears the current stroke's layers (only that area if box is given)
    _clearStroke(box) {
      const [x0, y0, x1, y1] = box || [0, 0, this.W, this.H];
      for (const g of [this.stroke, this.core, this.round, this.fringe, this.fringeRim]) g.clearRect(x0, y0, x1 - x0, y1 - y0);
    }

    clear() { this.queue.length = 0; this._wasBusy = false; this._resetWork(); this.setPaper(this.paper.w, this.paper.h); }

    _tf() {
      const s = this.opts.pxPerUnit;
      // the brush is absolute (paper units); it also sets the scale of speed, ink use and paper grain
      if (this.brushSize == null) this.brushSize = this.opts.brushSize;
      // Thicker brushes have more bristles (the density stays constant at this.bristles). When the size or density changes, rebuild the brush and load it with ink
      const count = clamp(Math.round((this.bristles * this.brushSize) / REF_SIZE), 20, 1000);
      if (this.brush.count !== count) { this.brush = new Brush(count, 20240930); this.brush.dip(this.inkLoad); }
      // Calculated as a brush twice the declared size (the line width at pressure 1), with the pressure halved (buildStroke).
      // That way pressure 1 gives a line as wide as the declared size, while the scales of speed, ink and paper grain match a brush whose standard pressure is 0.5
      const full = this.brushSize * 2;
      return { unit: (full / 14) * s, R: (full / 2) * s, toPx: (x, y) => [x * s, y * s] };
    }

    // ---- queue API ----
    enqueue(cmd) {
      if (Array.isArray(cmd)) { cmd.forEach((c) => this.enqueue(c)); return; }
      if (!cmd || typeof cmd !== 'object') return;
      this.queue.push(cmd);
      if (this.opts.instant) this.flush();
      else this._wake();
    }

    // draw everything queued immediately (no animation)
    flush() {
      if (this.job) this._finishJob();
      if (this.pending) { this._drawWhole(this.pending); this.pending = null; }
      while (this.queue.length) {
        const job = this._exec(this.queue.shift());
        if (job) this._drawWhole(job);
      }
      this.wait = 0;
      this.dirty = true;
    }

    get busy() { return !!this.job || !!this.pending || this.queue.length > 0 || this.wait > 0; }

    _type(cmd) {
      if (cmd.t) return T_COMMANDS.has(cmd.t) ? cmd.t : '?';
      if (cmd.p) return 'stroke';
      if (cmd.c != null) return 'char';
      if (cmd.dip != null) return 'dip';
      return '?';
    }

    // Reloads the brush if autoDip says to at this moment ('char' or 'stroke' at their turn, 'dry' when it has run out).
    // Returns whether it did
    _autoDip(moment) {
      const mode = this.opts.autoDip === true ? 'char' : this.opts.autoDip;
      if (mode !== moment) return false;
      if (mode === 'dry') { if (this.brush.meanInk() >= DRY_INK) return false; }
      else if (this._dipCount++ % Math.max(1, Math.floor(this.opts.autoDipEvery) || 1) !== 0) return false;
      this.brush.dip(this.inkLoad);
      return true;
    }

    // execute a command; returns a stroke job for a stroke
    _exec(cmd) {
      const t = this._type(cmd);
      this.emit('command', cmd);
      switch (t) {
        case 'char':
          this._autoDip('char');
          this.wait += 0.35;
          return null;
        // {"dip":0.4} loads that much ink; {"t":"dip"} loads the work's usual amount (ink amount)
        case 'dip': this.brush.dip(typeof cmd.dip === 'number' ? cmd.dip : this.inkLoad); this.wait += 0.3; return null;
        case 'sign': this._sign(String(cmd.text || '').slice(0, 60), cmd.dir || 'v'); this.wait += 0.4; return null;
        case 'wait': this.wait += (typeof cmd.ms === 'number' ? Math.max(0, cmd.ms) : 300) / 1000; return null;
        case 'brush': {
          // {"t":"brush","size":80,"ink_tone":0.6,"ink_load":1}: the brush in paper units, with ink darkness and ink amount (both
          // optional). It holds until the next declaration, so the brush can be changed at any time. A declaration means taking up
          // a brush, so each one loads it with ink
          if (cmd.size > 0) this.brushSize = cmd.size;
          else if (this.brushSize == null) this.brushSize = this.opts.brushSize; // Even a declaration without a size settles the brush here
          if (typeof cmd.ink_tone === 'number') this.inkTone = clamp(cmd.ink_tone, 0.05, 1);
          if (typeof cmd.ink_load === 'number') this.inkLoad = clamp(cmd.ink_load, 0.1, 1.5);
          if (typeof cmd.ink_rate === 'number') this.inkRate = clamp(cmd.ink_rate, 0, 4);
          if (typeof cmd.bristles === 'number') this.bristles = clamp(cmd.bristles, 20, 1000);
          if (typeof cmd.a === 'number') this.angle = cmd.a;
          this.brush.dip(this.inkLoad);
          return null;
        }
        case 'stroke': {
          const job = buildStroke(cmd, this._tf(), { step: 0.7, angle: this.angle, scale: this.opts.pxPerUnit });
          if (job) {
            if (this._autoDip('stroke') || this._autoDip('dry')) this.wait += 0.3;
            job.shape = this.brush.variant(seedAt(job.start[0], job.start[1], this.opts.pxPerUnit));
            job.plan = this._plan(job);
          }
          return job;
        }
        default: return null;
      }
    }

    // Draws the stroke from start to end and lays it over the earlier strokes (instant rendering, and the end of an animated stroke)
    _drawWhole(job) {
      this._drawRange(job, 0, job.n - 1);
      this._drawRound(job, Infinity);
      // The capillary bleed is built after the line is drawn, from the shape of the drawn line
      const pl = job.plan, b = job.box;
      if (pl && pl.capillary && b && pl.FE.length) {
        const halo = capillaryHalo(pl.FE, b, this.opts.pxPerUnit, pl.fseed, pl.fringeTone, pl.coreTone, pl.edgeWidth, [this.strokeCanvas, this.coreCanvas, this.roundCanvas]);
        this.fringe.drawImage(halo, b[0], b[1], b[2] - b[0], b[3] - b[1]);
      }
      this._commit();
    }

    // Decides and records how to draw the stroke from start to end in one go (once, when _exec makes the stroke): bristle lines (points, width and color for
    // each piece), the ellipses of the ink core and pale ink bleed, and the rectangle to draw in (job.box). The brush's ink also runs down to the end of the stroke here.
    // Animation draws the record little by little as the brush advances (_drawRange), and instant rendering draws all of it. Ink is calculated
    // only this once, and the end of an animated stroke (_finishJob) only has to repaint the record
    _plan(job) {
      const b = this.brush, o = this.opts;
      const n = job.n, last = n - 1;
      const { x, y, p, sv } = job;
      const wet = job.wet, SX = job.sx, SY = job.sy;
      const tone = inkTone(this.inkTone);
      const CA = job.ca, SA = job.sa; // brush axis per sample (the angle may turn along the stroke)
      const sh = job.shape;
      const freq = 0.06;
      // Area to draw (px). Includes where bristle lines, the core, the bleed and pause rounding reach
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      const grow = (cx, cy, r) => { if (cx - r < bx0) bx0 = cx - r; if (cy - r < by0) by0 = cy - r; if (cx + r > bx1) bx1 = cx + r; if (cy + r > by1) by1 = cy + r; };
      const D = Math.max(1, Math.round(2 / job.h)); // a line point (and a grain sample) about every 2 px
      // The grain is fixed to the paper: with the brush size's ratio to the reference, more cells line up across the brush, and cells along the direction of travel get finer
      const sizeRatio = job.R / (REF_SIZE * o.pxPerUnit);
      // Fineness of dry-brush streaks: the number (half of it) of grain cells across the brush. Proportional to brush size and also to the square root of bristle density
      // (bristle lines thin with the square root, so the number of lines in one streak stays about constant). 7 at the reference size with 200 bristles
      const latFreq = 7 * Math.sqrt(this.bristles / 200) * sizeRatio;
      // The mottle has a different shape for each stroke (seeded from the start position, so the same data gives the same shape)
      const cseed = seedAt(job.start[0], job.start[1], o.pxPerUnit, 0x68e31da4);

      // bristles: gaps give dry brush. Each bristle's line is split into pieces where its width (local pressure, a slow
      // per-bristle wobble) or wetness changes, and it narrows toward the ends of every inked run so streaks taper
      // like hairs.
      // samples per piece: at least 6 px and about a tenth of the brush radius long — width changes within a piece
      // are too small to see
      const G = Math.max(4, Math.round(Math.max(6, 0.1 * job.R) / job.h));
      const T = Math.max(4, (0.55 * job.R) / job.h); // taper length (samples)
      const vis = new Uint8Array(n), back = new Float32Array(n), fwd = new Float32Array(n);
      const inkAt = new Float32Array(n); // Per sample, the total ink held by the bristles (used for the capillary bleed width)
      // Record of bristle lines: width, color and the point range [a, b) for each piece. Each point has a position and its sample number k
      const PX = [], PY = [], PK = [], pieces = [];
      let maxW = 0;
      // travel direction per sample, shared by every bristle
      const TX = new Float32Array(n), TY = new Float32Array(n);
      for (let k = 0; k < n; k++) {
        const [tx, ty] = norm(x[Math.min(last, k + 1)] - x[Math.max(0, k - 1)], y[Math.min(last, k + 1)] - y[Math.max(0, k - 1)]);
        TX[k] = tx; TY[k] = ty;
      }
      for (let i = 0; i < b.count; i++) {
        const ink = b.ink[i], edge = b.edge[i];
        const bu = sh.u[i], bv = sh.v[i], sd = sh.sd[i], wf = sh.wf[i];
        // The color of bristle lines is set by ink darkness (ink amount does not change the color and affects only dry brush)
        const L = clamp(tone.hair + edge * 18 + b.tone[i], 2, 235);
        // pooled ink (wet) darkens the bristle: ink stays dark where it has pooled
        const colour = (w) => inkCss(lerp(L, tone.pool, w));
        // Dry brush comes from each bristle's own ink: the bristle gives ink to the paper sample by sample; while it holds
        // enough its line is continuous, as it runs low it skips where the paper grain is high, and when nearly dry it
        // only touches here and there. Fast travel transfers less ink.
        // bristle position = sample + (bristle offset rotated by the brush axis at that sample) × radius
        const offX = (k) => bu * CA[k] - bv * SA[k], offY = (k) => bu * SA[k] + bv * CA[k];
        const dep = (job.h / job.unit) * 0.0011 * this.inkRate * b.drain[i] * (0.8 + 0.5 * edge);
        let inkK = ink, grain = 0, mottle = 1;
        for (let k = 0; k < n; k++) {
          // The faster the brush, the less ink reaches the paper (looked up in the table by the data's speed)
          const transfer = transferAt(sv[k] / KASURE);
          // the tip's hairs keep touching while the brush lifts, so a thin hairline runs on to the end
          const tipHold = bu < -0.4 ? clamp((0.3 - p[k]) / 0.3, 0, 1) * 0.6 : 0;
          // the paper grain is shared by every bristle that passes the same line across the stroke (its offset
          // across the travel direction), so dry patches open as narrow streaks running along the stroke.
          // It changes slowly, so it is sampled on every D-th sample of the stroke.
          if (k % D === 0) {
            const lat = offX(k) * -TY[k] + offY(k) * TX[k];
            const sg = (k * job.h) / job.unit, sp = sg * sizeRatio; // Distance from the start of the stroke (in brush units, and in units fixed to the paper)
            grain = 0.7 * vnoise2(b.grainSeed, (lat + 1) * latFreq, sp * freq * 0.7) + 0.3 * fnoise(sd, sp * freq * 1.6);
            // Dry-brush mottle: where the mottle is dense, less ink reaches the paper and it goes drier; where it is light, more reaches it and the line joins up
            if (o.mottle > 0) mottle = 1 + o.mottle * (1 - 2 * mottleAt(cseed, lat, sg, o.mottleSize, o.mottleContrast));
          }
          // Pooled ink (wet) and the tip hairs (tipHold) remain regardless of the mottle
          const eff = inkK * transfer * mottle + wet[k] + tipHold;
          vis[k] = eff - 0.55 * grain > 0.1 ? 1 : 0;
          inkAt[k] += inkK;
          if (k > 0) inkK = Math.max(0, inkK - dep * p[k]);
        }
        // Length of the continuous line (backward and forward). At the ends of the stroke the line counts as continuing, so it does not thin there
        for (let k = 0; k < n; k++) back[k] = vis[k] ? (k && vis[k - 1] ? back[k - 1] + 1 : (k === 0 ? T : 1)) : 0;
        for (let k = last; k >= 0; k--) fwd[k] = vis[k] ? (k < last && vis[k + 1] ? fwd[k + 1] + 1 : (k === last ? T : 1)) : 0;
        const widthAt = (k) => {
          const s = (k * job.h) / job.unit;
          const taper = smooth(clamp(Math.min(back[k], fwd[k]) / T, 0, 1));
          const wobble = 0.7 + 0.6 * fnoise(sd + 101, s * 0.16);
          return Math.max(0.6, p[k] * job.R * b.width * wf * wobble * (0.25 + 0.75 * taper));
        };
        let r = p[0] * job.R * (1 + 0.06 * (fnoise(sd + 7, 0) - 0.5));
        let px = x[0] + SX[0] + offX(0) * r, py = y[0] + SY[0] + offY(0) * r;
        // a piece continues while its width and wetness stay within 8% of where it started (width changes slowly,
        // so most pieces run long); it is cut at least every G·8 samples
        let open = false, cnt = 0, wsum = 0, wetsum = 0, w0 = 0, wet0 = 0, start = 0, lastK = 0;
        // Start of a piece: begins the line from the previous point (px, py)
        const begin = () => { start = PX.length; PX.push(px); PY.push(py); PK.push(lastK); };
        const flush = () => {
          if (cnt) { const w = wsum / cnt; pieces.push({ w, col: colour(wetsum / cnt), a: start, b: PX.length }); if (w > maxW) maxW = w; }
          cnt = 0; wsum = 0; wetsum = 0;
        };
        for (let k = 1; k <= last; k++) {
          const v = vis[k];
          // only every D-th sample, the last one and the samples where an inked run starts or ends get a point
          if (v && open && k < last && k % D !== 0 && vis[k + 1]) continue;
          const s = (k * job.h) / job.unit;
          r = p[k] * job.R * (1 + 0.06 * (fnoise(sd + 7, s * 0.08) - 0.5));
          const X = x[k] + SX[k] + offX(k) * r, Y = y[k] + SY[k] + offY(k) * r;
          if (v) {
            if (!open) { begin(); open = true; }
            const w = widthAt(k);
            if (cnt === 0) { w0 = w; wet0 = wet[k]; }
            else if (cnt >= G && (Math.abs(w - w0) > 0.08 * w0 || Math.abs(wet[k] - wet0) > 0.08 || cnt >= G * 8)) {
              flush(); begin(); w0 = w; wet0 = wet[k];
            }
            PX.push(X); PY.push(Y); PK.push(k);
            wsum += w; wetsum += wet[k]; cnt++;
          } else if (open) { flush(); open = false; }
          px = X; py = Y; lastK = k;
        }
        if (open) flush();
        b.ink[i] = clamp(inkK, 0, 1.5) || 0;
      }
      for (let i = 0; i < PX.length; i++) grow(PX[i], PY[i], maxW / 2 + 1);

      // wet core: rotated ellipses that fill the gaps between bristles; they shrink as the brush speeds up or dries,
      // leaving only bristles
      const inkMean = b.meanInk();
      // Record of the ellipses of the ink core and pale ink bleed: sample number k and the ellipse (center cx, cy, axis direction ca, sa, radii ax, bx, angle)
      const CK = [], CE = [], FK = [], FE = [];
      // Pale ink bleed (regardless of pauses, outward along the line): wider for paler ink. No bleed where the line is dry (so the gaps do not fill with pale ink
      // and the dry brush does not vanish).
      // 'ring': a band that is wider where writing is slower. Its edge undulates slightly, and a slightly darker rim remains at the outer boundary (the bleed layer = inner part and the rim layer = outer part are
      // painted separately and layered in _mixStroke). 'capillary': the ellipses only record the width, and capillaryHalo builds the bleed after the stroke is finished
      const bleed = FRINGE * (1 - tone.d);
      const fringe = bleed > 0.005;
      const capillary = fringe && o.bleed === 'capillary';
      const fseed = seedAt(job.start[0], job.start[1], o.pxPerUnit, 0x27d4eb2d);
      // Width of the capillary bleed (px): proportional to the ink transferred to the paper (remaining ink × share transferred + pooling), and
      // no bleed where the line is dry and hardly any ink has transferred
      const capillaryExt = (k) => {
        const deposit = (inkAt[k] / b.count) * transferAt(sv[k] / KASURE) + wet[k];
        return bleed * job.R * (0.75 + 0.5 * fnoise(fseed, ((k * job.h) / job.unit) * 0.06)) * deposit * smooth(clamp((deposit - 0.15) / 0.4, 0, 1));
      };
      for (let k = 0; k <= last; k++) {
        const wetness = inkMean * 1.2 - Math.max(0, sv[k] - 1) * 0.7;
        const cf = Math.max(clamp((wetness - 0.3) / 0.55, 0, 1), wet[k]);
        // The capillary bleed is the source of the body's shape, so every sample is used to avoid missing the pressure peak of a short dot
        if (fringe && (capillary || k % D === 0 || k === last)) {
          const rr = p[k] * job.R; // Radius of the brush mark
          const slow = clamp(1.4 - 0.3 * sv[k], 0.6, 1.4);
          const ext = capillary ? capillaryExt(k) : bleed * job.R * slow * (0.75 + 0.5 * fnoise(fseed, ((k * job.h) / job.unit) * 0.06)) * cf; // Width spreading outward (px)
          if (rr > 0.5 && (capillary || ext > 0.5)) {
            const ca = CA[k], sa = SA[k], cx = x[k] + SX[k], cy = y[k] + SY[k], ang = Math.atan2(sa, ca);
            const ax = rr * 0.95 + ext, bx = rr * 0.7 + ext;
            const rimW = Math.max(0.8, Math.min(ext * 0.3, 2 * o.pxPerUnit)); // Thickness of the rim
            FK.push(k); FE.push(cx, cy, ca, sa, ax, bx, ang, rimW, ext);
            // Reach of the capillary bleed: outer edge of the bristle lines (1.25 × the brush mark's radius) + maximum bleed length (up to 1.11 × with the roughness of the outer edge)
            grow(cx, cy, capillary ? rr * 1.25 + ext * CAPILLARY_REACH * 1.11 : ax);
          }
        }
        // where ink pools the core grows a little and leans to the belly side
        const r = p[k] * job.R * cf * (1 + 0.06 * wet[k]);
        // ellipses wider than a few px overlap heavily, so only every D-th one is needed
        if (r < 0.5 || (r > 3 && k % D !== 0 && k !== last)) continue;
        const e = footEllipse(job, k, r, wet[k], 0);
        CK.push(k); CE.push(e.cx, e.cy, e.ca, e.sa, e.ax, e.bx, e.ang);
        grow(e.cx, e.cy, e.ax);
      }
      // The capillary bleed's body also includes the pause balls (the same shape as the finish of _drawRound). Without them the balls hide the bleed
      if (capillary) {
        for (const ps of job.pauses) {
          const rd = roundOf(job, ps, ps.d, tone);
          for (let j = rd.lo; j <= rd.hi; j++) {
            const w = rd.weight(j), r = p[j] * job.R;
            if (r < 0.5 || w <= 0.01) continue;
            const e = footEllipse(job, j, r, w, w), g = rd.swell(w), ext = capillaryExt(j);
            FK.push(j); FE.push(e.cx, e.cy, e.ca, e.sa, e.ax * g + ext, e.bx * g + ext, e.ang, 0, ext);
            grow(e.cx, e.cy, e.ax * g + ext * CAPILLARY_REACH * 1.11);
          }
        }
      }
      // Areas rounded by pauses (_drawRound. Fully rounded, they swell to about 1.4 × the brush mark)
      for (const ps of job.pauses) {
        const rd = roundOf(job, ps, ps.d, tone);
        for (let j = rd.lo; j <= rd.hi; j++) grow(x[j] + SX[j], y[j] + SY[j], 1.6 * p[j] * job.R);
      }
      // Expand by as far as the compositing blur (_composite) reaches, and fit to the paper
      const pad = Math.ceil(o.pxPerUnit * 1.8 * 3) + 2;
      const box = [Math.max(0, Math.floor(bx0 - pad)), Math.max(0, Math.floor(by0 - pad)), Math.min(this.W, Math.ceil(bx1 + pad)), Math.min(this.H, Math.ceil(by1 + pad))];
      job.box = box[2] > box[0] && box[3] > box[1] ? box : null;
      return {
        capillary, fseed, fringeTone: tone.fringe, coreTone: tone.core, edgeWidth: CAPILLARY_EDGE * (1 - tone.d),
        pieces, PX: Float64Array.from(PX), PY: Float64Array.from(PY), PK: Int32Array.from(PK),
        CK: Int32Array.from(CK), CE: Float64Array.from(CE), FK: Int32Array.from(FK), FE: Float64Array.from(FE),
        fringe, coreCss: tone.coreCss, rimCss: tone.rimCss, fringeCss: tone.fringeCss,
      };
    }

    // From the record (_plan), adds the part after sample k0 up to k1 to the current stroke's layers (from the start if k0 is 0 or less)
    _drawRange(job, k0, k1) {
      const pl = job.plan;
      if (!pl || k1 <= k0) return;
      const from = k0 <= 0 ? -1 : k0;
      this._box = job.box;
      // Bristle lines: for each piece, joins the points in range (continuing from the last point of the previous part)
      const ctx = this.stroke, { PX, PY, PK } = pl;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const pc of pl.pieces) {
        if (PK[pc.a] >= k1 || PK[pc.b - 1] <= from) continue;
        let s = pc.a; while (s + 1 < pc.b && PK[s + 1] <= from) s++;
        let e = s; while (e + 1 < pc.b && PK[e + 1] <= k1) e++;
        if (e === s) continue;
        ctx.beginPath(); ctx.moveTo(PX[s], PY[s]);
        for (let i = s + 1; i <= e; i++) ctx.lineTo(PX[i], PY[i]);
        ctx.lineWidth = pc.w; ctx.strokeStyle = pc.col; ctx.stroke();
      }
      // Ink core and pale ink bleed: fills the ellipses in range together
      const first = (K) => { let lo = 0, hi = K.length; while (lo < hi) { const m = (lo + hi) >> 1; if (K[m] <= from) lo = m + 1; else hi = m; } return lo; };
      const { CK, CE, FK, FE } = pl;
      const cc = this.core;
      cc.fillStyle = pl.coreCss;
      cc.beginPath();
      let any = false;
      for (let i = first(CK); i < CK.length && CK[i] <= k1; i++) {
        const o = i * 7;
        addEllipse(cc, CE[o], CE[o + 1], CE[o + 2], CE[o + 3], CE[o + 4], CE[o + 5], CE[o + 6]);
        any = true;
      }
      if (any) cc.fill();
      if (pl.fringe && !pl.capillary) {
        const fp = new Path2D(), rp = new Path2D();
        for (let i = first(FK); i < FK.length && FK[i] <= k1; i++) {
          const o = i * 9, cx = FE[o], cy = FE[o + 1], ca = FE[o + 2], sa = FE[o + 3], ax = FE[o + 4], bx = FE[o + 5], ang = FE[o + 6], rimW = FE[o + 7];
          addEllipse(rp, cx, cy, ca, sa, ax, bx, ang);
          addEllipse(fp, cx, cy, ca, sa, ax - rimW, bx - rimW, ang);
        }
        this.fringeRim.fillStyle = pl.rimCss; this.fringeRim.fill(rp);
        this.fringe.fillStyle = pl.fringeCss; this.fringe.fill(fp);
      }
      this.dirty = true;
    }

    // Signature: the text in ink at the bottom-left of the paper (top to bottom for vertical writing)
    _sign(text, dir) {
      if (!text) return;
      const g = this.ink, s = this.opts.pxPerUnit;
      const { w, h } = this.paper;
      const size = Math.round(Math.min(w, h) * 0.026 * s);
      const margin = Math.min(w, h) * 0.045 * s;
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = 'rgb(28,24,21)';
      g.font = `700 ${size}px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif`;
      g.textBaseline = 'alphabetic';
      if (dir === 'v') {
        // rotated 90° clockwise, reading top to bottom, ending at the bottom margin
        const len = g.measureText(text).width;
        g.translate(margin + size * 0.2, this.H - margin - len);
        g.rotate(Math.PI / 2);
        g.fillText(text, 0, 0);
      } else {
        g.fillText(text, margin, this.H - margin);
      }
      g.restore();
      this._baseDirty = true;
      this.dirty = true;
    }

    // A pause rounds the outline: while the brush is stopped, ink pools, and the brush mark (a slanted ellipse with gaps between the hair tips)
    // fills with ink, approaches a circle while keeping a crisp edge, and swells a little. The amount of rounding q = 1 - exp(-elapsed/ROUND_TAU)
    // advances with the time stopped (fast at first, then gradually slower), and also reaches weakly before and after the paused point (ROUND_REACH).
    // The paler the ink (more water) and the harder the press, the faster it rounds and the more it swells (the elapsed time is multiplied by factors for ink darkness and pressure).
    // Ink amount (dry brush) plays no part.
    // Pooled ink gets paler as it spreads outward, so it stays dark up to the size of the original brush mark and gets paler from there toward the edge
    // (the edge stays crisp. As rounding advances, the paleness of the edge goes up to ROUND_RIM).
    // Drawn on its own layer and layered with "keep the darker" (the body of the line already drawn keeps its darkness, and only the gaps and the outside fill in).
    // The layer holds only the stroke being drawn and is redrawn every time. Draws what has elapsed up to time (during animation the outline rounds while
    // the brush is stopped. Infinity draws all of the pause)
    _drawRound(job, time) {
      const g = this.round, bx = job.box;
      if (!bx || !job.pauses.length) return;
      g.clearRect(bx[0], bx[1], bx[2] - bx[0], bx[3] - bx[1]);
      const { p } = job;
      const tone = inkTone(this.inkTone);
      for (const ps of job.pauses) {
        const e = clamp(time - ps.t0, 0, ps.d);
        if (!(e > 0)) continue;
        const k = ps.k, pk = ps.p, rd = roundOf(job, ps, e, tone), q = rd.q;
        const path = new Path2D();
        let any = false;
        // The center of the darkness is the center of the brush mark at the paused point, and the outer reference is the radius of the rounded circle there (the parts stretched before and after overlap the body)
        const rk = pk * job.R;
        const center = footEllipse(job, k, rk, q, q);
        const outer = rk * lerp(FOOT_A, 1, q) * rd.swell(q);
        for (let j = rd.lo; j <= rd.hi; j++) {
          const w = rd.weight(j); // Amount of rounding at this point
          const r = p[j] * job.R;
          if (r < 0.5 || w <= 0.01) continue;
          // Starting from the same ellipse as the ink core, moves it toward a circle and swells it
          const fe = footEllipse(job, j, r, w, w), g = rd.swell(w);
          addEllipse(path, fe.cx, fe.cy, fe.ca, fe.sa, fe.ax * g, fe.bx * g, fe.ang);
          any = true;
        }
        if (!any || outer < 1) continue;
        // Up to the original brush mark (long radius FOOT_A·rk), the same darkness as the body of the line (where ink has pooled). From there toward the edge,
        // it approaches the paper color
        const inner = clamp((FOOT_A * rk) / outer, 0, 0.98);
        const base = tone.body;
        const rim = Math.round(lerp(base, 255, ROUND_RIM * q));
        const grad = g.createRadialGradient(center.cx, center.cy, 0, center.cx, center.cy, outer);
        grad.addColorStop(0, inkCss(base));
        grad.addColorStop(inner, inkCss(base));
        grad.addColorStop(1, inkCss(rim));
        g.fillStyle = grad;
        g.fill(path);
      }
      this.dirty = true;
    }

    // Combines the current stroke's layers (bleed, bristle lines, ink core, rounded areas) into one sheet (only the box area). Within a stroke they are layered with
    // "keep the darker": it is the same ink, so where bristles and core overlap it does not get twice as dark (multiplying would leave a dark streak over just the core area
    // in pale ink). The core fills the gaps between bristles, and the rounded areas fill the outside. The combined stroke is multiplied onto the paper (and the earlier strokes)
    _mixStroke(box) {
      const m = this.mix, [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
      const put = (c) => m.drawImage(c, x0, y0, w, h, x0, y0, w, h);
      m.globalCompositeOperation = 'source-over';
      m.clearRect(x0, y0, w, h);
      // The pale ink bleed goes at the very bottom (the inner part is laid over the rim, so the rim shows only at the outer boundary)
      put(this.fringeRimCanvas);
      put(this.fringeCanvas);
      m.globalCompositeOperation = 'darken';
      put(this.strokeCanvas);
      put(this.coreCanvas);
      put(this.roundCanvas);
      m.globalCompositeOperation = 'source-over';
      return this.mixCanvas;
    }

    // Multiplies the current stroke onto the earlier strokes (ink gets darker the more it is layered). The current stroke's layers are cleared
    _commit() {
      const box = this._box;
      if (box) {
        const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
        const g = this.ink;
        g.globalCompositeOperation = 'multiply';
        g.drawImage(this._mixStroke(box), x0, y0, w, h, x0, y0, w, h);
        g.globalCompositeOperation = 'source-over';
        this._clearStroke(box);
      }
      this._box = null;
      this._baseDirty = true;
      this.dirty = true;
    }

    // end of an animated stroke: the frames drew its plan bit by bit. Draw the whole plan once more from its start,
    // the same way an instant render does (only the drawing, not the ink: the plan is kept), so the finished picture
    // does not depend on the frame rate — drawing it in pieces doubles the soft edge where the pieces meet
    _finishJob() {
      const job = this.job;
      this.job = null;
      if (job.box) this._clearStroke(job.box);
      this._drawWhole(job);
      this.lastEnd = [job.x[job.n - 1], job.y[job.n - 1]];
    }

    _tick(ts) {
      const dt = this._last == null ? 0 : Math.min(0.1, (ts - this._last) / 1000);
      this._last = ts;
      if (!this.opts.instant) this._advance(dt * this.opts.speed);
      if (this.dirty) { this._composite(); this.dirty = false; }
    }

    _advance(dt) {
      let budget = dt;
      let guard = 0;
      while (budget > 0 && guard++ < 1000) {
        if (this.job) {
          const job = this.job;
          this.jobTime += budget; budget = 0;
          let k = this.jobK;
          while (k < job.n - 1 && job.t[k + 1] <= this.jobTime) k++;
          if (k > this.jobK) { this._drawRange(job, this.jobK, k); this.jobK = k; }
          if (job.pauses.length) this._drawRound(job, this.jobTime); // The outline rounds while the brush is stopped
          if (k >= job.n - 1) {
            budget = this.jobTime - job.duration;
            this._finishJob();
            this.wait += 0.12;
          }
          continue;
        }
        if (this.wait > 0) {
          const w = Math.min(this.wait, budget);
          this.wait -= w; budget -= w;
          continue;
        }
        if (this.pending) { this.job = this.pending; this.pending = null; this.jobK = 0; this.jobTime = 0; continue; }
        if (!this.queue.length) { if (this._wasBusy) { this._wasBusy = false; this.emit('idle'); } break; }
        this._wasBusy = true;
        // Take a breath before the signature (the interval between finishing the writing and adding the signature)
        if (this.queue[0] !== this._signWaited && this._type(this.queue[0]) === 'sign') { this._signWaited = this.queue[0]; this.wait += 0.5; continue; }
        const job = this._exec(this.queue.shift());
        if (job) {
          // air travel time from previous stroke end
          if (this.lastEnd) {
            const d = Math.hypot(job.x[0] - this.lastEnd[0], job.y[0] - this.lastEnd[1]);
            this.wait += Math.min(0.4, d / (job.unit * 100 * 3));
          }
          this.pending = job;
        }
      }
    }

    // Puts it on the screen: multiplies the earlier strokes and the current stroke onto the paper (combined the same way as _commit). Also layers a faint blur that softens
    // the edges of the ink (separate from the pale ink bleed FRINGE).
    // The paper and the earlier strokes are baked into one sheet (base) each time a stroke is finished, and each frame redraws only the area of the current stroke
    // (the area where the previous frame overlaid the current stroke also goes back to base). Multiplying does not depend on order, so the picture is the same as layering everything every time
    _composite() {
      const g = this.ctx, W = this.W, H = this.H;
      const blur = `blur(${(this.opts.pxPerUnit * 1.8).toFixed(2)}px)`;
      const multiplyIn = (d, c, x0, y0, w, h) => {
        d.globalCompositeOperation = 'multiply';
        d.globalAlpha = 0.14; d.filter = blur;
        d.drawImage(c, x0, y0, w, h, x0, y0, w, h);
        d.filter = 'none'; d.globalAlpha = 1;
        d.drawImage(c, x0, y0, w, h, x0, y0, w, h);
        d.globalCompositeOperation = 'source-over';
      };
      g.globalAlpha = 1; g.filter = 'none'; g.globalCompositeOperation = 'source-over';
      let area = this._shown;
      if (this._baseDirty) {
        const b = this.base;
        b.globalAlpha = 1; b.filter = 'none'; b.globalCompositeOperation = 'source-over';
        drawPaper(b, W, H, this._paper && this._paper.image, this.opts.paperColor);
        multiplyIn(b, this.inkCanvas, 0, 0, W, H);
        this._baseDirty = false;
        area = [0, 0, W, H];
      }
      const box = this._box;
      if (box) area = area ? [Math.min(area[0], box[0]), Math.min(area[1], box[1]), Math.max(area[2], box[2]), Math.max(area[3], box[3])] : box;
      this._shown = box;
      if (!area) return;
      const [x0, y0, x1, y1] = area, w = x1 - x0, h = y1 - y0;
      g.drawImage(this.baseCanvas, x0, y0, w, h, x0, y0, w, h);
      if (box) {
        const mix = this._mixStroke(box);
        g.save();
        g.beginPath(); g.rect(x0, y0, w, h); g.clip();
        multiplyIn(g, mix, box[0], box[1], box[2] - box[0], box[3] - box[1]);
        g.restore();
      }
    }

    toDataURL() { this._composite(); return this.canvas.toDataURL('image/png'); }
  }

  // ---------- streaming JSONL parser ----------
  // Accepts arbitrary text chunks (e.g., LLM token stream) and emits each complete JSON object line.
  class StreamParser {
    constructor(onCmd, onText) { this.buf = ''; this.onCmd = onCmd; this.onText = onText || (() => {}); }
    feed(chunk) {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        this._line(line);
      }
    }
    end() { if (this.buf.trim()) this._line(this.buf); this.buf = ''; }
    _line(line) {
      const s = line.trim().replace(/,\s*$/, '');
      if (!s) return;
      if (s[0] === '{' || s[0] === '[') {
        try { const v = JSON.parse(s); this.onCmd(v); return; } catch (e) { /* fallthrough */ }
      }
      this.onText(s);
    }
  }

  // parse a whole pasted document: JSON array, JSON object, or JSON Lines
  function parseDocument(text) {
    const t = text.trim();
    if (t[0] === '[') { try { return JSON.parse(t); } catch (e) { /* JSONL with leading array? */ } }
    const out = [];
    const p = new StreamParser((c) => (Array.isArray(c) ? out.push(...c) : out.push(c)));
    p.feed(t + '\n');
    return out;
  }

  global.Sho = { Engine: Shodo, StreamParser, parseDocument, get ready() { return loadPaper('paper.webp').ready; } };
})(window);
