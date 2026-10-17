/**
 * Comprobaciones rápidas de las construcciones (sin gráficos):  npx tsx scripts/check-build.ts
 */
import { CONFIG } from '../src/config';
import { emptyInput, Wolf, type PlayerInput } from '../src/sim/entities';
import { Cell } from '../src/sim/Grid';
import { findPath, findWolfPath } from '../src/sim/pathfinding';
import { World } from '../src/sim/World';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✔' : '✘'} ${name}`);
  if (!ok) failed++;
};
const input = (p: Partial<PlayerInput>): PlayerInput => ({ ...emptyInput(), buildMode: true, ...p });

// 1. Apuntar con la mira: construye donde apuntas, pero como mucho a buildRange
{
  const w = new World(1);
  w.sheep.wool = 100;
  const s = w.sheep.pos;
  w.update(1 / 30, input({ aimAt: { x: s.x + 2.5, z: s.z }, place: true }));
  const [i, j] = w.grid.toCell(s.x + 2.5, s.z);
  check('construye en el punto apuntado', w.grid.get(i, j) === Cell.Fence);

  w.update(1 / 30, input({ aimAt: { x: s.x, z: s.z + 30 }, item: 'wall', place: true }));
  const bt = w.buildTarget!;
  const c = w.grid.center(bt.i, bt.j);
  check('lejos: se acerca a buildRange', Math.hypot(c.x - s.x, c.z - s.z) <= CONFIG.buildRange + 0.75);
  check('construye el muro elegido', w.grid.get(bt.i, bt.j) === Cell.Wall);
  check('cobra el muro', Math.abs(w.sheep.wool - (100 - CONFIG.pieces.fence.cost - CONFIG.pieces.wall.cost)) < 1e-6);

  // 2. Desmontar devuelve lana
  const before = w.sheep.wool;
  w.update(1 / 30, input({ aimAt: { x: s.x + 2.5, z: s.z }, remove: true }));
  check('desmonta la valla', w.grid.get(i, j) === Cell.Empty);
  check('devuelve la mitad de lana', Math.abs(w.sheep.wool - before - CONFIG.pieces.fence.cost * CONFIG.dismantleRefund) < 1e-6);

  // 3. Sin lana no construye
  w.sheep.wool = 1;
  w.update(1 / 30, input({ aimAt: { x: s.x - 2.5, z: s.z }, item: 'hedge', place: true }));
  check('sin lana no construye', w.buildTarget!.poor && w.grid.get(...w.grid.toCell(s.x - 2.5, s.z)) === Cell.Empty);
}

// 4. Vista: valla se ve a través; seto/muro/puerta tapan
{
  const w = new World(1);
  const a = { x: -3, z: 0.5 };
  const b = { x: 3, z: 0.5 };
  const [i, j] = w.grid.toCell(0, 0.5);
  for (const [cell, blocks] of [[Cell.Fence, false], [Cell.Hedge, true], [Cell.Wall, true], [Cell.Gate, true]] as const) {
    w.grid.set(i, j, cell, 100);
    check(`celda ${cell} ${blocks ? 'tapa' : 'no tapa'} la vista`, w.grid.sightLine(a, b) === !blocks);
  }
}

// 5. Puerta: la oveja la cruza, el lobo no
{
  const w = new World(1);
  const [i, j] = w.grid.toCell(0, 0);
  w.grid.set(i, j, Cell.Gate, 200);
  const c = w.grid.center(i, j);
  const sheep = { x: c.x, z: c.z };
  check('la oveja puede estar en la puerta', !w.grid.collideCircle(sheep, CONFIG.sheep.radius, true));
  const wolf = { x: c.x, z: c.z };
  w.grid.collideCircle(wolf, CONFIG.wolf.radius);
  check('el lobo es expulsado de la puerta', Math.hypot(wolf.x - c.x, wolf.z - c.z) > 0.5);
}

// 6. Lobo grande: no cabe por un hueco de una celda; si se tapa con una valla, la rompe
{
  const w = new World(1);
  const g = w.grid;
  // pared de rocas en x = 34 con un hueco de una celda en z = 32 (dentro de la zona despejada del centro)
  for (let j = 1; j < g.n - 1; j++) if (j !== 32) g.set(34, j, Cell.Rock);
  const from = { x: -4, z: 0.5 };
  const to = { x: 5, z: 0.5 };
  check('el lobo no encuentra camino por el hueco estrecho', findWolfPath(g, g.nearestVertex(from), to, 1, 1000) === null);
  check('la oveja sí cabe por el hueco', findPath(g, ...g.toCell(from.x, from.z), ...g.toCell(to.x, to.z), 1000, true) !== null);
  // hueco de dos celdas: el lobo cabe; tapado con vallas, tiene que romperlas
  g.set(34, 33, Cell.Empty);
  check('por un hueco de dos celdas sí cabe', findWolfPath(g, g.nearestVertex(from), to, 1, 1000) !== null);
  g.set(34, 32, Cell.Fence, CONFIG.pieces.fence.hp);
  g.set(34, 33, Cell.Fence, CONFIG.pieces.fence.hp);
  check('cazando, atraviesa las vallas (romperlas)', findWolfPath(g, g.nearestVertex(from), to, 1, CONFIG.wolf.breakPenalty) !== null);
}

