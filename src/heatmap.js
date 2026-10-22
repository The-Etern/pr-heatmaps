// Grid accumulation, blur and colour mapping for map heatmaps.
// World coordinates: x east, z north, metres; the map covers [-512*S, 512*S] on both axes (S = mapSize in km).
// Grid row 0 is the north edge (so it lines up with the map image whose y axis points down).

export const GRID = 512;

function worldToCell(x, z, S, grid = GRID) {
  const half = 512 * S;
  return [((x + half) / (2 * half)) * grid, ((half - z) / (2 * half)) * grid];
}

export function newGrid(grid = GRID) { return new Float32Array(grid * grid); }

/** Add `w` at world position, bilinearly split between the 4 nearest cells. Out-of-map points are dropped. */
export function splat(g, x, z, S, w = 1, grid = GRID) {
  const [cx, cy] = worldToCell(x, z, S, grid);
  const fx = cx - 0.5, fy = cy - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < -1 || y0 < -1 || x0 >= grid || y0 >= grid) return;
  const tx = fx - x0, ty = fy - y0;
  const put = (xi, yi, ww) => { if (xi >= 0 && yi >= 0 && xi < grid && yi < grid) g[yi * grid + xi] += ww; };
  put(x0, y0, w * (1 - tx) * (1 - ty)); put(x0 + 1, y0, w * tx * (1 - ty));
  put(x0, y0 + 1, w * (1 - tx) * ty); put(x0 + 1, y0 + 1, w * tx * ty);
}

/** Separable gaussian blur, sigma in cells. Returns a new array. */
export function blur(src, sigma, grid = GRID) {
  if (sigma < 0.3) return Float32Array.from(src);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < grid; y++) {
    const row = y * grid;
    for (let x = 0; x < grid; x++) {
      let a = 0;
      const lo = Math.max(-r, -x), hi = Math.min(r, grid - 1 - x);
      for (let i = lo; i <= hi; i++) a += src[row + x + i] * k[i + r];
      tmp[row + x] = a;
    }
  }
  for (let x = 0; x < grid; x++) {
    for (let y = 0; y < grid; y++) {
      let a = 0;
      const lo = Math.max(-r, -y), hi = Math.min(r, grid - 1 - y);
      for (let i = lo; i <= hi; i++) a += tmp[(y + i) * grid + x] * k[i + r];
      out[y * grid + x] = a;
    }
  }
  return out;
}

export function percentile(arr, p) {
  const nz = [];
  for (let i = 0; i < arr.length; i++) if (arr[i] > 0) nz.push(arr[i]);
  if (!nz.length) return 0;
  nz.sort((a, b) => a - b);
  return nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
}

// ---- colour maps: stops [t, r, g, b] -> 256-entry LUT ----
function lut(stops) {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
    out[i * 3] = r0 + (r1 - r0) * u; out[i * 3 + 1] = g0 + (g1 - g0) * u; out[i * 3 + 2] = b0 + (b1 - b0) * u;
  }
  return out;
}
export const COLORMAPS = {
  // sequential, perceptually ordered, readable over dark and light terrain
  inferno: lut([[0, 10, 6, 60], [0.25, 90, 20, 110], [0.5, 190, 55, 80], [0.75, 250, 140, 20], [1, 255, 245, 160]]),
  viridis: lut([[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 144, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]]),
  // diverging: team2 (blue) <-> neutral <-> team1 (red)
  diverging: lut([[0, 30, 90, 220], [0.5, 235, 235, 235], [1, 220, 50, 40]]),
};

/**
 * Render a scalar grid to an RGBA ImageData-compatible buffer.
 * mode 'seq': value >= 0, normalised by `vmax`, alpha follows intensity.
 * mode 'div': value in [-vmax, vmax], alpha follows |value|.
 */
export function colorize(vals, { vmax, scale = 'sqrt', cmap = 'inferno', mode = 'seq', floor = 0.02, grid = GRID }) {
  const out = new Uint8ClampedArray(grid * grid * 4);
  const map = COLORMAPS[mode === 'div' ? 'diverging' : cmap];
  const f = scale === 'log' ? (t) => Math.log1p(t * 30) / Math.log1p(30) : scale === 'sqrt' ? Math.sqrt : (t) => t;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    let t;
    if (mode === 'div') {
      const a = Math.min(1, Math.abs(v) / vmax);
      const m = f(a);
      t = 0.5 + 0.5 * Math.sign(v) * m;
      var alpha = m;
    } else {
      const a = Math.min(1, v / vmax);
      t = f(a);
      alpha = t;
    }
    if (alpha < floor) continue;
    const li = Math.min(255, Math.max(0, Math.round(t * 255))) * 3;
    out[i * 4] = map[li]; out[i * 4 + 1] = map[li + 1]; out[i * 4 + 2] = map[li + 2];
    out[i * 4 + 3] = Math.min(255, Math.round(255 * Math.min(1, alpha * 1.25)));
  }
  return out;
}

/**
 * In-game grid reference, matching the grid printed on the PR map images. The grid always has the same number of
 * squares (~13.65 per side), so a square is 75 m per km of map size (300 m on a 4 km map, 75 m on a 1 km map).
 * Columns are A, B, … from the west edge, rows 1, 2, … from the north edge, followed by the numpad keypad digit of
 * the third of the square (7 8 9 / 4 5 6 / 1 2 3). Example: "G6-5".
 */
export function gridRef(x, z, S) {
  const half = 512 * S, size = 2 * half, cell = 75 * S;
  const ex = Math.min(size - 1e-6, Math.max(0, x + half)), ny = Math.min(size - 1e-6, Math.max(0, half - z));
  const col = Math.floor(ex / cell), row = Math.floor(ny / cell);
  let letters = '';
  for (let n = col; n >= 0; n = Math.floor(n / 26) - 1) letters = String.fromCharCode(65 + (n % 26)) + letters;
  const third = cell / 3;
  const kc = Math.floor((ex % cell) / third), kr = Math.floor((ny % cell) / third);
  return `${letters}${row + 1}-${7 + kc - 3 * kr}`;
}
