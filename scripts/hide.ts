// Escena: la oveja se esconde quieta detrás de setos y un lobo la buscaba. ¿Se atasca el lobo?  npx tsx scripts/hide.ts
import { CONFIG } from '../src/config';
import { emptyInput, Wolf } from '../src/sim/entities';
import { Cell } from '../src/sim/Grid';
import { World } from '../src/sim/World';

type Layout = 'fila' | 'rincon' | 'u' | 'cerrado';
const layouts: Layout[] = ['fila', 'rincon', 'u', 'cerrado'];
const startModes = ['hunt', 'search', 'track'] as const;

for (const startMode of startModes)
for (const layout of layouts) {
  const out: string[] = [];
  for (let seed = 1; seed <= 6; seed++) {
    const w = new World(seed);
    const g = w.grid;
    const [ci, cj] = g.toCell(w.sheep.pos.x, w.sheep.pos.z);
    const hedge = (i: number, j: number) => g.set(i, j, Cell.Hedge, CONFIG.pieces.hedge.hp);
    // los setos entre la oveja y el lobo (que viene de +x)
    for (let d = -2; d <= 2; d++) hedge(ci + 2, cj + d);
    if (layout === 'rincon') for (let d = 0; d <= 2; d++) hedge(ci + d, cj + 2); // esquina en L
    if (layout === 'cerrado') for (let d = -2; d <= 2; d++) {
      hedge(ci - 2, cj + d);
      hedge(ci + d, cj + 2);
      hedge(ci + d, cj - 2);
    }
    if (layout === 'u') for (let d = -1; d <= 2; d++) {
      hedge(ci + d, cj + 2);
      hedge(ci + d, cj - 2);
    }
    w.time = CONFIG.prepTime + 1;
    const wolf = new Wolf(w.sheep.pos.x + 9, w.sheep.pos.z + (seed - 3) * 1.5);
    wolf.mode = startMode;
    wolf.modeTime = CONFIG.wolf.searchTime;
    wolf.lastSeen = { ...w.sheep.pos };
    wolf.target = { ...w.sheep.pos };
    // rastro que llega hasta la oveja desde fuera del escondite
    for (let k = 10; k >= 0; k--) w.scent.push({ x: w.sheep.pos.x + k * 0.6, z: w.sheep.pos.z + 0.2, t: w.time - k * 0.3 });
    wolf.heading = -Math.PI / 2;
    w.wolves.push(wolf);
    const t0 = w.time;
    let bites = 0;
    let stuck = 0; // segundos casi parado sin morder
    const modes = new Map<string, number>();
    while (w.state === 'playing' && w.time - t0 < 60) {
      w.update(1 / 30, emptyInput());
      for (const e of w.events) if (e.type === 'bitten') bites++;
      w.events.length = 0;
      if (wolf.speed < 0.3 && !wolf.attacking) stuck += 1 / 30;
      modes.set(wolf.mode, (modes.get(wolf.mode) ?? 0) + 1 / 30);
    }
    const m = [...modes].map(([k, v]) => `${k} ${v.toFixed(0)}s`).join(', ');
    out.push(`  semilla ${seed}: ${w.state === 'lost' ? `cazada a ${(w.time - t0).toFixed(1)}s` : 'NO la encuentra en 60s'} · ${bites} mordiscos · parado ${stuck.toFixed(0)}s · ${m}`);
  }
  console.log(`== ${layout}\n${out.join('\n')}`);
}
