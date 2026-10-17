# Hoja de ruta — ¡Que viene el lobo!

Ideas para hacer el juego más divertido y a largo plazo. Se marca `[x]` lo terminado.
Cada cambio de balance se prueba con bots: `npm run sim` (programado, gratis) y
`npm run sim -- --brain jev --games 5` (typesafe/jev-1.14, necesita `OPENROUTER_API_KEY`).

---

## ✅ Fase 1 — Construir con el ratón

- [x] Mira en pantalla: se construye donde apunta la cámara, hasta `buildRange` (4 m) de la oveja
- [x] Mantener click para construir en fila
- [x] Click derecho (o X): desmontar, recuperando la mitad de la lana (según la vida que le quede)
- [x] Rueda del ratón / teclas 1-6 para elegir pieza, barra de piezas en el HUD
- [ ] Reparar construcciones dañadas

## ✅ Fase 2 — Piezas que tapan de verdad

| Pieza | Coste | Vida | Bloquea paso | Tapa la vista |
|---|---|---|---|---|
| 🪵 Valla | 3 | 150 | ✅ | ❌ |
| 🌿 Seto | 4 | 90 | ✅ | ✅ (cae rápido) |
| 🧱 Muro | 8 | 450 | ✅ | ✅ |
| 🚪 Puerta | 5 | 200 | solo lobos | ✅ |

- [x] Las piezas nuevas en el mapa, los conos de visión y el pathfinding de los lobos
- [x] Romper cuesta a los lobos según la vida de la pieza (rodean muros, rompen setos)
- [x] Repeticiones guardan el tipo de pieza
- [x] Bots: `--piece fence|hedge|wall|gate` para comparar
- [ ] Revisar resultados de jev y ajustar costes/vida

## 🐺 Fase 2b — Lobos grandes

- [x] El lobo ocupa un hueco de 2×2 celdas (radio 0.68): por pasos de una celda solo cabe la oveja
- [x] Pathfinding del lobo por vértices de la cuadrícula (`findWolfPath`); rompe lo que le tapa el hueco
- [x] El mapa rellena con árboles los rincones donde ningún lobo podría atraparte (sin escondites imposibles)
- [x] `scripts/corral.ts`: oveja encerrada en un corral → el lobo rompe y entra (valla ~12 s, seto ~8 s, muro ~32 s)
- [x] Arreglado: escondida en un recinto cerrado, el lobo que te buscaba o seguía tu rastro no rompía nada
      y se iba (solo rompía si te veía). Ahora rompe cualquier lobo con pista; el que merodea, no.
      `scripts/hide.ts`: recinto cerrado de setos → entra en 8-15 s (antes: nunca)
- [ ] En partidas normales los bots aún casi no provocan roturas: sueltan piezas aisladas en campo abierto
      y el lobo las rodea (es lo correcto). Un jugador que tape pasos entre árboles sí verá romper.

## 🗼 Fase 3 — Torre y lanzar cosas

**Torre** (tecla 5, 12 de lana, 600 de vida ≈ 20 s de mordiscos de un lobo)
- [x] Subir: quieta al lado, mantener E durante 1 s (vulnerable mientras)
- [x] Arriba los lobos no te pueden atrapar: rodean la torre y muerden la base
- [x] Arriba la cámara sube y ves más lejos
- [x] Pero te ven desde 1,4× más lejos y no te tapa nada; y no puedes comer
- [x] Si la rompen caes y quedas aturdida 0,6 s. Se puede saltar antes con el esquive (Espacio)
- [x] Desde arriba se puede construir y lanzar piñas
- [x] Bots: acción `tower` (`npm run sim -- --extras`)
- [ ] Los lobos se marcan aunque estén tras árboles (estando arriba)
- [ ] Ajustar tiempo de subida (1 s es mortal con un lobo cerca: ¿0,6 s?)

**Puente colgante** (tecla 6, 4 de lana) — idea del jugador
- [x] Subida a una torre, apuntar a otra torre a ≤ 6 m → se tiende un puente entre las dos
- [x] Moverse hacia el puente para cruzar; darse la vuelta a mitad para volver
- [x] Cruzando no te alcanzan, pero te ven desde lejos y te siguen por debajo
- [x] Si derriban una de las torres, el puente cae (y tú con él si estás encima)
- [x] Equilibrio: arriba no se come → tarde o temprano hay que bajar

