import { newGrid, splat } from './heatmap.js?v=1';
import { num } from './i18n.js?v=1';

/** 'ru_medic_alt' -> 'medic'. Kits are <faction>_<role>[_alt]. */
export function kitRole(kit) {
  if (!kit) return 'unknown';
  const parts = kit.toLowerCase().split('_');
  if (parts.length < 2) return kit;
  let r = parts.slice(1).join('_').replace(/_alt$/, '');
  return r || 'unknown';
}

const tickDt = (d) => d.sampleDt; // seconds each sample stands for (see parse.js)

/** Per-demo cache: role index per kit index. */
const kitRoles = (d) => d._kr || (d._kr = d.kitNames.map(kitRole));

export const defaultFilter = () => ({ team: 0, role: 'all', vclass: 'all', t0: 0, t1: 1, tk: true, minAge: 0 });

const inTime = (t, d, f) => { const u = t / (d.meta.duration || 1); return u >= f.t0 - 1e-4 && u <= f.t1 + 1e-4; }; // epsilon: sample times are Float32, durations Float64

/**
 * Accumulate a layer into a GRID×GRID array summing all demos (they must share the same map/size).
 * Presence layers are in seconds-per-player; event layers are counts.
 */
export function accumulate(demos, layer, f) {
  const g = newGrid();
  for (const d of demos) {
    const S = d.meta.mapSize;
    if (layer === 'foot' || layer === 'inveh' || layer === 'people') {
      const P = d.players, dt = tickDt(d), roles = kitRoles(d);
      for (let i = 0; i < d.n.players; i++) {
        if (f.team && P.team[i] !== f.team) continue;
        if (layer === 'foot' && P.inVeh[i]) continue;
        if (layer === 'inveh' && !P.inVeh[i]) continue;
        if (f.role !== 'all' && roles[P.kit[i]] !== f.role) continue;
        if (f.minAge && P.age[i] < f.minAge) continue; // still lingering at the spawn point
        if (!inTime(P.t[i], d, f)) continue;
        splat(g, P.x[i], P.z[i], S, dt[P.tick[i]]);
      }
    } else if (layer === 'vehicles') {
      const V = d.vehicles, dt = tickDt(d);
      for (let i = 0; i < d.n.vehicles; i++) {
        if (f.team && V.team[i] !== f.team) continue;
        if (f.vclass !== 'all' && d.vehicleClasses[V.cls[i]] !== f.vclass) continue;
        if (!inTime(V.t[i], d, f)) continue;
        splat(g, V.x[i], V.z[i], S, dt[V.tick[i]]);
      }
    } else if (layer === 'deaths' || layer === 'kills') {
      for (const k of d.kills) {
        if (!f.tk && k.tk) continue;
        if (!inTime(k.t, d, f)) continue;
        const team = layer === 'deaths' ? k.vTeam : k.aTeam;
        if (f.team && team !== f.team) continue;
        if (f.role !== 'all' && kitRole(layer === 'deaths' ? k.vKit : k.aKit) !== f.role) continue;
        const x = layer === 'deaths' ? k.vx : k.ax, z = layer === 'deaths' ? k.vz : k.az;
        if (Number.isNaN(x)) continue;
        splat(g, x, z, S, 1);
      }
    } else if (layer === 'vdest') {
      for (const v of d.vehicleDestroyed) {
        if (f.team && v.team !== f.team) continue;
        if (f.vclass !== 'all' && v.cls !== f.vclass) continue;
        if (!inTime(v.t, d, f) || Number.isNaN(v.x)) continue;
        splat(g, v.x, v.z, S, 1);
      }
    } else if (layer === 'revives') {
      for (const r of d.revives) {
        if (f.team && r.team !== f.team) continue;
        if (!inTime(r.t, d, f) || Number.isNaN(r.x)) continue;
        splat(g, r.x, r.z, S, 1);
      }
    }
  }
  return g;
}


// ------------------------------------------------------------------ stats

const BUCKETS = [[0, 25], [25, 50], [50, 100], [100, 200], [200, 400], [400, Infinity]];
export const BUCKET_LABELS = ['<25 m', '25–50', '50–100', '100–200', '200–400', '>400 m'];
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export { fmtT };