// 7. Mapas generados: toda celda libre tiene alguna esquina a la que llega un lobo (no hay escondites imposibles)
{
  let pockets = 0;
  for (let seed = 1000; seed < 1020; seed++) {
    const w = new World(seed);
    const g = w.grid;
    const start = g.nearestVertex(w.sheep.pos);
    // basta con mirar unas celdas al azar: cada una debe tener camino de lobo a menos de catchDistance
    for (let t = 0; t < 30; t++) {
      const i = 1 + Math.floor(w.rng() * (g.n - 2));
      const j = 1 + Math.floor(w.rng() * (g.n - 2));
      if (g.get(i, j) !== Cell.Empty) continue;
      if (!findWolfPath(g, start, g.center(i, j), CONFIG.wolf.catchDistance - 0.15, 1000, 40000)) pockets++;
    }
  }
  check(`sin escondites imposibles en 20 mapas (${pockets} encontrados)`, pockets === 0);
}

// 8. Torre: subir manteniendo E, a salvo arriba, los lobos la muerden y al caer quedas aturdida
{
  const w = new World(1);
  const g = w.grid;
  w.sheep.wool = 100;
  const s = w.sheep;
  w.update(1 / 30, input({ aimAt: { x: s.pos.x + 1, z: s.pos.z }, item: 'tower', place: true }));
  const tower = g.toCell(s.pos.x + 1, s.pos.z);
  check('construye la torre', g.get(...tower) === Cell.Tower);
  for (let k = 0; k < 15; k++) w.update(1 / 30, { ...emptyInput(), climb: true });
  check('a medio subir sigue en el suelo', s.tower === null && s.climb > 0);
  for (let k = 0; k < 20; k++) w.update(1 / 30, { ...emptyInput(), climb: true });
  check('sube a la torre en 1 s', s.tower !== null && s.elevation === 1);

  w.time = CONFIG.prepTime + 1;
  const wolf = new Wolf(s.pos.x - 6, s.pos.z);
  wolf.mode = 'hunt';
  wolf.heading = Math.PI / 2;
  w.wolves.push(wolf);
  let bites = 0;
  let fell = -1;
  const t0 = w.time;
  while (w.state === 'playing' && w.time - t0 < 40) {
    w.update(1 / 30, emptyInput());
    for (const e of w.events) {
      if (e.type === 'bitten') bites++;
      if (e.type === 'fall') fell = w.time - t0;
    }
    w.events.length = 0;
  }
  check(`el lobo muerde la torre (${bites} mordiscos)`, bites > 10);
  check(`la derriba y la oveja cae (a los ${fell.toFixed(1)}s)`, fell > 15 && fell < 30);
  check('al caer, la atrapan', w.state === 'lost');
}

// 9. Saltar de la torre con el esquive
{
  const w = new World(1);
  w.sheep.wool = 100;
  const s = w.sheep;
  w.update(1 / 30, input({ aimAt: { x: s.pos.x + 1, z: s.pos.z }, item: 'tower', place: true }));
  for (let k = 0; k < 40; k++) w.update(1 / 30, { ...emptyInput(), climb: true });
  const top = { ...s.pos };
  w.update(1 / 30, { ...emptyInput(), moveX: 0, moveZ: 1, dash: true });
  for (let k = 0; k < 10; k++) w.update(1 / 30, emptyInput());
  check('salta abajo y se aleja', s.tower === null && Math.hypot(s.pos.x - top.x, s.pos.z - top.z) > 1.5);
}

// 10. Piña: cae lejos, hace ruido y el lobo va a mirar
{
  const w = new World(1);
  const s = w.sheep;
  s.wool = 5;
  w.time = CONFIG.prepTime + 1;
  const wolf = new Wolf(s.pos.x + 12, s.pos.z + 10);
  wolf.mode = 'wander';
  w.wolves.push(wolf);
  const spot = { x: s.pos.x + 12, z: s.pos.z + 6 };
  w.update(1 / 30, input({ aimAt: spot, item: 'pinecone', place: true }));
  check('cuesta 1 de lana', Math.abs(s.wool - 4) < 1e-6);
  for (let k = 0; k < 30; k++) w.update(1 / 30, emptyInput());
  check('el lobo va a investigar donde cayó', wolf.mode === 'investigate' && !!wolf.target && Math.hypot(wolf.target.x - spot.x, wolf.target.z - spot.z) < 3);
}

