/**
 * Simulación sin gráficos: juega partidas con un bot y saca estadísticas.
 *
 *   npm run sim                         → 50 partidas con el cerebro programado (gratis)
 *   npm run sim -- --brain jev --games 5 → 5 partidas con typesafe/jev-1.14 (OPENROUTER_API_KEY)
 *
 * Opciones: --brain scripted|jev  --games N  --seed S  --interval 0.5  --concurrency N
 *           --piece fence|hedge|wall|gate  (lo que construye el bot)
 *           --extras  (el bot puede subir a torres y lanzar piñas)
 *           --night N  (noche 1-5; por defecto la última, la dificultad completa)
 *           --set wolf.breakPenalty=6  (cambia un número de CONFIG para probar; se puede repetir)
 * Guarda la mejor y la peor partida en public/replays/ para verlas en el navegador.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG } from '../src/config';
import { JevBrain, ScriptedBrain, type Brain, type Decision } from '../src/bot/brains';
import { ACTIONS, Pilot, type Action } from '../src/bot/Pilot';
import { ReplayRecorder, type Replay } from '../src/replay/replay';
import { LAST_NIGHT, NIGHTS } from '../src/sim/nights';
import { PIECES, type PieceId } from '../src/sim/pieces';
import { scoreOf } from '../src/sim/score';
import { World } from '../src/sim/World';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const brainName = arg('brain', 'scripted');
const games = Number(arg('games', brainName === 'jev' ? '5' : '50'));
const baseSeed = Number(arg('seed', '1000'));
const interval = Number(arg('interval', '0.5'));
const concurrency = Number(arg('concurrency', brainName === 'jev' ? '5' : '1'));
const piece = arg('piece', 'fence') as PieceId;
if (!PIECES.includes(piece)) throw new Error(`--piece debe ser ${PIECES.join('|')}`);
const extras = process.argv.includes('--extras');
const night = Number(arg('night', String(LAST_NIGHT + 1))) - 1;
if (!NIGHTS[night]) throw new Error(`--night debe ser 1-${NIGHTS.length}`);
// --set a.b=valor: cambiar balance sin tocar config.ts
process.argv.forEach((a, k) => {
  if (a !== '--set') return;
  const [path, value] = process.argv[k + 1].split('=');
  const keys = path.split('.');
  let obj: Record<string, unknown> = CONFIG as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) obj = obj[key] as Record<string, unknown>;
  const last = keys[keys.length - 1];
  if (typeof obj?.[last] !== 'number') throw new Error(`--set: ${path} no es un número de CONFIG`);
  obj[last] = Number(value);
  console.log(`CONFIG.${path} = ${value}`);
});
const DT = 1 / 30;

function makeBrain(): Brain {
  if (brainName === 'jev') {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('Falta la variable de entorno OPENROUTER_API_KEY');
    return new JevBrain(key, piece, extras);
  }
  return new ScriptedBrain(piece, extras);
}

interface GameResult {
  seed: number;
  time: number;
  won: boolean;
  fencesBuilt: number;
  fencesDestroyed: number;
  woolEaten: number;
  spotted: number; // veces que un lobo pasa a verte
  escapes: number; // veces que un lobo te pierde de vista
  score: number;
  closeCalls: number;
  towerTime: number; // segundos subida a una torre
  towersBuilt: number;
  throws: number;
  death?: string;
  actions: Record<Action, number>;
  latencies: number[];
  cost: number;
  errors: string[];
  replay: Replay;
}

async function playGame(seed: number): Promise<GameResult> {
  const world = new World(seed, night);
  const pilot = new Pilot(world, piece);
  const brain = makeBrain();
  const rec = new ReplayRecorder(world);
  const res: GameResult = {
    seed, time: 0, won: false, fencesBuilt: 0, fencesDestroyed: 0, woolEaten: 0, spotted: 0, escapes: 0, score: 0, closeCalls: 0, towerTime: 0, towersBuilt: 0, throws: 0,
    actions: Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<Action, number>, latencies: [], cost: 0, errors: [], replay: null!,
  };

  let decision: Decision = { action: 'flee' };
  let nextDecision = 0;
  while (world.state === 'playing') {
    let fresh: Decision | null = null;
    if (world.time >= nextDecision) {
      // El mundo está "congelado" mientras el cerebro piensa: la latencia no afecta
      decision = await brain.decide(world);
      fresh = decision;
      nextDecision = world.time + interval;
      res.actions[decision.action]++;
      if (decision.latencyMs !== undefined) res.latencies.push(decision.latencyMs);
      if (decision.cost) res.cost += decision.cost;
      if (decision.error && res.errors.length < 3) res.errors.push(decision.error);
    }
    const woolBefore = world.sheep.wool;
    const input = pilot.input(decision.action, DT);
    const modesBefore = world.wolves.map((w) => w.mode);
    world.update(DT, input);
    world.wolves.forEach((w, k) => {
      if (modesBefore[k] !== 'hunt' && w.mode === 'hunt') res.spotted++;
      if (modesBefore[k] === 'hunt' && w.mode === 'search') res.escapes++;
    });
    if (world.sheep.tower) res.towerTime += DT;
    if (world.sheep.wool > woolBefore) res.woolEaten += world.sheep.wool - woolBefore;
    for (const e of world.events) {
      if (e.type === 'built') res.fencesBuilt++;
      if (e.type === 'built' && e.piece === 'tower') res.towersBuilt++;
      if (e.type === 'throw') res.throws++;
      if (e.type === 'destroyed') res.fencesDestroyed++;
    }
    rec.tick(fresh);
    world.events.length = 0;
  }
  if (world.state === 'lost') {
    const s = world.sheep;
    const killer = [...world.wolves].sort((a, b) => Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z) - Math.hypot(b.pos.x - s.pos.x, b.pos.z - s.pos.z))[0];
    const hunting = world.wolves.filter((w) => w.mode === 'hunt').length;
    res.death = `${killer.phase}/${killer.mode}, cazando ${hunting}/${world.wolves.length}, acción ${decision.action}, estamina ${Math.round(s.stamina)}${s.exhausted ? ' (agotada)' : ''}, esquive ${s.dashCooldown > 0 ? 'en recarga' : 'listo'}`;
  }
  // tiempo sobrevivido desde que llegan los lobos
  res.time = world.survived;
  res.won = world.state === 'won';
  res.score = scoreOf(world).total;
  res.closeCalls = world.stats.closeCalls;
  res.replay = rec.build(brainName);
  return res;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.floor(b.length / 2)] : 0;
};

async function main() {
  console.log(`Cerebro: ${brainName} · noche ${night + 1} · construye: ${piece}${extras ? ' · torre y piñas' : ''} · partidas: ${games} · decisión cada ${interval}s\n`);
  const seeds = Array.from({ length: games }, (_, k) => baseSeed + k);
  const results: GameResult[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < seeds.length) {
        const seed = seeds[next++];
        const r = await playGame(seed);
        results.push(r);
        const total = ACTIONS.reduce((a, k) => a + r.actions[k], 0);
        const pct = (n: number) => `${Math.round((n / Math.max(1, total)) * 100)}%`;
        console.log(
          `  semilla ${seed}: ${r.won ? 'GANA ' : 'muere'} ${fmt(r.time)} · construye ${r.fencesBuilt} (rotas ${r.fencesDestroyed}) · ` +
            `visto ${r.spotted}x, escapa ${r.escapes}x · huir ${pct(r.actions.flee)} comer ${pct(r.actions.eat)} construir ${pct(r.actions.build)}` +
            (extras ? ` torre ${pct(r.actions.tower)} piña ${pct(r.actions.distract)} · ${r.towerTime.toFixed(0)}s en torre, ${r.towersBuilt} torres, ${r.throws} piñas` : '') +
            (r.death ? `
      ↳ ${r.death}` : '') +
            (r.errors.length ? ` · errores: ${r.errors[0]}` : ''),
        );
      }
    }),
  );

  const times = results.map((r) => r.time);
  const lat = results.flatMap((r) => r.latencies);
  console.log(`\n=== Resumen (${((performance.now() - t0) / 1000).toFixed(1)}s) ===`);
  console.log(`Victorias:            ${results.filter((r) => r.won).length}/${results.length}`);
  console.log(`Supervivencia media:  ${fmt(avg(times))} (mediana ${fmt(median(times))}, mín ${fmt(Math.min(...times))}, máx ${fmt(Math.max(...times))})`);
  console.log(`Construcciones/part.: ${avg(results.map((r) => r.fencesBuilt)).toFixed(1)} (rotas ${avg(results.map((r) => r.fencesDestroyed)).toFixed(1)})`);
  console.log(`Lana comida/partida:  ${avg(results.map((r) => r.woolEaten)).toFixed(1)}`);
  console.log(`Te ven / escapas:     ${avg(results.map((r) => r.spotted)).toFixed(1)} / ${avg(results.map((r) => r.escapes)).toFixed(1)} por partida`);
  console.log(`Puntos por partida:   ${avg(results.map((r) => r.score)).toFixed(0)} (máx ${Math.max(...results.map((r) => r.score))}) · por los pelos ${avg(results.map((r) => r.closeCalls)).toFixed(1)}`);
  if (extras) {
    console.log(`Torre / piñas:        ${avg(results.map((r) => r.towerTime)).toFixed(0)}s en torre, ${avg(results.map((r) => r.towersBuilt)).toFixed(1)} torres, ${avg(results.map((r) => r.throws)).toFixed(1)} piñas por partida`);
  }
  if (lat.length) {
    console.log(`Latencia del cerebro: media ${avg(lat).toFixed(0)}ms, mediana ${median(lat).toFixed(0)}ms`);
    console.log(`Coste total:          $${results.reduce((a, r) => a + r.cost, 0).toFixed(5)}`);
  }

  mkdirSync('public/replays', { recursive: true });
  const sorted = [...results].sort((a, b) => a.time - b.time);
  const save = (name: string, r: GameResult) => {
    writeFileSync(`public/replays/${name}.json`, JSON.stringify(r.replay));
    console.log(`Repetición: http://localhost:5173/?replay=${name}   (${fmt(r.time)}, semilla ${r.seed})`);
  };
  console.log('');
  save(`${brainName}-peor`, sorted[0]);
  save(`${brainName}-mejor`, sorted[sorted.length - 1]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