export function computeStats(demos, f) {
  const st = {
    demos: demos.length, duration: 0, kills: [0, 0, 0], deaths: [0, 0, 0], tk: 0,
    dist: new Array(BUCKETS.length).fill(0), distN: 0, weapons: new Map(), phases: [[], []],
    revives: [0, 0, 0], vdest: { 1: {}, 2: {} }, vdestTotal: [0, 0, 0],
    teamNames: [demos[0].meta.opfor, demos[0].meta.blufor],
  };
  const NP = 10;
  st.phases = [new Array(NP).fill(0), new Array(NP).fill(0), new Array(NP).fill(0)];
  for (const d of demos) {
    st.duration += d.meta.duration;
    for (const k of d.kills) {
      if (!inTime(k.t, d, f)) continue;
      if (k.tk) { st.tk++; if (!f.tk) continue; }
      if (k.aTeam) st.kills[k.aTeam]++;
      if (k.vTeam) st.deaths[k.vTeam]++;
      if (!k.tk && k.aTeam) st.phases[k.aTeam][Math.min(NP - 1, Math.floor(k.t / (d.meta.duration || 1) * NP))]++;
      if (!Number.isNaN(k.dist) && !k.tk) {
        const b = BUCKETS.findIndex(([lo, hi]) => k.dist >= lo && k.dist < hi);
        if (b >= 0) { st.dist[b]++; st.distN++; }
      }
      const w = k.weapon || '?';
      st.weapons.set(w, (st.weapons.get(w) || 0) + 1);
    }
    for (const r of d.revives) if (inTime(r.t, d, f) && r.team) st.revives[r.team]++;
    for (const v of d.vehicleDestroyed) {
      if (!inTime(v.t, d, f) || !v.team) continue;
      st.vdestTotal[v.team]++;
      st.vdest[v.team][v.cls] = (st.vdest[v.team][v.cls] || 0) + 1;
    }
  }
  st.topWeapons = [...st.weapons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return st;
}

/** Seconds each flag spent under each team. Key by position so demos of the same layer aggregate. */
export function flagControl(demos) {
  const byKey = new Map();
  for (const d of demos) {
    const meta = new Map(d.flags.map((fl) => [fl.id, fl]));
    const events = [...d.flagTimeline].sort((a, b) => a.t - b.t);
    const cur = new Map(), since = new Map();
    const acc = (id, until) => {
      const fl = meta.get(id); if (!fl) return;
      const key = `${fl.x},${fl.z}`;
      let e = byKey.get(key);
      if (!e) { e = { x: fl.x, z: fl.z, r: fl.r, id: fl.id, secs: [0, 0, 0], total: 0 }; byKey.set(key, e); }
      const dt = until - (since.get(id) ?? 0);
      e.secs[cur.get(id) ?? 0] += dt; e.total += dt;
    };
    for (const ev of events) {
      if (cur.has(ev.id)) acc(ev.id, ev.t);
      cur.set(ev.id, ev.team); since.set(ev.id, ev.t);
    }
    for (const id of cur.keys()) acc(id, d.meta.duration);
  }
  return [...byKey.values()].filter((e) => e.r > 1); // r<=1 are main bases/placeholders
}

// ------------------------------------------------------------------ narrative

export function insights(demos, f, st, ctrl, t) {
  const out = [];
  const [n1, n2] = st.teamNames;
  const min = Math.round(st.duration / 60);
  const k1 = st.kills[1], k2 = st.kills[2];
  if (k1 + k2) {
    const top = Math.max(k1, k2);
    out.push(t('ins.kills', { lead: k1 >= k2 ? n1 : n2, n: top, total: k1 + k2, pct: Math.round(top / (k1 + k2) * 100), min,
      multi: st.demos > 1 ? t('ins.multi', { n: st.demos }) : '' }));
  }
  if (st.tk) out.push(t('ins.tk', { n: st.tk, pct: num(st.tk / Math.max(1, k1 + k2 + st.tk) * 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
  if (st.distN) {
    const nearPct = Math.round((st.dist[0] + st.dist[1]) / st.distN * 100), farPct = Math.round((st.dist[4] + st.dist[5]) / st.distN * 100);
    let acc = 0, med = 0;
    while (med < st.dist.length - 1 && acc + st.dist[med] < st.distN / 2) acc += st.dist[med++];
    out.push(t('ins.dist', { near: nearPct, far: farPct, half: med < 5 ? t('ins.within', { m: [25, 50, 100, 200, 400][med] }) : t('ins.beyond') }));
  }
  if (ctrl.length) {
    const share = (e) => Math.max(e.secs[1], e.secs[2]) / e.total;
    const best = [...ctrl].sort((a, b) => share(b) - share(a))[0];
    out.push(t('ins.stable', { x: best.x, z: best.z, team: best.secs[1] >= best.secs[2] ? n1 : n2, pct: Math.round(share(best) * 100) }));
    const flip = [...ctrl].sort((a, b) => Math.min(b.secs[1], b.secs[2]) - Math.min(a.secs[1], a.secs[2]))[0];
    if (Math.min(flip.secs[1], flip.secs[2]) > 60) out.push(t('ins.contested', { x: flip.x, z: flip.z }));
  }
  if (st.vdestTotal[1] + st.vdestTotal[2]) out.push(t('ins.vehicles', { a: n1, va: st.vdestTotal[1], b: n2, vb: st.vdestTotal[2] }));
  if (st.revives[1] + st.revives[2]) out.push(t('ins.revives', { a: n1, ra: st.revives[1], b: n2, rb: st.revives[2] }));
  return out;
}
