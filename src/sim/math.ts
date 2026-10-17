import type { Vec2 } from './Grid';

export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
