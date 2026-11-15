import type { PlayerInput } from '../sim/entities';
import type { Vec2 } from '../sim/Grid';
import { ITEMS, type ItemId } from '../sim/pieces';

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
  /**
   * Modo niño: sin ratón. Cámara fija (flechas o WASD mueven hacia donde apuntan en pantalla),
   * siempre en modo construcción delante de la oveja: F/Enter/click construir, Q cambiar pieza, X quitar.
   */
  kid = false;
  /** Punto del suelo bajo la mira (lo calcula el render con la cámara). */
  aimAt: Vec2 | null = null;
  private keys = new Set<string>();
  private dashQueued = false;
  private placeQueued = false;
  private removeQueued = false;
  private placeHeld = false;
  private removeHeld = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      if (e.code === 'Space') e.preventDefault();
      // modo niño: que Enter no pulse el último botón del menú ni las flechas muevan la página
      if (this.kid && (e.code === 'Enter' || e.code.startsWith('Arrow'))) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyB' && !this.kid) this.buildMode = !this.buildMode;
      if (e.code === 'Space') this.dashQueued = true;
      if ((e.code === 'KeyF' || (this.kid && e.code === 'Enter')) && this.buildMode) this.placeQueued = true;
      if (e.code === 'KeyX' && this.buildMode) this.removeQueued = true;
      if (this.kid && (e.code === 'KeyQ' || e.code === 'Tab')) {
        e.preventDefault();
        this.cycle(1);
      }
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit && !this.spectator && Number(digit[1]) <= ITEMS.length) {
        this.item = Number(digit[1]) - 1;
        this.buildMode = true;
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.spectator) return;
      if (!this.locked && !this.kid) {
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
        this.cycle(e.deltaY > 0 ? 1 : -1);
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

  /** Pasar a la pieza siguiente (o anterior), saltando lo que aún está bloqueado. */
  private cycle(step: number): void {
    const n = ITEMS.length;
    for (let k = 0; k < n; k++) {
      this.item = (this.item + step + n) % n;
      if (this.items.includes(ITEMS[this.item])) break;
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  lock(): void {
    if (this.kid) return; // sin ratón: no hace falta capturarlo
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
    this.buildMode = this.kid;
    this.item = 0;
    this.dashQueued = false;
    this.placeQueued = false;
    this.removeQueued = false;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.placeHeld = false;
    this.removeHeld = false;
  }

  update(dt: number): void {
    if (this.kid) return; // cámara fija: las flechas mueven la oveja
    // Flechas izquierda/derecha giran la cámara sin ratón
    const left = this.has('ArrowLeft') ? 1 : 0;
    const right = this.has('ArrowRight') ? 1 : 0;
    this.yaw += (left - right) * 2.2 * dt;
  }

  private has(code: string): boolean {
    return this.keys.has(code);
  }

  getInput(): PlayerInput {
    const up = this.has('KeyW') || (this.kid && this.has('ArrowUp'));
    const down = this.has('KeyS') || (this.kid && this.has('ArrowDown'));
    const right = this.has('KeyD') || (this.kid && this.has('ArrowRight'));
    const left = this.has('KeyA') || (this.kid && this.has('ArrowLeft'));
    const fwd = (up ? 1 : 0) - (down ? 1 : 0);
    const side = (right ? 1 : 0) - (left ? 1 : 0);
    // Cámara en (sin yaw, cos yaw) respecto a la oveja → adelante = -(sin, cos)
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const input: PlayerInput = {
      moveX: fx * fwd + rx * side,
      moveZ: fz * fwd + rz * side,
      // modo niño: construir justo delante de la oveja, hacia donde mira
      aimX: this.kid ? 0 : fx,
      aimZ: this.kid ? 0 : fz,
      aimAt: this.kid ? null : this.aimAt,
      sprint: this.has('ShiftLeft') || this.has('ShiftRight'),
      dash: this.dashQueued,
      // E es la tecla de acción: comer hierba o, junto a una torre, subir
      // modo niño: come sola al quedarse quieta junto a la hierba
      eat: this.kid || this.has('KeyE'),
      climb: this.has('KeyE'),
      buildMode: this.buildMode,
      item: ITEMS[this.item],
      place: this.buildMode && (this.placeQueued || this.placeHeld),
      remove: this.buildMode && (this.removeQueued || this.removeHeld),
    };
    this.dashQueued = false;
    this.placeQueued = false;
    this.removeQueued = false;
    return input;
  }
}
