import { CONFIG } from '../config';
import type { PieceId } from '../sim/pieces';
import type { World } from '../sim/World';
import { observe } from './observe';
import { ACTIONS, type Action } from './Pilot';

export interface Decision {
  action: Action;
  probs?: Record<string, number>;
  latencyMs?: number;
  cost?: number;
  error?: string;
}

/** "El cerebro": decide qué hacer. El Pilot se encarga de cómo. */
export interface Brain {
  readonly name: string;
  decide(world: World): Promise<Decision>;
}

/** Reglas simples, gratis y deterministas. Sirve de referencia para comparar. */
export class ScriptedBrain implements Brain {
  readonly name = 'scripted';

  constructor(
    private piece: PieceId = 'fence',
    private extras = false,
  ) {}

  async decide(world: World): Promise<Decision> {
    const o = observe(world, this.piece, this.extras);
    const w = o.wolves[0];
    const hunter = o.wolves.find((x) => x.sees_sheep);
    if ('on_tower' in o) {
      // torre: subir si nos cazan de cerca y hay (o se puede hacer) una; bajar cuando esté a punto de caer
      if (o.on_tower) return { action: (o.tower_health_percent ?? 0) < 30 && (!w || w.distance > 2.5) ? 'flee' : 'tower' };
      // subir lleva tiempo (llegar + 1 s quieta): solo si el lobo está lo bastante lejos
      const towerD = o.nearest_tower_distance ?? Infinity;
      const canReach = hunter && hunter.distance > 6 + towerD * 0.5;
      if (hunter && hunter.distance < 12 && canReach && (towerD < 5 || o.wool >= o.tower_cost)) return { action: 'tower' };
      const searcher = o.wolves.find((x) => !x.sees_sheep && x.state !== 'wandering_unaware' && x.distance < 14);
      if (searcher && o.pinecone_ready) return { action: 'distract' };
    }
    if (hunter && hunter.distance < 7 && hunter.has_clear_path_to_sheep && o.wool >= o.build_cost && hunter.distance > 2.5) {
      return { action: 'build' };
    }
    if (hunter && hunter.distance < 14) return { action: 'flee' };
    if (w && w.distance < 7) return { action: 'flee' };
    if (o.nearest_grass && o.nearest_grass.nearest_wolf_distance > 8) return { action: 'eat' };
    return { action: 'flee' };
  }
}

const INSTRUCTIONS = `You control a sheep in a survival game. Wolves chase the sheep; if a wolf touches it, the game is lost.
The goal is to survive until seconds_left reaches 0. More wolves arrive over time.
The first seconds are calm (seconds_until_wolves_arrive): a good time to eat and gather wool.
Wolves do not know where the sheep is: they wander, they see it only within ~16 m if no trees/rocks are in the way, and they hear sprinting, dodging and building.
Wolves see in a ~115 degree cone in front of them (and notice the sheep within 2.5 m even from behind).
At the end of the game night falls (night_darkness_percent): in the dark wolves see much less far, but they smell the scent trail from farther away.
The sheep leaves a scent trail that fades in 25 s; a wolf that crosses it follows it at a speed a bit slower than the sheep's walk, so standing still for long is risky.
A wolf that sees the sheep howls and calls nearby wolves. Breaking line of sight behind trees makes it lose the sheep and search the area.
Wolves run slightly faster than the sheep walks, but the sheep can sprint while it has stamina, and turns faster than wolves.
When a wolf gets within ~4.5 m it crouches and pounces in a straight line; the sheep dodges pounces automatically, and a wolf is slow for a moment after pouncing (a good time to get away).
Eating grass gives wool. Wool builds barriers (build_cost each) that block wolves until they chew through them.
Distances are in meters. Pick the single best action for the next half second.`;

const EXTRAS = `
Towers: the sheep can climb a tower (on_tower) to be safe from wolves while it stands; when it is about to fall (low tower_health_percent), choosing any action other than tower or distract makes the sheep jump down and run.
Pinecones: thrown far away, they make a noise that lures searching wolves away from the sheep.`;

