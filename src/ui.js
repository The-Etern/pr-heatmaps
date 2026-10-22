import { loadDemoBuffer } from './parse.js?v=1';
import { GRID, blur, colorize, percentile, COLORMAPS, gridRef } from './heatmap.js?v=1';
import { accumulate, computeStats, flagControl, insights, defaultFilter, kitRole, fmtT, BUCKET_LABELS } from './analysis.js?v=1';
import { t, num, LANGS, getLang, setLang, applyStatic } from './i18n.js?v=1';

// id, group
const LAYER_DEFS = [
  ['foot', 'move'], ['inveh', 'move'], ['vehicles', 'move'],
  ['deaths', 'combat'], ['kills', 'combat'], ['lethality', 'combat'],
  ['balance', 'other'], ['vdest', 'other'], ['revives', 'other'],
];
const GROUPS = ['move', 'combat', 'other'];
const MEMORY_WARN_SAMPLES = 25e6; // ~17 bytes per sample, so roughly 400 MB of typed arrays

const $ = (id) => document.getElementById(id);
const demos = [];   // parsed datasets, each with .enabled
const state = {
  map: null, layer: 'foot', filter: defaultFilter(),
  radius: 3, opacity: 0.8, scale: 'sqrt', cmap: 'inferno',
  ov: { flags: true, fobs: false, caches: false },
  view: { cx: 512, cy: 512, zoom: 1 },
  values: null, vmax: 1, mode: 'seq', bg: new Map(),
};
const heatCanvas = Object.assign(document.createElement('canvas'), { width: GRID, height: GRID });
const canvas = $('map-canvas'), ctx = canvas.getContext('2d');
const dpr = () => window.devicePixelRatio || 1;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const active = () => demos.filter((d) => d.enabled && d.meta.map === state.map);
const resetView = () => { state.view = { cx: 512, cy: 512, zoom: 1 }; };

// status is stored as key + params so it can be re-translated when the language changes
let statusFn = null;
function setStatus(key, params) { statusFn = key ? () => t(key, params) : null; renderStatus(); }
function setStatusFn(fn) { statusFn = fn; renderStatus(); }
function renderStatus() { $('status').textContent = statusFn ? statusFn() : ''; }

// ----------------------------------------------------------------- loading
const seen = new Set(); // "name|size" of every file already loaded, to skip duplicates when uploading in batches
const IMG_RE = /\.(png|jpe?g|webp)$/i;

async function addBuffer(buf, name) {
  await new Promise((r) => setTimeout(r)); // let the progress status paint before the (synchronous) parse
  try {
    const d = await loadDemoBuffer(buf, { fileName: name });
    if (!d.meta.map || !d.meta.ticks) throw new Error(t('err.invalid'));
    d.enabled = true;
    demos.push(d);
    if (!state.map) state.map = d.meta.map;
    return d;
  } catch (e) {
    console.error(name, e);
    return null;
  }
}

async function loadFiles(files) {
  const list = [...files];
  for (const f of list.filter((f) => IMG_RE.test(f.name))) if (state.map) await setMapImage(state.map, URL.createObjectURL(f));
  const todo = list.filter((f) => !IMG_RE.test(f.name));
  const added = [], failed = [];
  let dup = 0;
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i], key = `${f.name}|${f.size}`;
    if (seen.has(key)) { dup++; continue; }
    setStatus('status.progress', { i: i + 1, n: todo.length, name: f.name });
    const d = await addBuffer(await f.arrayBuffer(), f.name);
    if (d) { d.key = key; seen.add(key); added.push(d); } else failed.push(f.name);
  }
  const oldFmt = added.filter((d) => !d.meta.versionOk);
  // keep the current map if the batch contains it, otherwise jump to the first map of the batch
  if (added.length && !added.some((d) => d.meta.map === state.map)) state.map = added[0].meta.map;
  afterDemosChanged();
  if (todo.length) {
    setStatusFn(() => t('status.batch', { n: added.length, total: demos.length })
      + (dup ? t('status.dup', { d: dup }) : '') + (failed.length ? t('status.failed', { f: failed.length, name: failed[0] }) : '')
      + (oldFmt.length ? t('status.version', { f: oldFmt.length, v: oldFmt[0].meta.version }) : '')
      + (demos.reduce((s, d) => s + d.n.players, 0) > MEMORY_WARN_SAMPLES ? t('status.memory') : ''));
  }
}

