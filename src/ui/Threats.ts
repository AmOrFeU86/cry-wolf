// Flechas en el borde de la pantalla hacia los lobos que te ven (rojo) o te buscan (amarillo),
// y una viñeta roja cuando un lobo está a punto de saltarte.
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { World } from '../sim/World';

const SEARCH_RANGE = 22; // los que te buscan solo se marcan si están cerca

export class Threats {
  private root = document.getElementById('threats')!;
  private vignette = document.getElementById('vignette')!;
  private arrows = new Map<number, HTMLElement>();
  private v = new THREE.Vector3();
  private time = 0;

  update(world: World, camera: THREE.Camera, dt: number, visible: boolean): void {
    this.time += dt;
    const s = world.sheep.pos;
    const alive = new Set<number>();
    let pounce = 0;
    let seen = false;

    if (visible) {
      for (const w of world.wolves) {
        const d = Math.hypot(w.pos.x - s.x, w.pos.z - s.z);
        if ((w.phase === 'windup' || w.phase === 'pounce') && d < CONFIG.wolf.pounceRange + 2) pounce = 1;
        if (w.mode === 'hunt') seen = true;
        const kind = w.mode === 'hunt' ? 'seen' : w.mode !== 'wander' && d < SEARCH_RANGE ? 'search' : null;
        if (!kind) continue;

        // ¿se ve en pantalla? entonces no hace falta flecha
        this.v.set(w.pos.x, 0.8, w.pos.z).project(camera);
        const behind = this.v.z > 1;
        if (!behind && Math.abs(this.v.x) < 0.9 && Math.abs(this.v.y) < 0.85) continue;

        let x = this.v.x;
        let y = this.v.y;
        if (behind) {
          x = -x;
          y = -Math.abs(y) - 1; // detrás de la cámara: abajo
        }
        const a = Math.atan2(x, y); // 0 = arriba, en sentido horario
        alive.add(w.id);
        let el = this.arrows.get(w.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'threat';
          this.root.appendChild(el);
          this.arrows.set(w.id, el);
        }
        el.className = `threat ${kind}`;
        // sobre una elipse pegada al borde, más opaca cuanto más cerca
        const px = 50 + Math.sin(a) * 44;
        const py = 50 - Math.cos(a) * 42;
        el.style.left = `${px}%`;
        el.style.top = `${py}%`;
        el.style.transform = `translate(-50%, -50%) rotate(${a}rad) scale(${0.8 + 0.6 * Math.max(0, 1 - d / 20)})`;
        el.style.opacity = String(kind === 'seen' ? 1 : 0.4 + 0.5 * Math.max(0, 1 - d / SEARCH_RANGE));
      }
    }
    for (const [id, el] of this.arrows) {
      if (alive.has(id)) continue;
      el.remove();
      this.arrows.delete(id);
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.time * 8);
    const target = visible ? (pounce ? 0.85 : seen ? 0.18 + 0.1 * pulse : 0) : 0;
    const cur = Number(this.vignette.style.opacity || 0);
    this.vignette.style.opacity = String(cur + (target - cur) * Math.min(1, dt * (target > cur ? 20 : 5)));
  }
}
