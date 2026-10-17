import type { World } from './World';

export interface ScoreLine {
  label: string;
  count: number;
  points: number;
}

/** Puntos de la partida: tiempo sobrevivido y hazañas. Base para la experiencia entre partidas. */
export function scoreOf(world: World): { lines: ScoreLine[]; total: number } {
  const st = world.stats;
  const survived = Math.floor(world.survived);
  const lines: ScoreLine[] = [
    { label: '⏱ Segundos sobrevividos', count: survived, points: survived },
    { label: '💨 Lobos despistados', count: st.escapes, points: st.escapes * 15 },
    { label: '😱 Saltos esquivados por los pelos', count: st.closeCalls, points: st.closeCalls * 20 },
    { label: '🛡 Mordiscos que aguantaron tus construcciones', count: st.bitesAbsorbed, points: st.bitesAbsorbed * 2 },
    { label: '🌰 Lobos atraídos con piñas', count: st.lured, points: st.lured * 10 },
    { label: '🗼 Segundos en la torre', count: Math.floor(st.towerTime), points: Math.floor(st.towerTime / 2) },
  ];
  if (world.state === 'won') lines.push({ label: '🏆 ¡Sobrevivir!', count: 1, points: 150 });
  const shown = lines.filter((l) => l.count > 0);
  return { lines: shown, total: shown.reduce((a, l) => a + l.points, 0) };
}