function clearAll() {
  demos.length = 0; seen.clear(); state.map = null;
  afterDemosChanged();
}

function mapImage(map) {
  if (!state.bg.has(map)) {
    const entry = { img: null, failed: false };
    state.bg.set(map, entry);
    const sources = [`maps/${map}.jpg`, `https://yossizap.github.io/realitytracker/Maps/${map}.png`]; // bundled, then upstream
    const tryNext = () => {
      const src = sources.shift();
      if (!src) { entry.failed = true; draw(); return; }
      const img = new Image();
      img.onload = () => { entry.img = img; draw(); };
      img.onerror = tryNext;
      img.src = src;
    };
    tryNext();
  }
  return state.bg.get(map);
}
function setMapImage(map, url) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { state.bg.set(map, { img, failed: false }); res(); };
    img.onerror = res;
    img.src = url;
  });
}

// ----------------------------------------------------------------- controls
function afterDemosChanged() {
  const maps = [...new Set(demos.map((d) => d.meta.map))];
  if (!maps.includes(state.map)) state.map = maps[0] || null;
  buildMapSelect();
  buildDemoList();
  buildFilterOptions();
  resetView();
  setStatus(demos.length ? 'status.loaded' : 'status.none', { n: demos.length });
  $('mapBox').classList.toggle('empty', !demos.length);
  document.querySelector('.layout').classList.toggle('empty', !demos.length);
  $('clearAll').hidden = !demos.length;
  refresh(true);
}

function buildMapSelect() {
  const sel = $('map');
  sel.innerHTML = '';
  for (const m of [...new Set(demos.map((d) => d.meta.map))]) {
    const n = demos.filter((d) => d.meta.map === m).length;
    sel.append(new Option(`${m.replace(/_/g, ' ')} (${n})`, m, false, m === state.map));
  }
}

function buildDemoList() {
  const ul = $('demoList');
  ul.innerHTML = '';
  demos.filter((d) => d.meta.map === state.map).forEach((d) => {
    const li = document.createElement('li');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: d.enabled });
    cb.setAttribute('aria-label', t('use', { name: d.meta.fileName }));
    cb.onchange = () => { d.enabled = cb.checked; refresh(true); };
    const sp = document.createElement('span');
    sp.textContent = t('demo.row', { mode: d.meta.mode.replace('gpm_', ''), layer: d.meta.layer, dur: fmtT(d.meta.duration), kills: d.kills.length });
    sp.title = d.meta.fileName;
    const rm = Object.assign(document.createElement('button'), { textContent: '×', title: t('removeShort') });
    rm.setAttribute('aria-label', t('remove', { name: d.meta.fileName }));
    rm.onclick = () => { demos.splice(demos.indexOf(d), 1); seen.delete(d.key); afterDemosChanged(); };
    li.append(cb, sp, rm);
    ul.append(li);
  });
}

function buildFilterOptions() {
  const act = demos.filter((d) => d.meta.map === state.map);
  const team = $('team'), prev = team.value || '0';
  team.innerHTML = '';
  if (act.length) {
    team.append(new Option(t('team.both'), 0), new Option(`1 · ${act[0].meta.opfor}`, 1), new Option(`2 · ${act[0].meta.blufor}`, 2));
    team.value = prev;
  }
  const roles = new Set(), classes = new Set();
  for (const d of act) {
    d.kitNames.forEach((k) => roles.add(kitRole(k)));
    d.vehicleClasses.forEach((c) => c && classes.add(c));
  }
  const fill = (el, set, label = (v) => v) => {
    const p = el.value;
    el.innerHTML = '';
    el.append(new Option(t('all'), 'all'));
    [...set].sort((a, b) => label(a).localeCompare(label(b))).forEach((r) => el.append(new Option(label(r), r)));
    el.value = set.has(p) ? p : 'all';
  };
  fill($('role'), roles); fill($('vclass'), classes, (c) => t(`vc.${c}`));
  const ageSel = $('minAge'), pa = ageSel.value || '0';
  ageSel.innerHTML = '';
  for (const s of [0, 15, 30, 60, 120]) ageSel.append(new Option(s ? t('minAge.n', { n: s }) : t('minAge.off'), s));
  ageSel.value = pa;
  state.filter.minAge = +ageSel.value;
  state.filter.role = $('role').value; state.filter.vclass = $('vclass').value; state.filter.team = +team.value;
  const k = $('teamKey');
  k.innerHTML = act.length
    ? `<span><i style="background:var(--t1)"></i>${esc(act[0].meta.opfor)}</span><span><i style="background:var(--t2)"></i>${esc(act[0].meta.blufor)}</span>` : '';
}