// 11. Puente entre torres: tenderlo, cruzar a salvo y caer si derriban una torre
{
  const w = new World(1);
  const g = w.grid;
  const s = w.sheep;
  s.wool = 100;
  const t1 = g.toCell(s.pos.x + 1, s.pos.z);
  const t2 = g.toCell(s.pos.x + 6, s.pos.z);
  g.set(...t1, Cell.Tower, CONFIG.pieces.tower.hp);
  g.set(...t2, Cell.Tower, CONFIG.pieces.tower.hp);
  const c2 = g.center(...t2);
  w.update(1 / 30, input({ item: 'bridge', aimAt: c2, place: true }));
  check('desde el suelo no se puede tender', w.bridges.length === 0);
  for (let k = 0; k < 40; k++) w.update(1 / 30, { ...emptyInput(), climb: true });
  w.update(1 / 30, input({ item: 'bridge', aimAt: { x: c2.x + 0.3, z: c2.z - 0.2 }, place: true }));
  check('subida a una torre, tiende el puente a la otra', w.bridges.length === 1 && Math.abs(s.wool - (100 - CONFIG.bridge.cost)) < 1e-6);

  // lobo esperando debajo del puente
  w.time = CONFIG.prepTime + 1;
  const wolf = new Wolf(s.pos.x + 2.5, s.pos.z + 1.5);
  wolf.mode = 'hunt';
  w.wolves.push(wolf);
  let minD = Infinity;
  for (let k = 0; k < 90 && !s.tower?.every((v, n) => v === t2[n]); k++) {
    w.update(1 / 30, { ...emptyInput(), moveX: 1, moveZ: 0 });
    minD = Math.min(minD, Math.hypot(wolf.pos.x - s.pos.x, wolf.pos.z - s.pos.z));
  }
  check(`cruza a la otra torre (lobo a ${minD.toFixed(1)} m por debajo) sin que la atrapen`, w.state === 'playing' && s.tower?.[0] === t2[0]);

  // vuelve a cruzar y derriban la torre de destino a mitad
  w.wolves.length = 0;
  for (let k = 0; k < 12; k++) w.update(1 / 30, { ...emptyInput(), moveX: -1, moveZ: 0 });
  check('cruzando de vuelta', s.crossing !== null);
  g.set(...t1, Cell.Empty);
  let fell = false;
  for (let k = 0; k < 5; k++) {
    w.update(1 / 30, emptyInput());
    if (w.events.some((e) => e.type === 'fall')) fell = true;
    w.events.length = 0;
  }
  check('si derriban una torre, el puente cae y la oveja también', fell && s.crossing === null && w.bridges.length === 0 && s.elevation < 1);
}

// 12. Escondida en un corral de setos: un lobo con pista (rastro) entra rompiendo; uno que merodea, no
for (const mode of ['track', 'wander'] as const) {
  const w = new World(2);
  const g = w.grid;
  const [ci, cj] = g.toCell(w.sheep.pos.x, w.sheep.pos.z);
  for (let d = -2; d <= 2; d++)
    for (const [i, j] of [[ci + d, cj - 2], [ci + d, cj + 2], [ci - 2, cj + d], [ci + 2, cj + d]]) g.set(i, j, Cell.Hedge, CONFIG.pieces.hedge.hp);
  w.time = CONFIG.prepTime + 1;
  const wolf = new Wolf(w.sheep.pos.x + 6, w.sheep.pos.z);
  wolf.mode = mode;
  wolf.heading = Math.PI / 2; // de espaldas: no la ve
  if (mode === 'track') for (let k = 10; k >= 0; k--) w.scent.push({ x: w.sheep.pos.x + k * 0.6, z: w.sheep.pos.z, t: w.time - k * 0.3 });
  else w.clearScent();
  w.wolves.push(wolf);
  let bites = 0;
  const t0 = w.time;
  while (w.state === 'playing' && w.time - t0 < 30) {
    // en la prueba "merodea" la oveja no deja rastro (sin olfato el lobo no tiene pista)
    if (mode === 'wander') w.clearScent();
    w.update(1 / 30, emptyInput());
    for (const e of w.events) if (e.type === 'bitten') bites++;
    w.events.length = 0;
    if (mode === 'wander') wolf.mode = wolf.mode === 'hunt' ? 'hunt' : 'wander';
  }
  if (mode === 'track') check(`siguiendo el rastro rompe el corral y la atrapa (${bites} mordiscos)`, w.state === 'lost' && bites > 0);
  else check('merodeando sin pista no rompe nada', bites === 0);
}

process.exit(failed ? 1 : 0);
