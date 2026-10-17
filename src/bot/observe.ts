import { CONFIG } from '../config';
import { Cell, isBuilt } from '../sim/Grid';
import type { PieceId } from '../sim/pieces';
import type { World } from '../sim/World';

const DIRS8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Dirección de brújula de un vector del mundo (norte = -z). */
export function compass(dx: number, dz: number): string {
  const k = Math.round(Math.atan2(dx, -dz) / (Math.PI / 4));
  return DIRS8[(k + 8) % 8];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Resumen compacto del estado del juego desde el punto de vista de la oveja. piece: lo que construye 'build'. */
export function observe(world: World, piece: PieceId = 'fence', extras = false) {
  const s = world.sheep;
  const wolves = world.wolves
    .map((w) => {
      const dx = w.pos.x - s.pos.x;
      const dz = w.pos.z - s.pos.z;
      return {
        distance: r1(Math.hypot(dx, dz)),
        direction: compass(dx, dz),
        biting_fence: w.attacking !== null,
        sees_sheep: w.sees,
        state:
          w.phase === 'windup' ? 'about_to_pounce'
          : w.phase === 'pounce' ? 'pouncing'
          : w.phase === 'recover' ? 'tired_after_pounce'
          : w.mode === 'hunt' ? 'chasing_sheep'
          : w.mode === 'search' ? 'searching_where_it_lost_the_sheep'
          : w.mode === 'investigate' ? 'going_to_check_a_noise'
          : w.mode === 'track' ? 'following_sheep_scent_trail'
          : 'wandering_unaware',
        has_clear_path_to_sheep: world.grid.lineOfSight(w.pos, s.pos, CONFIG.wolf.radius * 0.9),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);

  let grass: { distance: number; direction: string; nearest_wolf_distance: number } | null = null;
  for (const g of world.grass) {
    if (g.amount <= 0) continue;
    const d = Math.hypot(g.x - s.pos.x, g.z - s.pos.z);
    if (!grass || d < grass.distance) {
      const wolfD = Math.min(Infinity, ...world.wolves.map((w) => Math.hypot(w.pos.x - g.x, w.pos.z - g.z)));
      grass = { distance: r1(d), direction: compass(g.x - s.pos.x, g.z - s.pos.z), nearest_wolf_distance: r1(wolfD) };
    }
  }

  let built = 0;
  for (const c of world.grid.cells) if (isBuilt(c)) built++;

  const base = {
    seconds_until_wolves_arrive: Math.max(0, Math.ceil(CONFIG.prepTime - world.time)),
    seconds_left: Math.ceil(CONFIG.prepTime + world.survivalTime - world.time),
    wool: Math.floor(s.wool),
    build_cost: CONFIG.pieces[piece].cost,
    stamina_percent: Math.round((s.stamina / CONFIG.sheep.staminaMax) * 100),
    exhausted: s.exhausted,
    dash_ready: s.dashCooldown <= 0,
    wolves,
    nearest_grass: grass,
    barriers_on_map: built,
  };
  if (!extras) return base;

  // torre y piñas (solo si el bot puede usarlas)
  let towerD = Infinity;
  world.grid.cells.forEach((c, k) => {
    if (c !== Cell.Tower) return;
    const p = world.grid.center(k % world.grid.n, Math.floor(k / world.grid.n));
    towerD = Math.min(towerD, Math.hypot(p.x - s.pos.x, p.z - s.pos.z));
  });
  const t = s.tower;
  return {
    ...base,
    on_tower: t !== null,
    tower_health_percent: t ? Math.round((world.grid.hp[t[1] * world.grid.n + t[0]] / CONFIG.pieces.tower.hp) * 100) : null,
    wolves_biting_tower: t ? world.wolves.filter((w) => w.attacking && w.attacking[0] === t[0] && w.attacking[1] === t[1]).length : 0,
    nearest_tower_distance: towerD === Infinity ? null : r1(towerD),
    tower_cost: CONFIG.pieces.tower.cost,
    pinecone_ready: s.throwCooldown <= 0 && s.wool >= CONFIG.pinecone.cost,
  };
}

export type Observation = ReturnType<typeof observe>;