function buildLayerButtons() {
  const box = $('layers');
  box.innerHTML = '';
  box.setAttribute('role', 'radiogroup');
  for (const g of GROUPS) {
    const title = document.createElement('div');
    title.className = 'group-title'; title.textContent = t(`group.${g}`);
    const grp = document.createElement('div');
    grp.className = 'group';
    for (const [id, gr] of LAYER_DEFS) {
      if (gr !== g) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'layer-btn'; b.dataset.layer = id;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(id === state.layer));
      b.textContent = t(`layer.${id}`);
      b.onclick = () => { state.layer = id; refresh(true); };
      grp.append(b);
    }
    box.append(title, grp);
  }
}

function syncLayerUi() {
  const L = state.layer;
  document.querySelectorAll('.layer-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layer === L)));
  $('layerTitle').textContent = t(`layer.${L}`);
  $('layerHelp').textContent = t(`layer.${L}.help`);
  $('vclassWrap').hidden = !(L === 'vehicles' || L === 'vdest');
  $('roleWrap').hidden = !['foot', 'inveh', 'deaths', 'kills', 'lethality'].includes(L);
  $('ageWrap').hidden = !['foot', 'inveh', 'lethality', 'balance'].includes(L);
  $('team').disabled = L === 'balance';
}

function buildLangButtons() {
  const box = $('lang');
  box.innerHTML = '';
  for (const [code, short, long] of LANGS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = short; b.title = long; b.lang = code;
    b.setAttribute('aria-pressed', String(code === getLang()));
    b.onclick = () => { setLang(code); applyLanguage(); };
    box.append(b);
  }
}

function applyLanguage() {
  applyStatic();
  buildLangButtons();
  buildLayerButtons();
  buildMapSelect();
  buildDemoList();
  buildFilterOptions();
  $('play').textContent = playTimer ? t('pause') : t('sweep');
  renderStatus();
  updateWindowLabel();
  refresh(true);
}

function updateWindowLabel() {
  const a = state.filter.t0, b = state.filter.t1;
  const n = Math.max(1, active().length);
  const dur = active().reduce((s, d) => s + d.meta.duration, 0) / n;
  $('tOut').textContent = `${fmtT(a * dur)} – ${b >= 0.999 ? t('end') : fmtT(b * dur)}`;
  $('dualFill').style.left = `${a * 100}%`;
  $('dualFill').style.width = `${(b - a) * 100}%`;
}

function zoomBy(f) {
  state.view.zoom = Math.min(16, Math.max(1, state.view.zoom * f));
  if (state.view.zoom === 1) { state.view.cx = 512; state.view.cy = 512; }
  draw();
}

function bind() {
  $('file').onchange = (e) => { loadFiles([...e.target.files]); e.target.value = ''; };
  $('clearAll').onclick = clearAll;
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dragOverlay').hidden = false; } });
  addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dragOverlay').hidden = true; } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dragOverlay').hidden = true; loadFiles(e.dataTransfer.files); });
  $('map').onchange = (e) => { state.map = e.target.value; resetView(); buildDemoList(); buildFilterOptions(); updateWindowLabel(); refresh(true); };
  $('team').onchange = (e) => { state.filter.team = +e.target.value; refresh(true); };
  $('role').onchange = (e) => { state.filter.role = e.target.value; refresh(true); };
  $('vclass').onchange = (e) => { state.filter.vclass = e.target.value; refresh(true); };
  $('tk').onchange = (e) => { state.filter.tk = e.target.checked; refresh(true); };
  $('minAge').onchange = (e) => { state.filter.minAge = +e.target.value; refresh(true); };
  $('savePng').onclick = savePng;
  const onT = () => {
    let a = +$('t0').value / 1000, b = +$('t1').value / 1000;
    if (a > b - 0.01) { if (document.activeElement === $('t0')) a = b - 0.01; else b = a + 0.01; }
    $('t0').value = a * 1000; $('t1').value = b * 1000;
    state.filter.t0 = Math.max(0, a); state.filter.t1 = Math.min(1, b);
    updateWindowLabel();
    refresh(false);
  };
  $('t0').oninput = onT; $('t1').oninput = onT;
  $('resetT').onclick = () => { stopPlay(); $('t0').value = 0; $('t1').value = 1000; onT(); };
  $('play').onclick = togglePlay;
  $('radius').oninput = (e) => { state.radius = +e.target.value; $('radiusOut').textContent = state.radius; refresh(false); };
  $('opacity').oninput = (e) => { state.opacity = e.target.value / 100; $('opacityOut').textContent = e.target.value + '%'; draw(); };
  $('scale').onchange = (e) => { state.scale = e.target.value; render(); };
  $('cmap').onchange = (e) => { state.cmap = e.target.value; render(); };
  for (const [id, key] of [['ovFlags', 'flags'], ['ovFobs', 'fobs'], ['ovCaches', 'caches']])
    $(id).onchange = (e) => { state.ov[key] = e.target.checked; draw(); };
  $('resetView').onclick = () => { resetView(); draw(); };
  $('zoomIn').onclick = () => zoomBy(1.6);
  $('zoomOut').onclick = () => zoomBy(1 / 1.6);
  $('radiusOut').textContent = state.radius; $('opacityOut').textContent = '80%';
  bindCanvas();
  addEventListener('resize', () => { draw(); drawCharts(); });
}

