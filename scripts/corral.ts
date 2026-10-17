// Escena: oveja quieta dentro de un corral de cada pieza y un lobo cazándola. ¿Cuánto tarda en entrar?  npx tsx scripts/corral.ts
import { CONFIG } from '../src/config';
import { emptyInput, Wolf } from '../src/sim/entities';
import { Cell } from '../src/sim/Grid';
import { World } from '../src/sim/World';

for (const piece of ['fence', 'hedge', 'wall'] as const) {
  const cell = { fence: Cell.Fence, hedge: Cell.Hedge, wall: Cell.Wall }[piece];
  const times: string[] = [];
  for (let seed = 1; seed <= 5; seed++) {
    const w = new World(seed);
    const g = w.grid;
    const [ci, cj] = g.toCell(w.sheep.pos.x, w.sheep.pos.z);
    for (let d = -2; d <= 2; d++) {
      for (const [i, j] of [[ci + d, cj - 2], [ci + d, cj + 2], [ci - 2, cj + d], [ci + 2, cj + d]]) g.set(i, j, cell, CONFIG.pieces[piece].hp);
    }
    w.time = CONFIG.prepTime + 1; // sin fase tranquila
    const wolf = new Wolf(w.sheep.pos.x + 8, w.sheep.pos.z);
    wolf.mode = 'hunt';
    wolf.heading = -Math.PI / 2;
    w.wolves.push(wolf);
    let bites = 0;
    let firstBreak = -1;
    const t0 = w.time;
    while (w.state === 'playing' && w.time - t0 < 60) {
      w.update(1 / 30, emptyInput());
      for (const e of w.events) {
        if (e.type === 'bitten') bites++;
        if (e.type === 'destroyed' && firstBreak < 0) firstBreak = w.time - t0;
      }
      w.events.length = 0;
    }
    times.push(`${w.state === 'lost' ? `cazada ${(w.time - t0).toFixed(1)}s` : 'aguanta 60s'} (rompe 1ª a ${firstBreak.toFixed(1)}s, ${bites} mordiscos)`);
  }
  console.log(piece.padEnd(6), times.join(' · '));
}