**Lanzar cosas** (con la mira, tecla 7)
- [x] 🌰 Piña: 1 de lana, cada 2 s, hasta 14 m. Al caer hace ruido (radio 14) → los lobos que no te cazan van a mirar
- [x] Bots: acción `distract`
- [ ] 🧶 Bola de lana olorosa: deja un rastro falso que los lobos siguen

## 🔊 Fase 3b — Sensaciones (lo que más diversión da por esfuerzo)

**Sonido** (sintetizado con Web Audio, sin archivos)
- [x] Aullidos (llegada, "¡te he visto!"), con dirección y distancia
- [x] Latido del corazón que se acelera cuando te buscan / te ven
- [x] Pasos de lobo cercanos aunque no lo veas
- [x] Mordiscos, crujidos al romper, golpes al construir, esquive, piña, caída
- [x] Tecla M para silenciar
- [x] Grabaciones reales CC0 de Freesound (las más descargadas/valoradas): aullidos, manada, latido, gruñido
      antes del salto, mordisco, rotura, pasos, esquive, caída, olfateo, crujidos, balido y ambiente de bosque.
      `public/sfx/` + `CREDITS.md`; si falta un archivo se usa el sintetizado
- [ ] Ajustar volúmenes jugando

**Saber de dónde viene el peligro**
- [x] Flechas en el borde de la pantalla: rojas = te ve, amarillas = te busca/huele
- [x] Viñeta roja cuando un lobo está a punto de saltarte

**Resumen al final de la partida**
- [x] Lobos despistados, saltos esquivados, mordiscos que aguantaron tus construcciones, piñas que atrajeron lobos...
- [x] Cada cosa da puntos → base para la experiencia (fase 6). `src/sim/score.ts`; récord de puntos guardado.
      Bot programado: 261 puntos de media (máx 772)

**Momentos épicos**
- [x] Cámara lenta 0,5 s al esquivar un salto por muy poco
- [x] Textos rápidos: "¡Por los pelos!", "¡Despistado!"

**Razones para arriesgarse**
- [ ] 🍀 Trébol dorado: aparece a veces en sitios peligrosos y da mucha lana

**Dificultad**: ahora los bots ganan 0-6% → adelantar las noches de la fase 7
- [ ] Noches con dificultad creciente ("Noche 1: un lobo, 90 s"...) para que ganar la primera sea alcanzable

**Correcciones**
- [ ] Subida a la torre: probar 0,6 s en vez de 1 s
- [ ] Instrucciones de jev para que use de verdad la torre

## 🌳 Fase 4 — Esconderse y trampas

- [ ] Arbustos en el mapa: dentro no te ven si no haces ruido (pero te huelen de cerca)
- [ ] Barro / charcos: al cruzarlos se borra tu rastro de olor
- [ ] Hoyo con ramas: el lobo cae y queda atrapado unos segundos
- [ ] Espinos: frenan a los lobos que pasan
- [ ] Espantapájaros: los lobos lo atacan creyendo que es una oveja

## 🐺 Fase 5 — Tipos de lobo

Cada uno contrarresta una estrategia distinta:
- [ ] Rastreador: huele mucho mejor y sigue el rastro más rápido (contra esconderse)
- [ ] Destructor: grande y lento, rompe construcciones ×3 (contra fortalezas)
- [ ] Saltador: salto mucho más largo (contra huir en campo abierto)
- [ ] Jefe de la manada en las últimas noches: aúlla y llama a todos

## ⭐ Fase 6 — Progresión a largo plazo

- [ ] Experiencia por partida: sobrevivir, despistar lobos, mordiscos aguantados, corderos rescatados
- [ ] Niveles que desbloquean piezas (seto, puerta, torre, trampas…)
- [ ] Mejoras permanentes: más lana por bocado, construir más rápido, esquive extra
- [ ] Se guarda en el navegador (localStorage)

## 🌙 Fase 7 — Objetivos y modo largo

- [ ] Corderitos perdidos: rescatarlos, te siguen y hay que protegerlos
- [ ] Día y noche: de noche ves menos (solo ojos brillantes), los lobos también
- [ ] Modo por noches: de día comes y construyes, de noche vienen los lobos;
      la base se mantiene de una noche a otra y cada noche es más difícil