// play = sweep a window across the match
let playTimer = null;
function stopPlay() { clearInterval(playTimer); playTimer = null; $('play').textContent = t('sweep'); }
function togglePlay() {
  if (playTimer) return stopPlay();
  let a = +$('t0').value / 1000, b = +$('t1').value / 1000;
  const w = b - a > 0.95 ? 0.15 : b - a;
  a = 0; b = w;
  $('play').textContent = t('pause');
  playTimer = setInterval(() => {
    a += 0.004; b += 0.004;
    if (b > 1) { a = 0; b = w; }
    $('t0').value = a * 1000; $('t1').value = b * 1000;
    $('t0').dispatchEvent(new Event('input'));
  }, 60);
}

// ----------------------------------------------------------------- compute
let analysisTimer = null;
function refresh(withAnalysis) {
  syncLayerUi();
  compute();
  render();
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(updateAnalysis, withAnalysis ? 30 : 350);
}

function compute() {
  const act = active();
  if (!act.length) { state.values = null; return; }
  const f = state.filter, L = state.layer, sigma = state.radius;
  state.mode = 'seq';
  if (L === 'balance') {
    const a = blur(accumulate(act, 'foot', { ...f, team: 1 }), sigma), b = blur(accumulate(act, 'foot', { ...f, team: 2 }), sigma);
    let mx = 0;
    for (let i = 0; i < a.length; i++) mx = Math.max(mx, a[i] + b[i]);
    const out = new Float32Array(a.length), k = mx * 0.06 + 1e-9;
    for (let i = 0; i < out.length; i++) out[i] = (a[i] - b[i]) / (a[i] + b[i] + k);
    state.values = out; state.vmax = 1; state.mode = 'div';
  } else if (L === 'lethality') {
    const s = Math.max(sigma, 2) * 1.6;
    const d = blur(accumulate(act, 'deaths', f), s), p = blur(accumulate(act, 'people', f), s);
    let pm = 0;
    for (let i = 0; i < p.length; i++) pm = Math.max(pm, p[i]);
    const out = new Float32Array(d.length);
    for (let i = 0; i < out.length; i++) out[i] = p[i] > pm * 0.04 ? d[i] / (p[i] / 60) : 0;
    state.values = out; state.vmax = percentile(out, 0.99) || 1;
  } else {
    const g = blur(accumulate(act, L, f), sigma);
    state.values = g; state.vmax = percentile(g, 0.995) || 1;
  }
}

function render() {
  if (state.values) {
    const px = colorize(state.values, { vmax: state.vmax, scale: state.scale, cmap: state.cmap, mode: state.mode });
    heatCanvas.getContext('2d').putImageData(new ImageData(px, GRID, GRID), 0, 0);
    drawLegend();
  }
  draw();
}

