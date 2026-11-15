import { CONFIG } from '../config';
import type { World } from '../sim/World';
import type { InputController } from './InputController';
import { isTouchMode, onTouchModeChange } from './touchMode';

/** Radio del joystick (px): el mando llega a tope aquí; más allá de SPRINT_AT × radio, la oveja corre. */
const STICK_R = 56;
const SPRINT_AT = 1.45;
const DEAD = 0.15;

type Act = 'dash' | 'action' | 'build' | 'place' | 'remove' | 'pause';

/**
 * Mandos para jugar con el dedo: joystick a la izquierda (aparece donde tocas),
 * arrastrar en el resto de la pantalla para girar la cámara y botones a la derecha.
 * Solo se ven en modo táctil (clase `touch` en <body>, ver touchMode.ts).
 */
export class TouchControls {
  private layer = document.createElement('div');
  private base = document.createElement('div');
  private knob = document.createElement('div');
  private buttons = new Map<Act, HTMLElement>();
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private active = false;

  constructor(
    private controls: InputController,
    private onPause: () => void,
  ) {
    const hud = document.getElementById('hud')!;
    this.layer.id = 'touch';
    this.base.className = 'stick-base';
    this.knob.className = 'stick-knob';
    this.base.appendChild(this.knob);
    this.layer.appendChild(this.base);

    const pad = document.createElement('div');
    pad.id = 'touch-pad';
    const defs: [Act, string, string][] = [
      ['remove', '✖', 'Quitar'],
      ['place', '➕', 'Poner'],
      ['action', '🌿', 'Comer'],
      ['build', '🔨', 'Construir'],
      ['dash', '💨', 'Esquivar'],
    ];
    for (const [act, icon, label] of defs) pad.appendChild(this.button(act, icon, label));
    this.layer.appendChild(pad);
    this.layer.appendChild(this.button('pause', '⏸', ''));
    // detrás del resto del HUD: los textos dejan pasar el dedo hasta esta capa
    hud.insertBefore(this.layer, hud.firstChild);

    this.layer.addEventListener('pointerdown', (e) => this.down(e));
    this.layer.addEventListener('pointermove', (e) => this.move(e));
    this.layer.addEventListener('pointerup', (e) => this.up(e));
    this.layer.addEventListener('pointercancel', (e) => this.up(e));
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());

    // la barra de piezas se elige tocando
    document.querySelectorAll<HTMLElement>('#hotbar .slot').forEach((slot, k) => {
      slot.addEventListener('pointerdown', (e) => {
        if (!isTouchMode()) return;
        e.preventDefault();
        e.stopPropagation();
        this.controls.selectItem(k);
      });
    });

