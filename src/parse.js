// Lightweight PRdemo (Project Reality tracker) parser, no DOM dependencies.
// Protocol based on https://github.com/yossizap/realitytracker (GPL-3.0), js/parser.js.
// Works in the browser and in Node. Positions are raw int16 game metres:
// X = east, Z = north-ish (map pixel y = -Z / MapSize + 512), Y = altitude.

const MSG = {
  SERVERDETAILS: 0x00, DODLIST: 0x01,
  PLAYER_UPDATE: 0x10, PLAYER_ADD: 0x11, PLAYER_REMOVE: 0x12,
  VEHICLE_UPDATE: 0x20, VEHICLE_ADD: 0x21, VEHICLE_DESTROYED: 0x22,
  FOB_ADD: 0x30, FOB_REMOVE: 0x31,
  FLAG_UPDATE: 0x40, FLAG_LIST: 0x41,
  KILL: 0x50, CHAT: 0x51, TICKETS_TEAM1: 0x52, TICKETS_TEAM2: 0x53,
  RALLY_ADD: 0x60, RALLY_REMOVE: 0x61,
  CACHE_ADD: 0x70, CACHE_REMOVE: 0x71, CACHE_REVEAL: 0x72,
  REVIVE: 0xA0, KITALLOCATED: 0xA1,
  ROUNDEND: 0xF0, TICK: 0xF1,
};

const SAMPLE_MIN_DT = 0.45;
const SUPPORTED_VERSION = 3;

const PF = { TEAM: 1, SQUAD: 2, VEHICLE: 4, HEALTH: 8, SCORE: 16, TEAMWORKSCORE: 32, KILLS: 64,
  TEAMKILLS: 128, DEATHS: 256, PING: 512, ISALIVE: 2048, ISJOINING: 4096, POSITION: 8192,
  ROTATION: 16384, KIT: 32768 };

// Map sizes (km) for demos recorded before the MapSize field existed (from realitytracker loading.js).
const MAP_SIZE_FALLBACK = {
  operation_falcon: 2, tad_sae: 1, operation_ghost_train: 1, sahel: 2, operation_marlin: 2,
  burning_sands: 4, pavlovsk_bay: 4, xiangshan: 4, karbala: 2, goose_green: 2, korengal: 1,
  albasrah_2: 2, operation_soul_rebel: 4, shijiavalley: 4, dragon_fly: 2, gaza_2: 1, hill_488: 1,
  bijar_canyons: 4, kokan_sp: 2, khamisiyah: 4, kokan: 2, operation_archer: 2, ramiel: 2, qwai1: 2,
  charlies_point: 2, asad_khal: 1, beirut: 2, jabal: 2, lashkar_valley: 2, wanda_shan: 4,
  dovre_winter: 2, yamalia: 4, dovre: 2, hades_peak: 4, kozelsk: 2, the_falklands: 8,
  fallujah_west: 1, muttrah_city_2: 2, kashan_desert: 4, battle_of_ia_drang: 2, iron_ridge: 2,
  bamyan: 4, saaremaa: 4, assault_on_grozny: 2, op_barracuda: 2, fools_road: 2, ulyanovsk: 2,
  route: 2, test_bootcamp: 1, nuijamaa: 2, sbeneh_outskirts: 2, assault_on_mestia: 1, black_gold: 4,
  silent_eagle: 4, test_airfield: 4, vadso_city: 4, iron_thunder: 4, shahadah: 2, outpost: 2,
};