- [ ] Casa (2×2): dentro no te ven ni huelen, recuperas aguante; si te ven entrar, la asedian

---

## Resultados de pruebas

### 2026-10-17 · Fases 1-2 (bot programado, 50 partidas)

| Pieza del bot | Victorias | Supervivencia media | Construye | Te ven / escapas |
|---|---|---|---|---|
| Antes (valla) | 2/50 | 1:39 | 21.5 | 9.3 / 6.7 |
| Valla | 2/50 | 1:39 | 21.5 | 9.3 / 6.7 |
| Seto | 1/50 | 1:43 | 17.5 | 11.9 / 9.3 |
| Muro | 1/50 | 1:33 | 8.8 | 9.3 / 6.9 |
| Puerta | 2/50 | 1:41 | 14.4 | 12.9 / 10.2 |

- La valla da exactamente lo mismo que antes: sin regresiones.
- Setos y puertas: el bot escapa bastante más (tapar la vista funciona).
- Los lobos no rompen ninguna construcción del bot (0 rotas en todas). Ya pasaba antes de estos cambios.

### 2026-10-17 · Fases 1-2 (jev, 5 partidas por pieza, coste total $0.17)

| Pieza del bot | Victorias | Supervivencia media | Construye | Te ven / escapas | Comer |
|---|---|---|---|---|---|
| Valla | 0/5 | 1:23 | 27.4 | 5.6 / 3.6 | ~59% |
| Seto | 0/5 | 1:28 (máx 2:42) | 20.4 | 6.6 / 4.2 | ~59% |
| Muro | 0/5 | 0:58 | 9.0 | 4.2 / 2.6 | ~69% |
| Puerta | 0/5 | 1:02 | 15.6 | 6.2 / 4.2 | ~71% |

- Con 5 partidas hay mucho ruido: sirve como orientación, no como prueba.
- El seto es la mejor pieza para jev (y su mejor partida de todas: 2:42).
- Muro y puerta le van peor: jev se pasa ~70% del tiempo comiendo para reunir 5-8 de lana
  y le cazan comiendo. Para un jugador son piezas de preparación (fase tranquila), no de huida.
- Otra vez 0 construcciones rotas: los lobos siempre rodean. → Investigar (¿breakPenalty demasiado alto?
  ¿el bot construye donde no estorba?). Si nunca las rompen, la "vida" de cada pieza no importa.
- Repeticiones: `/?replay=jev-hedge-mejor`, `jev-wall-peor`, etc. (`public/replays/jev-<pieza>-mejor|peor.json`)

### 2026-10-17 · Lobos grandes (fase 2b)

| Prueba | Victorias | Supervivencia media | Te ven / escapas | Rotas/partida |
|---|---|---|---|---|
| Programado, valla (50) | 3/50 (antes 2) | 1:46 (antes 1:39) | 10.6 / 8.2 (antes 9.3 / 6.7) | 0.3 (antes 0) |
| jev, valla (5) | 0/5 | 1:26 (antes 1:23) | 9.2 / 7.0 (antes 5.6 / 3.6) | 0 |
| jev, seto (5) | 0/5 | 1:34 (antes 1:28) | 8.8 / 6.8 (antes 6.6 / 4.2) | 0 |

- La oveja escapa casi el doble: se cuela por huecos donde el lobo no cabe.
- Corral (`scripts/corral.ts`): encerrada, el lobo rompe dos piezas y entra.

### 2026-10-17 · Torre y piñas (fase 3)

- `scripts/check-build.ts`: subir 1 s, a salvo arriba, un lobo la derriba en ~21 s, al caer te atrapa,
  saltar con el esquive funciona, la piña atrae al lobo. Todo ✔.
- Programado `--extras` (50): con reglas ingenuas subía con el lobo encima y moría (0:39); con reglas
  prudentes casi nunca sube y lanza ~17 piñas → 1:41 (igual que sin extras). Las piñas no le ayudan.
- jev `--extras --piece hedge` (5): **nunca eligió la torre** y casi no lanzó piñas (1.2/partida).
  Sobrevivió 1:47, pero no gracias a la torre. → jev todavía no ha probado la torre de verdad.

### Pendiente de probar a mano
- [ ] Que apuntar con la mira se sienta bien (distancia, altura de la mira, mantener click para filas)