function drawLegend() {
  const c = $('legend'), g = c.getContext('2d');
  const map = state.mode === 'div' ? COLORMAPS.diverging : COLORMAPS[state.cmap];
  for (let x = 0; x < c.width; x++) {
    const i = Math.round(x / (c.width - 1) * 255) * 3;
    g.fillStyle = `rgb(${map[i]},${map[i + 1]},${map[i + 2]})`;
    g.fillRect(x, 0, 1, c.height);
  }
  const labels = c.parentElement.querySelectorAll('.legend-labels span');
  const v = state.vmax;
  labels[0].textContent = state.mode === 'div' ? t('legend.team2') : '0';
  labels[1].textContent = state.mode === 'div' ? t('legend.team1') : num(v >= 100 ? Math.round(v) : +v.toPrecision(2));
  $('legendUnit').textContent = t(`layer.${state.layer}.unit`);
}

// ----------------------------------------------------------------- canvas drawing
function fitCanvas() {
  const wrap = $('canvasWrap');
  const size = Math.max(240, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth)));
  const box = $('mapBox');
  if (box.style.width !== size + 'px') { box.style.width = size + 'px'; box.style.height = size + 'px'; }
  const px = Math.round(size * dpr());
  if (canvas.width !== px) { canvas.width = canvas.height = px; }
}

const toV = (x, z, S) => [x / S + 512, -z / S + 512];

/** Paint map + heat + overlays into `g` (a square bitmap of `size` px). `cssScale` = device px per CSS px (for line widths). */
function paintMap(g, size, view, cssScale, act) {
  const S = act[0].meta.mapSize, s = (size / 1024) * view.zoom;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = css('--map-bg');
  g.fillRect(0, 0, size, size);
  g.setTransform(s, 0, 0, s, size / 2 - view.cx * s, size / 2 - view.cy * s);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const bg = mapImage(state.map);
  if (bg.img) g.drawImage(bg.img, 0, 0, 1024, 1024);
  else { g.fillStyle = css('--surface'); g.fillRect(0, 0, 1024, 1024); }
  if (state.values) { g.globalAlpha = state.opacity; g.drawImage(heatCanvas, 0, 0, 1024, 1024); g.globalAlpha = 1; }
  const px = (n) => (n * cssScale) / s; // n CSS pixels -> virtual (1024-space) units

  if (state.ov.flags) {
    for (const fl of flagControl(act)) {
      const [x, y] = toV(fl.x, fl.z, S);
      const max = Math.max(fl.secs[1], fl.secs[2], fl.secs[0]);
      const owner = fl.secs[1] === max ? 1 : fl.secs[2] === max ? 2 : 0;
      g.strokeStyle = [css('--neutral'), css('--t1'), css('--t2')][owner]; g.lineWidth = px(1.75);
      g.beginPath(); g.arc(x, y, Math.max(fl.r / S, px(4)), 0, 7); g.stroke();
      g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(x, y, px(3), 0, 7); g.fill();
    }
  }
  if (state.ov.fobs) {
    for (const d of act) for (const o of d.fobs) {
      const [x, y] = toV(o.x, o.z, S);
      g.fillStyle = o.team === 1 ? css('--t1') : css('--t2');
      g.globalAlpha = 0.75;
      if (o.kind === 'fob') g.fillRect(x - px(4), y - px(4), px(8), px(8)); else { g.beginPath(); g.arc(x, y, px(2.5), 0, 7); g.fill(); }
      g.globalAlpha = 1;
    }
  }
  if (state.ov.caches) {
    g.fillStyle = '#ffd24a';
    for (const d of act) for (const c of d.caches) { const [x, y] = toV(c.x, c.z, S); g.fillRect(x - px(4), y - px(4), px(8), px(8)); }
  }
}

function draw() {
  fitCanvas();
  const act = active();
  if (!act.length) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = css('--map-bg'); ctx.fillRect(0, 0, canvas.width, canvas.height); return; } // the drop zone covers the empty map
  paintMap(ctx, canvas.width, state.view, dpr(), act);
}