async function inflateIfNeeded(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x78) return buf; // not a zlib stream
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).arrayBuffer();
  }
  const { inflateSync } = await import('node:zlib');
  const out = inflateSync(u8);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function cstr(dv, off) {
  let s = '';
  while (off < dv.byteLength) {
    const c = dv.getUint8(off++);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// Split the buffer into [int16 length][payload] messages. Drops a trailing incomplete message.
function splitMessages(buf) {
  const dv = new DataView(buf);
  const msgs = [];
  let pos = 0;
  while (pos + 2 <= dv.byteLength) {
    const len = dv.getInt16(pos, true);
    if (len <= 0 || pos + 2 + len > dv.byteLength) break;
    msgs.push(new DataView(buf, pos + 2, len));
    pos += 2 + len;
  }
  if (msgs.length && msgs[msgs.length - 1].getUint8(0) !== MSG.ROUNDEND) msgs.pop();
  return msgs;
}

export function vehicleClass(name) {
  // Template names look like <faction>_<type>_<model>, e.g. ru_tnk_t90, ch_ahe_z9wa, deployable_hj8
  const n = name.toLowerCase();
  if (/uav_|ucav/.test(n)) return 'uav';
  if (/^(grapplinghook|ladder|parachute)/.test(n)) return 'other';
  if (n.startsWith('deployable') || n.startsWith('spectator')) return 'static';
  const type = n.split('_')[1] || '';
  if (type === 'the' || type === 'ahe') return 'heli';
  if (type === 'jet') return 'jet';
  if (type === 'tnk') return 'tank';
  if (type === 'apc' || type === 'ifv' || type === 'aav' || type === 'spg' || type === 'art') return 'apc';
  if (type === 'atm') return 'apc'; // anti-tank missile carriers (e.g. ru_atm_spandrel) are armoured vehicles
  if (type === 'aa' || type === 'sam' || type === 'mrtr') return 'static';
  if (/boat|ship|rib|sht|zodiac|lcu|lcac|gunboat/.test(type) || /boat|zodiac|_rib/.test(n)) return 'boat';
  return 'light'; // trucks, jeeps, logistics
}

/**
 * Parse an (already inflated) PRdemo ArrayBuffer into a normalized dataset.
 * Positions of living players are sampled once per TICK.
 */
export function parseDemo(buf, { fileName = '' } = {}) {
  const msgs = splitMessages(buf);
  const meta = { fileName, mapSize: 0 };
  const players = new Map();   // id -> state
  const vehicles = new Map();  // id -> state
  const flagsMeta = new Map(); // id -> {id,x,z,r,team0}
  const flagTimeline = [];     // {t, id, team}
  const tickets = [];          // {t, a, b}
  const kills = [], revives = [], vDestroyed = [], fobs = [], cachesList = [];
  const kitSet = new Map();    // kit name -> idx
  const kitNames = [];
  const kitIdx = (n) => { let i = kitSet.get(n); if (i === undefined) { i = kitNames.length; kitSet.set(n, i); kitNames.push(n); } return i; };
  const vclassNames = ['', 'tank', 'apc', 'light', 'heli', 'jet', 'boat', 'static', 'uav', 'other'];

  // columns for player samples
  // `age` = whole seconds since the player last (re)spawned, capped at 255; lets the UI ignore time spent at spawn points
  const P = { tick: [], t: [], team: [], x: [], z: [], kit: [], inVeh: [], age: [] };
  // columns for vehicle samples (occupied vehicles only)
  const V = { tick: [], t: [], team: [], x: [], z: [], cls: [] };
  const tickTime = [0];
  // Samples are taken at most every SAMPLE_MIN_DT seconds; each carries the time it stands for, so presence stays exact
  // (player-seconds) while memory drops on recordings with short ticks.
  const sampleDt = [0];
  let lastSample = 0;
  let tick = 0, time = 0;
  let t1 = 0, t2 = 0;

  for (const m of msgs) {
    const type = m.getUint8(0);
    switch (type) {
      case MSG.SERVERDETAILS: {
        let p = 1;
        meta.version = m.getInt32(p, true); p += 4;
        meta.timePerTick = m.getFloat32(p, true); p += 4;
        meta.ipPort = cstr(m, p); p += meta.ipPort.length + 1;
        meta.serverName = cstr(m, p); p += meta.serverName.length + 1;
        meta.maxPlayers = m.getInt8(p++);
        meta.roundLength = m.getInt16(p, true); p += 2;
        meta.briefing = m.getInt16(p, true); p += 2;
        meta.map = cstr(m, p); p += meta.map.length + 1;
        meta.mode = cstr(m, p); p += meta.mode.length + 1;
        meta.layer = m.getUint8(p++);
        meta.opfor = cstr(m, p); p += meta.opfor.length + 1;
        meta.blufor = cstr(m, p); p += meta.blufor.length + 1;
        meta.startTime = m.getInt32(p, true); p += 4;
        t1 = m.getInt16(p, true); p += 2;
        t2 = m.getInt16(p, true); p += 2;
        tickets.push({ t: 0, a: t1, b: t2 });
        if (p < m.byteLength) {
          let ms = m.getFloat32(p, true);
          if (ms === 0) ms = 2;
          meta.mapSize = Math.min(128, Math.max(0.25, ms));
        }
        break;
      }
      case MSG.PLAYER_ADD: {
        let p = 1;
        while (p < m.byteLength) {
          const id = m.getUint8(p++);
          const name = cstr(m, p); p += name.length + 1;
          const hash = cstr(m, p); p += hash.length + 1;
          const ip = cstr(m, p); p += ip.length + 1;
          players.set(id, { id, name, team: 0, squad: 0, sl: false, alive: false, veh: -1, kit: '',
            x: NaN, y: NaN, z: NaN, kills: 0, deaths: 0, score: 0 });
        }
        break;
      }
      case MSG.PLAYER_REMOVE: {
        for (let p = 1; p < m.byteLength; p++) players.delete(m.getUint8(p));
        break;
      }
      case MSG.PLAYER_UPDATE: {
        let p = 1;
        while (p < m.byteLength) {
          const flags = m.getUint16(p, true); p += 2;
          const id = m.getUint8(p++);
          const pl = players.get(id) || { id, name: '?', team: 0, squad: 0, sl: false, alive: false, veh: -1, kit: '', x: NaN, y: NaN, z: NaN, kills: 0, deaths: 0, score: 0 };
          players.set(id, pl);
          if (flags & PF.TEAM) pl.team = m.getInt8(p++);
          if (flags & PF.SQUAD) { const s = m.getUint8(p++); pl.sl = s >= 128; pl.squad = s % 128; }
          if (flags & PF.VEHICLE) {
            pl.veh = m.getInt16(p, true); p += 2;
            if (pl.veh >= 0) { const seat = cstr(m, p); p += seat.length + 1; p += 1; }
          }
          if (flags & PF.HEALTH) p += 1;
          if (flags & PF.SCORE) p += 2;
          if (flags & PF.TEAMWORKSCORE) p += 2;
          if (flags & PF.KILLS) { pl.kills = m.getInt16(p, true); p += 2; }
          if (flags & PF.DEATHS) { pl.deaths = m.getInt16(p, true); p += 2; }
          if (flags & PF.PING) p += 2;
          if (flags & PF.ISALIVE) {
            const was = pl.alive;
            pl.alive = m.getInt8(p++) === 1;
            if (pl.alive && !was) pl.since = time;
          }
          if (flags & PF.ISJOINING) p += 1;
          if (flags & PF.POSITION) {
            pl.x = m.getInt16(p, true); pl.y = m.getInt16(p + 2, true); pl.z = m.getInt16(p + 4, true); p += 6;
          }
          if (flags & PF.ROTATION) p += 2;
          if (flags & PF.KIT) { pl.kit = cstr(m, p); p += pl.kit.length + 1; }
        }
        break;
      }
      case MSG.VEHICLE_ADD: {
        const id = m.getInt16(1, true);
        const name = cstr(m, 3);
        const v = vehicles.get(id) || { id, team: 0, x: NaN, y: NaN, z: NaN };
        v.name = name; v.cls = vehicleClass(name);
        v.maxHealth = m.getUint16(3 + name.length + 1, true);
        vehicles.set(id, v);
        break;
      }
      case MSG.VEHICLE_UPDATE: {
        let p = 1;
        while (p < m.byteLength) {
          const flags = m.getUint8(p++);
          const id = m.getInt16(p, true); p += 2;
          const v = vehicles.get(id);
          if (!v) break;
          if (flags & 1) v.team = m.getInt8(p++);
          if (flags & 2) { v.x = m.getInt16(p, true); v.y = m.getInt16(p + 2, true); v.z = m.getInt16(p + 4, true); p += 6; }
          if (flags & 4) p += 2;
          if (flags & 8) p += 2;
        }
        break;
      }
      case MSG.VEHICLE_DESTROYED: {
        const id = m.getInt16(1, true);
        const v = vehicles.get(id);
        const known = m.getUint8(3) !== 0;
        const by = known ? players.get(m.getUint8(4)) : null;
        if (v) vDestroyed.push({ t: time, tick, id, name: v.name, cls: v.cls, team: v.team, x: v.x, z: v.z,
          byTeam: by ? by.team : 0, byName: by ? by.name : '', byX: by ? by.x : NaN, byZ: by ? by.z : NaN });
        vehicles.delete(id);
        break;
      }
      case MSG.FLAG_LIST: {
        let p = 1;
        while (p < m.byteLength) {
          const id = m.getUint16(p, true), team = m.getUint8(p + 2);
          const x = m.getInt16(p + 3, true), y = m.getInt16(p + 5, true), z = m.getInt16(p + 7, true), r = m.getUint16(p + 9, true);
          flagsMeta.set(id, { id, team0: team, x, z, r });
          flagTimeline.push({ t: 0, id, team });
          p += 11;
        }
        break;
      }
      case MSG.FLAG_UPDATE: {
        flagTimeline.push({ t: time, id: m.getUint16(1, true), team: m.getUint8(3) });
        break;
      }
      case MSG.TICKETS_TEAM1: t1 = m.getInt16(1, true); tickets.push({ t: time, a: t1, b: t2 }); break;
      case MSG.TICKETS_TEAM2: t2 = m.getInt16(1, true); tickets.push({ t: time, a: t1, b: t2 }); break;
      case MSG.KILL: {
        let p = 1;
        const aId = m.getUint8(p++), vId = m.getUint8(p++);
        const weapon = cstr(m, p);
        const a = players.get(aId), v = players.get(vId);
        const k = { t: time, tick, weapon, aId, vId,
          aName: a ? a.name : '?', vName: v ? v.name : '?',
          aTeam: a ? a.team : 0, vTeam: v ? v.team : 0,
          aKit: a ? a.kit : '', vKit: v ? v.kit : '',
          ax: a ? a.x : NaN, az: a ? a.z : NaN, ay: a ? a.y : NaN,
          vx: v ? v.x : NaN, vz: v ? v.z : NaN, vy: v ? v.y : NaN, dist: NaN, tk: false };
        if (a && v) {
          k.dist = Math.round(Math.hypot(k.vx - k.ax, k.vy - k.ay, k.vz - k.az));
          k.tk = a.team === v.team && aId !== vId;
        }
        kills.push(k);
        break;
      }
      case MSG.REVIVE: {
        const med = players.get(m.getUint8(1)), rev = players.get(m.getUint8(2));
        if (med) revives.push({ t: time, team: med.team, x: med.x, z: med.z, rx: rev ? rev.x : NaN, rz: rev ? rev.z : NaN });
        break;
      }
      case MSG.FOB_ADD: {
        let p = 1;
        while (p < m.byteLength) {
          fobs.push({ t: time, id: m.getInt32(p, true), team: m.getUint8(p + 4),
            x: m.getInt16(p + 5, true), z: m.getInt16(p + 9, true), kind: 'fob' });
          p += 11;
        }
        break;
      }
      case MSG.RALLY_ADD: {
        let p = 1;
        while (p < m.byteLength) {
          const ts = m.getUint8(p);
          fobs.push({ t: time, id: ts, team: Math.floor(ts / 128) + 1, x: m.getInt16(p + 1, true), z: m.getInt16(p + 5, true), kind: 'rally' });
          p += 7;
        }
        break;
      }
      case MSG.CACHE_ADD: {
        for (let p = 1; p < m.byteLength; p += 7)
          cachesList.push({ id: m.getUint8(p), x: m.getInt16(p + 1, true), z: m.getInt16(p + 5, true) });
        break;
      }
      case MSG.TICK: {
        time += m.getInt8(1) * 0.04;
        tick++;
        tickTime.push(time);
        if (time - lastSample < SAMPLE_MIN_DT - 1e-6) { sampleDt.push(0); break; }
        sampleDt.push(time - lastSample);
        lastSample = time;
        const crew = new Set();
        for (const pl of players.values()) {
          if (!pl.alive || !(pl.team === 1 || pl.team === 2) || Number.isNaN(pl.x)) continue;
          const inV = pl.veh >= 0 && vehicles.has(pl.veh) ? 1 : 0;
          if (inV) crew.add(pl.veh);
          P.tick.push(tick); P.t.push(time); P.team.push(pl.team);
          P.x.push(pl.x); P.z.push(pl.z); P.kit.push(kitIdx(pl.kit)); P.inVeh.push(inV);
          P.age.push(Math.min(255, Math.floor(time - (pl.since ?? -1e9))));
        }
        for (const v of vehicles.values()) {
          if (Number.isNaN(v.x) || v.cls === 'other' || v.cls === 'uav' || !crew.has(v.id)) continue;
          V.tick.push(tick); V.t.push(time); V.team.push(v.team);
          V.x.push(v.x); V.z.push(v.z); V.cls.push(vclassNames.indexOf(v.cls));
        }
        break;
      }
      default: break;
    }
  }

  if (!meta.mapSize) meta.mapSize = MAP_SIZE_FALLBACK[meta.map] || 2;
  meta.versionOk = meta.version === SUPPORTED_VERSION; // other protocol versions may decode wrongly
  meta.ticks = tick;
  meta.duration = time;
  const typed = (cols, spec) => Object.fromEntries(Object.entries(cols).map(([k, a]) => [k, new spec[k](a)]));
  return {
    meta, kitNames, vehicleClasses: vclassNames,
    players: typed(P, { tick: Int32Array, t: Float32Array, team: Uint8Array, x: Int16Array, z: Int16Array, kit: Uint16Array, inVeh: Uint8Array, age: Uint8Array }),
    vehicles: typed(V, { tick: Int32Array, t: Float32Array, team: Uint8Array, x: Int16Array, z: Int16Array, cls: Uint8Array }),
    sampleDt: Float32Array.from(sampleDt),
    kills, revives, vehicleDestroyed: vDestroyed, flags: [...flagsMeta.values()], flagTimeline,
    tickets, fobs, caches: cachesList, tickTime,
    n: { players: P.tick.length, vehicles: V.tick.length },
  };
}

export async function loadDemoBuffer(arrayBuffer, opts) {
  return parseDemo(await inflateIfNeeded(arrayBuffer), opts);
}