    onTouchModeChange(() => this.release());
    this.resetStick();
  }

  private button(act: Act, icon: string, label: string): HTMLElement {
    const b = document.createElement('div');
    b.className = 'tbtn';
    b.dataset.act = act;
    b.innerHTML = `<span class="icon">${icon}</span>${label ? `<span class="label">${label}</span>` : ''}`;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* sin captura */
      }
      b.classList.add('pressed');
      this.press(act, true);
    });
    const release = (e: PointerEvent) => {
      e.stopPropagation();
      if (!b.classList.contains('pressed')) return;
      b.classList.remove('pressed');
      this.press(act, false);
    };
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    this.buttons.set(act, b);
    return b;
  }

  private press(act: Act, down: boolean): void {
    const c = this.controls;
    if (!c.enabled && act !== 'pause') return;
    switch (act) {
      case 'dash':
        if (down) c.dash();
        break;
      case 'action':
        c.touchAction = down;
        break;
      case 'build':
        if (down) c.toggleBuild();
        break;
      case 'place':
        c.setPlace(down);
        break;
      case 'remove':
        c.setRemove(down);
        break;
      case 'pause':
        if (down) this.onPause();
        break;
    }
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse' || !this.active) return;
    e.preventDefault();
    try {
      this.layer.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura */
    }
    // mitad izquierda: joystick (no en repeticiones); el resto: cámara
    if (this.stickId === null && e.clientX < window.innerWidth * 0.45 && !this.controls.spectator) {
      this.stickId = e.pointerId;
      const m = STICK_R + 12;
      this.stickOrigin = {
        x: Math.max(m, Math.min(window.innerWidth - m, e.clientX)),
        y: Math.max(m, Math.min(window.innerHeight - m, e.clientY)),
      };
      this.base.classList.add('active');
      this.placeBase(this.stickOrigin.x, this.stickOrigin.y);
      this.moveStick(e.clientX, e.clientY);
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      this.moveStick(e.clientX, e.clientY);
    } else if (e.pointerId === this.lookId) {
      e.preventDefault();
      this.controls.look(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.resetStick();
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
  }

  private moveStick(x: number, y: number): void {
    const dx = x - this.stickOrigin.x;
    const dy = y - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    const mag = len / STICK_R;
    // zona muerta y respuesta progresiva: a medio recorrido ya va a toda velocidad de paso
    const a = Math.max(0, Math.min(1, (mag - DEAD) / 0.6));
    const ux = len > 0 ? dx / len : 0;
    const uy = len > 0 ? dy / len : 0;
    this.controls.stick.side = ux * a;
    this.controls.stick.fwd = -uy * a;
    const sprint = mag >= SPRINT_AT;
    this.controls.touchSprint = sprint;
    this.base.classList.toggle('sprint', sprint);
    const k = Math.min(len, STICK_R);
    this.knob.style.transform = `translate(${ux * k}px, ${uy * k}px)`;
  }

  private placeBase(x: number, y: number): void {
    this.base.style.left = `${x}px`;
    this.base.style.top = `${y}px`;
  }

  /** El joystick en reposo: abajo a la izquierda, semitransparente (para que se sepa que está ahí). */
  private resetStick(): void {
    this.controls.stick.fwd = this.controls.stick.side = 0;
    this.controls.touchSprint = false;
    this.base.classList.remove('active', 'sprint');
    this.knob.style.transform = '';
    this.base.style.left = '';
    this.base.style.top = '';
  }

  /** Suelta todo (al pausar, al acabar o al cambiar a ratón). */
  release(): void {
    this.stickId = this.lookId = null;
    this.resetStick();
    for (const [act, b] of this.buttons) {
      if (b.classList.contains('pressed')) {
        b.classList.remove('pressed');
        if (act !== 'pause') this.press(act, false);
      }
    }
    this.controls.touchAction = false;
    this.controls.setPlace(false);
    this.controls.setRemove(false);
  }

  /** Cada frame: qué se ve y qué dice cada botón. */
  update(world: World, playing: boolean): void {
    const active = playing && isTouchMode();
    if (active !== this.active) {
      this.active = active;
      if (!active) this.release();
    }
    this.layer.classList.toggle('off', !active);
    if (!active) return;
    const c = this.controls;
    this.layer.classList.toggle('building', c.buildMode && !c.spectator);
    this.layer.classList.toggle('spectator', c.spectator);
    const s = world.sheep;
    // el botón de acción dice lo que hará: comer, subir a la torre o nada
    const action = this.buttons.get('action')!;
    const label = world.nearTower && !c.buildMode ? ['🗼', 'Subir'] : ['🌿', 'Comer'];
    const html = `<span class="icon">${label[0]}</span><span class="label">${label[1]}</span>`;
    if (action.dataset.html !== html) {
      action.dataset.html = html;
      action.innerHTML = html;
    }
    action.classList.toggle('dim', !world.nearTower && !world.nearGrass && !s.eating && s.climb === 0);
    const dash = this.buttons.get('dash')!;
    dash.classList.toggle('dim', s.dashCooldown > 0);
    dash.style.setProperty('--cd', String(Math.max(0, Math.min(1, s.dashCooldown / CONFIG.sheep.dashCooldown))));
    const dashLabel = s.tower ? 'Saltar' : 'Esquivar';
    const lab = dash.querySelector('.label')!;
    if (lab.textContent !== dashLabel) lab.textContent = dashLabel;
    this.buttons.get('build')!.classList.toggle('on', c.buildMode);
  }
}
