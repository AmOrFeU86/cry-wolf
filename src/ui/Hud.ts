import { CONFIG } from '../config';
import { unlockNight } from '../sim/nights';
import { itemInfo, ITEMS, type ItemId } from '../sim/pieces';
import type { World } from '../sim/World';
import { dayIcon, dayProgress } from '../render/DayCycle';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private hud = $('hud');
  private timer = $('timer');
  private daytime = $('daytime');
  private wool = $('wool');
  private wolves = $('wolves');
  private night = $('night');
  private staminaFill = $('stamina-fill');
  private dash = $('dash');
  private mode = $('mode');
  private hint = $('hint');
  private phase = $('phase');
  private crosshair = $('crosshair');
  private hotbar = $('hotbar');
  private lives = $('lives');
  private help = $('help');
  private helpText = this.help.textContent ?? '';
  private slots: HTMLElement[];

  constructor() {
    this.slots = ITEMS.map((id, k) => {
      const p = itemInfo(id);
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${k + 1}</span><div class="icon">${p.icon}</div>${p.name}<div class="cost">${p.cost} 🧶</div>`;
      this.hotbar.appendChild(el);
      return el;
    });
  }

  show(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
  }

  /** item: lo elegido en la barra; null para ocultar la barra (repeticiones). touch: botones en pantalla; kid: controles del modo niño. */
  update(world: World, buildMode: boolean, item: ItemId | null = null, touch = false, kid = false): void {
    // los avisos nombran la tecla o, en modo táctil, el botón de la pantalla (en modo niño no se usa el ratón)
    const k = touch
      ? { place: '➕ Poner', remove: '✖ Quitar', act: '🌿', climb: '🗼 Subir', jump: '💨 Saltar: bajar' }
      : { place: kid ? 'F' : 'Click', remove: kid ? 'X' : 'Click derecho', act: 'E', climb: 'E', jump: 'Espacio: saltar abajo' };
    const prep = world.preparing;
    const remaining = prep
      ? CONFIG.prepTime - world.time
      : Math.max(0, CONFIG.prepTime + world.survivalTime - world.time);
    this.timer.textContent = formatTime(remaining);
    this.timer.classList.toggle('urgent', remaining <= 10);
    const icon = dayIcon(dayProgress(world));
    if (this.daytime.textContent !== icon) this.daytime.textContent = icon;

    let phase = '';
    let cls = '';
    if (prep) {
      phase = '🛠 Prepárate: los lobos llegan pronto';
    } else if (world.wolves.some((w) => w.mode === 'hunt' && (w.prey === null || w.prey === world.sheep.id))) {
      phase = '👁 ¡Te han visto!';
      cls = 'seen';
    } else if (world.wolves.some((w) => w.mode === 'hunt')) {
      phase = '🐺 ¡Persiguen a una compañera!';
      cls = 'searched';
    } else if (world.wolves.some((w) => w.mode === 'track')) {
      phase = '👃 Siguen tu rastro';
      cls = 'searched';
    } else if (world.wolves.some((w) => w.mode === 'search' || w.mode === 'investigate')) {
      phase = '❓ Te están buscando';
      cls = 'searched';
    } else {
      phase = '🤫 No saben dónde estás';
    }
    this.phase.textContent = phase;
    this.phase.className = cls;

    const s = world.sheep;
    this.wool.textContent = String(Math.floor(s.wool));
    this.wolves.textContent = String(world.wolves.length);
    this.night.textContent = String(world.nightIndex + 1);
    this.staminaFill.style.width = `${(s.stamina / CONFIG.sheep.staminaMax) * 100}%`;
    this.staminaFill.classList.toggle('exhausted', s.exhausted);
    this.dash.textContent = s.dashCooldown > 0 ? `Esquive ${s.dashCooldown.toFixed(1)}s` : 'Esquive listo';
    this.dash.classList.toggle('ready', s.dashCooldown <= 0);
    // modo niño: siempre construyendo delante de la oveja, sin mira
    this.mode.classList.toggle('hidden', !buildMode || kid);
    this.crosshair.classList.toggle('hidden', !buildMode || item === null || kid);
    this.hotbar.classList.toggle('hidden', !buildMode || item === null);
    ITEMS.forEach((id, k) => {
      this.slots[k].classList.toggle('selected', id === item);
      this.slots[k].classList.toggle('poor', s.wool < itemInfo(id).cost);
      this.slots[k].classList.toggle('locked', !world.items.includes(id));
    });

    this.lives.classList.toggle('hidden', !s.kid);
    if (s.kid) {
      const hearts = '❤️'.repeat(s.lives) + '🤍'.repeat(Math.max(0, CONFIG.kid.lives - s.lives));
      if (this.lives.textContent !== hearts) this.lives.textContent = hearts;
    }
    const help = kid
      ? 'Flechas mover · Shift correr · Espacio esquivar · F construir · Q cambiar pieza · X quitar · E subir · Esc pausa'
      : this.helpText;
    if (item !== null && this.help.textContent !== help) this.help.textContent = help;

    const bt = world.buildTarget;
    let hint = '';
    const towerHp = s.tower ? world.grid.hp[s.tower[1] * world.grid.n + s.tower[0]] / CONFIG.pieces.tower.hp : 0;
    if (s.safe > 0) {
      hint = '✨ ¡A salvo! Los lobos no te ven un momento';
    } else if (s.crossing) {
      hint = '🌉 Cruzando el puente... (date la vuelta para volver)';
    } else if (buildMode && bt?.locked) {
      hint = `🔒 ${itemInfo(bt.item).name}: se desbloquea al llegar a la noche ${unlockNight(bt.item) + 1}`;
    } else if (buildMode && bt?.item === 'bridge') {
      hint = !s.tower
        ? 'Sube a una torre para tender un puente'
        : bt.poor
          ? `Necesitas ${CONFIG.bridge.cost} de lana`
          : bt.valid
            ? `${k.place}: tender el puente hasta esa torre`
            : kid
              ? `Mira hacia otra torre a menos de ${CONFIG.bridge.range} m`
              : `Apunta a otra torre a menos de ${CONFIG.bridge.range} m`;
    } else if (s.tower) {
      const biting = world.wolves.some((w) => w.attacking?.[0] === s.tower![0] && w.attacking[1] === s.tower![1]);
      const bridge = world.bridges.some((b) => (b.a[0] === s.tower![0] && b.a[1] === s.tower![1]) || (b.b[0] === s.tower![0] && b.b[1] === s.tower![1]));
      hint = `🗼 En la torre (${Math.ceil(towerHp * 100)}%)${biting ? ' · ¡La están mordiendo!' : ''} · ${k.jump}${bridge ? ' · Muévete hacia el puente para cruzar' : ''}`;
    } else if (s.stun > 0) {
      hint = '💫 ¡Has caído!';
    } else if (s.climb > 0) {
      hint = 'Subiendo...';
    } else if (world.nearTower && (!buildMode || kid)) {
      hint = `Mantén ${k.climb} para subir a la torre`;
    } else if (buildMode && bt?.item === 'pinecone' && !bt.poor) {
      hint = s.throwCooldown > 0 ? `Piña lista en ${s.throwCooldown.toFixed(1)}s` : `${k.place}: lanzar piña (hace ruido donde cae y atrae a los lobos)`;
    } else if (buildMode && bt?.removable) {
      const p = CONFIG.pieces[bt.removable];
      hint = `${k.remove}: desmontar ${p.name.toLowerCase()} (recuperas lana)`;
    } else if (buildMode && bt?.poor) {
      hint = `Necesitas ${itemInfo(bt.item).cost} de lana: come hierba${kid ? '' : ` (${k.act})`}`;
    } else if (world.nearGrass && !s.eating) {
      hint = kid ? 'Quédate quieta para comer hierba' : `Mantén ${k.act} para comer hierba`;
    } else if (s.eating) {
      hint = 'Ñam ñam...';
    }
    this.hint.textContent = hint;
  }
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
