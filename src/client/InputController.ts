import type { PlayerInput } from '../sim/entities';
import type { Vec2 } from '../sim/Grid';
import { ITEMS, type ItemId } from '../sim/pieces';
import { isTouchMode } from './touchMode';

/** Traduce teclado y ratón a PlayerInput y controla la cámara orbital. */
export class InputController {
  yaw = 0;
  pitch = 0.55;
  buildMode = false;
  /** Lo elegido en la barra (índice en ITEMS). */
  item = 0;
  /** Lo desbloqueado en esta noche: la rueda solo pasa por esto. */
  items: ItemId[] = [...ITEMS];
  enabled = false;
  /** Modo espectador (repeticiones): arrastrar con el ratón gira la cámara, sin capturar el puntero. */
  spectator = false;
  /** Punto del suelo bajo la mira (lo calcula el render con la cámara). */
  aimAt: Vec2 | null = null;
  private keys = new Set<string>();
  private dashQueued = false;
  private placeQueued = false;
  private removeQueued = false;
  private placeHeld = false;
  private removeHeld = false;
  /** Mandos táctiles (los rellena TouchControls): stick analógico (adelante, derecha) en [-1, 1]. */
  stick = { fwd: 0, side: 0 };
  touchSprint = false;
  touchAction = false;
  private touchPlace = false;
  private touchRemove = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyB') this.buildMode = !this.buildMode;
      if (e.code === 'Space') this.dashQueued = true;
      if (e.code === 'KeyF' && this.buildMode) this.placeQueued = true;
      if (e.code === 'KeyX' && this.buildMode) this.removeQueued = true;
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && !this.spectator && Number(digit[1]) <= ITEMS.length) {
        this.item = Number(digit[1]) - 1;
        this.buildMode = true;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.spectator || isTouchMode()) return;
      if (!this.locked) {
        this.lock();
        return;
      }
      if (e.button === 0 && this.buildMode) this.placeHeld = this.placeQueued = true;
      if (e.button === 2) {
        // fuera del modo construcción el click derecho lo activa; dentro, desmonta
        if (this.buildMode) this.removeHeld = this.removeQueued = true;
        else this.buildMode = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.placeHeld = false;
      if (e.button === 2) this.removeHeld = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled || this.spectator || !this.buildMode) return;
        e.preventDefault();
        const n = ITEMS.length;
        const step = e.deltaY > 0 ? 1 : -1;
        // saltar lo que aún está bloqueado
        for (let k = 0; k < n; k++) {
          this.item = (this.item + step + n) % n;
          if (this.items.includes(ITEMS[this.item])) break;
        }
      },
      { passive: false },
    );
    document.addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.spectator && e.buttons & 1)) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch = Math.max(0.12, Math.min(1.25, this.pitch + e.movementY * 0.002));
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) this.releaseAll();
    });
  }

  // ---------------------------------------------------------------- órdenes desde los mandos táctiles

  /** Girar la cámara con el dedo (en píxeles de pantalla). */
  look(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(0.12, Math.min(1.25, this.pitch + dy * 0.005));
  }

  dash(): void {
    this.dashQueued = true;
  }

  toggleBuild(): void {
    this.buildMode = !this.buildMode;
    if (!this.buildMode) this.touchPlace = this.touchRemove = false;
  }

  /** Mantener pulsado el botón de colocar (construye en fila como el click mantenido). */
  setPlace(held: boolean): void {
    if (held && this.buildMode) this.placeQueued = true;
    this.touchPlace = held;
  }

  setRemove(held: boolean): void {
    if (held && this.buildMode) this.removeQueued = true;
    this.touchRemove = held;
  }

  selectItem(k: number): void {
    if (k < 0 || k >= ITEMS.length) return;
    this.item = k;
    this.buildMode = true;
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  lock(): void {
    // Si el navegador no deja (iframe, etc.) se puede jugar igual con Q/E
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p instanceof Promise) p.catch(() => {});
    } catch {
      /* sin pointer lock */
    }
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  reset(): void {
    this.releaseAll();
    this.buildMode = false;
    this.item = 0;
    this.dashQueued = false;
    this.placeQueued = false;
    this.removeQueued = false;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.placeHeld = false;
    this.removeHeld = false;
    this.stick.fwd = this.stick.side = 0;
    this.touchSprint = this.touchAction = this.touchPlace = this.touchRemove = false;
  }

  update(dt: number): void {
    // Flechas izquierda/derecha giran la cámara sin ratón
    const left = this.has('ArrowLeft') ? 1 : 0;
    const right = this.has('ArrowRight') ? 1 : 0;
    this.yaw += (left - right) * 2.2 * dt;
  }

  private has(code: string): boolean {
    return this.keys.has(code);
  }

  getInput(): PlayerInput {
    const fwd = (this.has('KeyW') ? 1 : 0) - (this.has('KeyS') ? 1 : 0) + this.stick.fwd;
    const side = (this.has('KeyD') ? 1 : 0) - (this.has('KeyA') ? 1 : 0) + this.stick.side;
    // Cámara en (sin yaw, cos yaw) respecto a la oveja → adelante = -(sin, cos)
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const input: PlayerInput = {
      moveX: fx * fwd + rx * side,
      moveZ: fz * fwd + rz * side,
      aimX: fx,
      aimZ: fz,
      aimAt: this.aimAt,
      sprint: this.has('ShiftLeft') || this.has('ShiftRight') || this.touchSprint,
      dash: this.dashQueued,
      // E es la tecla de acción: comer hierba o, junto a una torre, subir
      eat: this.has('KeyE') || this.touchAction,
      climb: this.has('KeyE') || this.touchAction,
      buildMode: this.buildMode,
      item: ITEMS[this.item],
      place: this.buildMode && (this.placeQueued || this.placeHeld || this.touchPlace),
      remove: this.buildMode && (this.removeQueued || this.removeHeld || this.touchRemove),
    };
    this.dashQueued = false;
    this.placeQueued = false;
    this.removeQueued = false;
    return input;
  }
}
