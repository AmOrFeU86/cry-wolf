/**
 * Modo táctil: se decide por cómo se juega, no por el aparato.
 * Un toque en la pantalla lo activa; usar un ratón de verdad lo desactiva
 * (así un portátil con pantalla táctil sigue jugándose con ratón y teclado).
 * Mientras está activo, <body> lleva la clase `touch` y el CSS muestra los controles táctiles.
 */
type Listener = (touch: boolean) => void;

let active = false;
const listeners: Listener[] = [];

function set(v: boolean): void {
  if (v === active) return;
  active = v;
  document.body.classList.toggle('touch', v);
  for (const l of listeners) l(v);
}

export const isTouchMode = (): boolean => active;

export function onTouchModeChange(l: Listener): void {
  listeners.push(l);
}

// captura: se entera antes que nadie (y aunque otro manejador pare la propagación)
window.addEventListener('touchstart', () => set(true), { capture: true, passive: true });
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') set(true);
    else if (e.pointerType === 'mouse') set(false);
  },
  { capture: true },
);
// un ratón que se mueve de verdad (los navegadores a veces simulan un mousemove tras un toque, sin desplazamiento)
let mouseTravel = 0;
window.addEventListener(
  'pointermove',
  (e) => {
    if (!active || e.pointerType !== 'mouse') return;
    mouseTravel += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (mouseTravel > 40) {
      mouseTravel = 0;
      set(false);
    }
  },
  { capture: true },
);
window.addEventListener('touchend', () => (mouseTravel = 0), { capture: true, passive: true });