/** Cómo es la barrera que construye 'build', para que el modelo sepa cuándo le conviene. */
const BARRIER: Record<PieceId, string> = {
  fence: 'The barrier is a wooden fence: wolves can see through it, it takes them ~5 s to chew through.',
  hedge: "The barrier is a hedge: it BLOCKS the wolves' line of sight (a wolf that loses sight of the sheep goes searching), but they chew through it in ~3 s.",
  wall: 'The barrier is a stone wall: it blocks line of sight and takes wolves ~15 s to chew through, but it is expensive.',
  gate: 'The barrier is a gate: it blocks line of sight, the sheep can walk through it but wolves must chew through it (~7 s).',
  tower: 'The barrier is a tower: it blocks line of sight and takes wolves ~20 s to chew through.',
};

const criteria = (piece: PieceId, extras: boolean): Partial<Record<Action, string>> => ({
  flee: 'Run away from the wolves and try to hide behind trees, sprinting only if a wolf that sees the sheep is close (sprinting is noisy).',
  eat: 'Go to the nearest safe grass and eat it to gain wool. Dangerous if a wolf is close.',
  build: `Back away from the nearest wolf while placing barriers between it and the sheep. Needs wool >= build_cost. ${BARRIER[piece]}`,
  ...(extras && {
    tower:
      `Go to the nearest tower (or build one next to the sheep if wool >= tower_cost) and climb it (takes ${CONFIG.tower.climbTime} s standing still). ` +
      'On top wolves cannot catch the sheep for as long as the tower stands: about 20 s with one wolf biting it, less with several (wolves_biting_tower). ' +
      'Up there wolves see the sheep from farther away and it cannot eat, so it is a way to buy time, not to hide. ' +
      'A strong choice to escape a wolf that is chasing the sheep when a tower is close, and above all near the end: ' +
      'if seconds_left is smaller than the time the tower can still hold, climbing it and staying up wins the game. ' +
      'If already on_tower, choose this to stay up there.',
    distract:
      'Throw a pinecone (pinecone_ready) beyond the nearest wolf that is searching for the sheep: it makes a noise where it lands and lures wolves that are not chasing the sheep away. ' +
      'If on_tower, the sheep throws from the top and stays there. Useless against a wolf that already sees the sheep.',
  }),
});

/** Cerebro con el modelo de decisiones typesafe/jev-1.14 vía OpenRouter. */
export class JevBrain implements Brain {
  readonly name = 'jev';
  totalCost = 0;
  calls = 0;
  errors = 0;

  constructor(
    private apiKey: string,
    private piece: PieceId = 'fence',
    private extras = false,
    private model = 'typesafe/jev-1.14',
  ) {}

  async decide(world: World): Promise<Decision> {
    const t0 = performance.now();
    try {
      const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          state: observe(world, this.piece, this.extras),
          questions: { action: { type: 'choice', instructions: INSTRUCTIONS + (this.extras ? EXTRAS : ''), criteria: criteria(this.piece, this.extras) } },
        }),
      });
      const latencyMs = performance.now() - t0;
      const json = (await res.json()) as {
        answers?: { action?: { choice?: string; probabilities?: Record<string, number> } };
        usage?: { cost?: number };
        error?: { message?: string };
      };
      this.calls++;
      const cost = json.usage?.cost ?? 0;
      this.totalCost += cost;
      const choice = json.answers?.action?.choice;
      if (!res.ok || !ACTIONS.includes(choice as Action)) {
        this.errors++;
        return { action: 'flee', latencyMs, error: json.error?.message ?? `respuesta inesperada (${res.status})` };
      }
      return { action: choice as Action, probs: json.answers?.action?.probabilities, latencyMs, cost };
    } catch (e) {
      this.errors++;
      return { action: 'flee', latencyMs: performance.now() - t0, error: String(e) };
    }
  }
}
