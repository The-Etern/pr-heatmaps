// Builds synthetic .PRdemo recordings so the tests need no real files.
const enc = new TextEncoder();
export const cstr = (s) => [...enc.encode(s), 0];
export const i16 = (v) => [v & 255, (v >> 8) & 255];
export const i32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
export const f32 = (v) => [...new Uint8Array(new Float32Array([v]).buffer)];

export const msg = (type, ...parts) => { const body = [type, ...parts.flat()]; return [...i16(body.length), ...body]; };

export function serverDetails({ version = 3, map = 'black_gold', mapSize = 4, t1 = 100, t2 = 100 } = {}) {
  return msg(0x00, i32(version), f32(0.5), cstr('1.2.3.4:16567'), cstr('[PR v1.7.3.0] Test'), [64], i16(7200), i16(300),
    cstr(map), cstr('gpm_cq'), [64], cstr('ru'), cstr('us'), i32(0), i16(t1), i16(t2), f32(mapSize));
}
export const playerAdd = (id, name) => msg(0x11, [id], cstr(name), cstr('hash'), cstr('1.1.1.1'));

// flags: TEAM 1, ISALIVE 2048, POSITION 8192, KIT 32768 (field order is fixed by the protocol)
export function playerUpdate(id, { team, alive, x, y = 0, z, kit } = {}) {
  let flags = 0; const body = [];
  if (team !== undefined) { flags |= 1; body.push(team & 255); }
  if (alive !== undefined) { flags |= 2048; body.push(alive ? 1 : 0); }
  if (x !== undefined) { flags |= 8192; body.push(...i16(x), ...i16(y), ...i16(z)); }
  if (kit !== undefined) { flags |= 32768; body.push(...cstr(kit)); }
  return msg(0x10, i16(flags), [id], body);
}
export const tick = (steps = 12) => msg(0xf1, [steps]); // each step is 0.04 s
export const kill = (attacker, victim, weapon = 'rifle') => msg(0x50, [attacker, victim], cstr(weapon));
export const roundEnd = () => msg(0xf0);

export const toArrayBuffer = (bytes) => new Uint8Array(bytes).buffer;