/** Save the whole map (not the zoomed view) with the active layer, a caption and the legend as a PNG. */
function savePng() {
  const act = active();
  if (!act.length) return;
  const SIZE = 1536, HEAD = 64, out = document.createElement('canvas');
  out.width = SIZE; out.height = SIZE + HEAD;
  const g = out.getContext('2d');
  g.fillStyle = css('--surface'); g.fillRect(0, 0, SIZE, SIZE + HEAD);
  const map = document.createElement('canvas'); map.width = map.height = SIZE;
  paintMap(map.getContext('2d'), SIZE, { cx: 512, cy: 512, zoom: 1 }, SIZE / 760, act);
  g.drawImage(map, 0, HEAD);
  // caption
  const f = state.filter, dur = act.reduce((s, d) => s + d.meta.duration, 0) / act.length;
  const teamTxt = f.team ? `${f.team === 1 ? act[0].meta.opfor : act[0].meta.blufor}` : t('team.both');
  g.fillStyle = css('--text'); g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.font = '700 24px system-ui, sans-serif';
  g.fillText(`${t(`layer.${state.layer}`)} · ${state.map.replace(/_/g, ' ')}`, 18, 30);
  g.fillStyle = css('--muted'); g.font = '16px system-ui, sans-serif';
  g.fillText(`${t('save.matches', { n: act.length })} · ${t('team')}: ${teamTxt} · ${t('window')}: ${fmtT(f.t0 * dur)}–${f.t1 >= 0.999 ? t('end') : fmtT(f.t1 * dur)}`, 18, 54);
  g.textAlign = 'right'; g.fillText('PR Heatmaps · TheEtern', SIZE - 18, 54);
  // legend
  const lw = 280, lx = 18, ly = SIZE + HEAD - 64;
  g.fillStyle = 'rgba(23,24,26,.86)'; g.fillRect(lx - 8, ly - 10, lw + 16, 56);
  const cm = state.mode === 'div' ? COLORMAPS.diverging : COLORMAPS[state.cmap];
  for (let x = 0; x < lw; x++) { const i = Math.round(x / (lw - 1) * 255) * 3; g.fillStyle = `rgb(${cm[i]},${cm[i + 1]},${cm[i + 2]})`; g.fillRect(lx + x, ly, 1, 12); }
  g.fillStyle = '#e4e6e8'; g.font = '13px system-ui, sans-serif'; g.textAlign = 'left';
  g.fillText(state.mode === 'div' ? t('legend.team2') : '0', lx, ly + 28);
  g.textAlign = 'right';
  g.fillText(state.mode === 'div' ? t('legend.team1') : num(state.vmax >= 100 ? Math.round(state.vmax) : +state.vmax.toPrecision(2)), lx + lw, ly + 28);
  g.textAlign = 'left'; g.fillStyle = '#9a9fa5'; g.fillText(t(`layer.${state.layer}.unit`), lx, ly + 44);
  try {
    out.toBlob((blob) => {
      if (!blob) return setStatus('save.error');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pr-heatmap-${state.map}-${state.layer}.png` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  } catch { setStatus('save.error'); } // a cross-origin map image can taint the canvas
}

// ----------------------------------------------------------------- pan / zoom / hover
function bindCanvas() {
  let drag = null, pinch = null;
  const pointers = new Map();
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const toVirtual = (u, v) => [state.view.cx + (u - 0.5) * 1024 / state.view.zoom, state.view.cy + (v - 0.5) * 1024 / state.view.zoom];
  const startPinch = () => {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: state.view.zoom };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { drag = null; startPinch(); }
    else { drag = { x: e.clientX, y: e.clientY, cx: state.view.cx, cy: state.view.cy }; canvas.classList.add('drag'); }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId); pinch = null;
    drag = pointers.size === 1 ? { ...[...pointers.values()][0], cx: state.view.cx, cy: state.view.cy } : null;
    if (!drag) canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { // two fingers: zoom around the current view centre
      const [a, b] = [...pointers.values()];
      state.view.zoom = Math.min(16, Math.max(1, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      if (state.view.zoom === 1) { state.view.cx = 512; state.view.cy = 512; }
      draw();
      return;
    }
    if (drag) {
      state.view.cx = drag.cx - (e.clientX - drag.x) / r.width * 1024 / state.view.zoom;
      state.view.cy = drag.cy - (e.clientY - drag.y) / r.height * 1024 / state.view.zoom;
      draw();
    }
    hover(e, ...toVirtual(...pos(e)));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [u, v] = pos(e), [vx, vy] = toVirtual(u, v);
    const z = Math.min(16, Math.max(1, state.view.zoom * Math.exp(-e.deltaY * 0.0015)));
    state.view.zoom = z;
    state.view.cx = vx - (u - 0.5) * 1024 / z; state.view.cy = vy - (v - 0.5) * 1024 / z; // keep the point under the cursor
    draw();
  }, { passive: false });
  canvas.addEventListener('pointerleave', () => { $('tip').hidden = true; });
}

function hover(e, vx, vy) {
  const tip = $('tip'), act = active();
  if (!act.length || vx < 0 || vy < 0 || vx > 1024 || vy > 1024) { tip.hidden = true; return; }
  const S = act[0].meta.mapSize;
  const x = Math.round((vx - 512) * S), z = Math.round(-(vy - 512) * S);
  let line2 = '';
  if (state.values) {
    const cx = Math.min(GRID - 1, Math.floor(vx / 1024 * GRID)), cy = Math.min(GRID - 1, Math.floor(vy / 1024 * GRID));
    const v = state.values[cy * GRID + cx];
    line2 = state.mode === 'div'
      ? `${t(v > 0 ? 'hover.team1' : 'hover.team2')} ${Math.round(Math.abs(v) * 100)}%`
      : `${num(v >= 10 ? Math.round(v) : +v.toPrecision(2))} ${t(`layer.${state.layer}.unit`)}`;
  }
  tip.innerHTML = `<b>${gridRef(x, z, S)}</b> <span class="sub">· x ${x} · z ${z}</span>${line2 ? `<br>${esc(line2)}` : ''}`;
  tip.hidden = false;
  const box = $('mapBox').getBoundingClientRect();
  let left = e.clientX - box.left + 14, top = e.clientY - box.top + 14;
  if (left + tip.offsetWidth > box.width - 6) left = e.clientX - box.left - tip.offsetWidth - 14;
  if (top + tip.offsetHeight > box.height - 6) top = e.clientY - box.top - tip.offsetHeight - 14;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}

// ----------------------------------------------------------------- analysis panel
let lastAnalysis = null;
function bar(label, parts, val) {
  const segs = parts.map(([w, c]) => `<i style="width:${Math.max(0, w * 100).toFixed(1)}%;background:${c}"></i>`).join('');
  return `<div class="bar"><span title="${esc(label)}">${esc(label)}</span><div class="track">${segs}</div><span class="val">${val}</span></div>`;
}

// head-to-head tile; `split` is team 1's share of the bar (0..1)
function kpi(label, a, b, n1, n2, split) {
  const fmt = (v) => (Number.isInteger(v) ? v : num(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const wa = (split ?? (a + b > 0 ? a / (a + b) : 0.5)) * 100;
  return `<div class="kpi"><div class="label">${label}</div>
    <div class="vals"><span class="a">${fmt(a)}</span><span class="b">${fmt(b)}</span></div>
    <div class="split"><i style="width:${wa}%;background:var(--t1)"></i><i style="width:${100 - wa}%;background:var(--t2)"></i></div>
    <div class="names"><span>${esc(n1)}</span><span>${esc(n2)}</span></div></div>`;
}

function updateAnalysis() {
  const act = active();
  if (!act.length) {
    lastAnalysis = null;
    $('insights').innerHTML = `<li>${t('an.empty')}</li>`;
    for (const id of ['kpis', 'distBars', 'weapons', 'flagBars']) $(id).innerHTML = '';
    for (const id of ['chPhases', 'chTickets']) { const c = $(id); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
    return;
  }
  const f = state.filter;
  const st = computeStats(act, f), ctrl = flagControl(act);
  lastAnalysis = { st, ctrl, act };

  const ul = $('insights'); ul.innerHTML = '';
  insights(act, f, st, ctrl, t).forEach((txt) => { const li = document.createElement('li'); li.textContent = txt; ul.append(li); });

  const [n1, n2] = st.teamNames;
  const kd1 = st.deaths[1] ? st.kills[1] / st.deaths[1] : st.kills[1], kd2 = st.deaths[2] ? st.kills[2] / st.deaths[2] : st.kills[2];
  $('kpis').innerHTML =
    kpi(t('an.kills'), st.kills[1], st.kills[2], n1, n2) + kpi(t('an.deaths'), st.deaths[1], st.deaths[2], n1, n2)
    + kpi(t('an.kd'), kd1, kd2, n1, n2, kd1 + kd2 > 0 ? kd1 / (kd1 + kd2) : 0.5)
    + kpi(t('an.revives'), st.revives[1], st.revives[2], n1, n2)
    + kpi(t('an.vlost'), st.vdestTotal[1], st.vdestTotal[2], n1, n2);

  const max = Math.max(1, ...st.dist);
  $('distBars').innerHTML = st.dist.map((n, i) => bar(BUCKET_LABELS[i], [[n / max, css('--accent')]], n)).join('');
  const wmax = Math.max(1, ...st.topWeapons.map((w) => w[1]));
  $('weapons').innerHTML = st.topWeapons.map(([w, n]) => bar(w, [[n / wmax, css('--accent')]], n)).join('') || '—';
  const fc = [...ctrl].sort((a, b) => a.x - b.x);
  $('flagBars').innerHTML = fc.map((e) => bar(`${e.x}, ${e.z}`, [[e.secs[1] / e.total, css('--t1')], [e.secs[0] / e.total, css('--neutral')], [e.secs[2] / e.total, css('--t2')]], '')).join('')
    || `<p class="hint">${t('an.noFlags')}</p>`;

  drawCharts();
}

function setupChart(c) {
  const d = dpr(), w = c.clientWidth, h = +c.dataset.h; // height lives in data-h: assigning c.height rewrites the attribute
  c.style.height = h + 'px';
  c.width = Math.round(w * d); c.height = Math.round(h * d);
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawCharts() {
  if (!lastAnalysis) return;
  const { st, act } = lastAnalysis;
  const font = '10px Inter, system-ui, sans-serif';
  { // kills per match phase, grouped bars
    const { g, w, h } = setupChart($('chPhases'));
    const n = st.phases[1].length, mx = Math.max(1, ...st.phases[1], ...st.phases[2]);
    const bw = (w - 26) / n;
    g.font = font; g.textAlign = 'center';
    g.strokeStyle = css('--line'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(24, h - 16.5); g.lineTo(w, h - 16.5); g.stroke();
    for (let i = 0; i < n; i++) {
      const x = 26 + i * bw;
      const h1 = (h - 26) * st.phases[1][i] / mx, h2 = (h - 26) * st.phases[2][i] / mx;
      g.fillStyle = css('--t1'); g.fillRect(x + 1, h - 17 - h1, bw / 2 - 1.5, h1);
      g.fillStyle = css('--t2'); g.fillRect(x + bw / 2, h - 17 - h2, bw / 2 - 1.5, h2);
      if (i % 2 === 0) { g.fillStyle = css('--muted'); g.fillText(`${i * 10}%`, x + bw / 2, h - 4); }
    }
    g.fillStyle = css('--muted'); g.textAlign = 'right'; g.fillText(String(mx), 21, 10);
  }
  { // tickets as % of start, x = match fraction
    const { g, w, h } = setupChart($('chTickets'));
    g.strokeStyle = css('--line'); g.lineWidth = 1; g.font = font; g.fillStyle = css('--muted'); g.textAlign = 'right';
    for (const p of [0, 0.5, 1]) {
      const y = 8.5 + (h - 26) * (1 - p);
      g.beginPath(); g.moveTo(30, y); g.lineTo(w, y); g.stroke();
      g.fillText(`${p * 100}%`, 26, y + 3);
    }
    g.textAlign = 'center';
    for (const p of [0, 0.5, 1]) g.fillText(`${p * 100}%`, 30 + (w - 34) * p, h - 4);
    for (const d of act) {
      const start = d.tickets[0] || { a: 1, b: 1 };
      for (const [key, col] of [['a', '--t1'], ['b', '--t2']]) {
        const base = Math.max(1, start[key]);
        g.strokeStyle = css(col); g.lineWidth = 1.75; g.globalAlpha = act.length > 1 ? 0.6 : 1; g.lineJoin = 'round'; g.beginPath();
        d.tickets.forEach((tk, i) => {
          const x = 30 + (w - 34) * Math.min(1, tk.t / d.meta.duration), y = 8.5 + (h - 26) * (1 - Math.max(0, Math.min(1, tk[key] / base)));
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke(); g.globalAlpha = 1;
      }
    }
  }
}

// ----------------------------------------------------------------- init
bind();
applyLanguage();
afterDemosChanged(); // sets the empty state (drop zone) before any file is loaded
