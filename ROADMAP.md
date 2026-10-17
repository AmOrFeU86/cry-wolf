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
- [x] Tiempo de subida: 0,6 s (1 s era mortal con un lobo cerca)

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
- [x] Noches con dificultad creciente (`CONFIG.nights`): noche 1 = un lobo y 90 s … noche 5 = la dificultad de antes.
      Se eligen en el menú, al ganar se desbloquea la siguiente (localStorage) y hay récord por noche

**Correcciones**
- [x] Subida a la torre: 0,6 s en vez de 1 s
- [ ] Instrucciones de jev para que use de verdad la torre (probado: ni explicándole que al final gana la partida)

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
- [x] Las noches desbloquean piezas: 1 valla/seto/piña · 2 puerta · 3 muro/torre · 4 puente (las bloqueadas salen con 🔒)
- [ ] Mejoras permanentes: más lana por bocado, construir más rápido, esquive extra
- [ ] Se guarda en el navegador (localStorage)

## 🌙 Fase 7 — Objetivos y modo largo

- [ ] Corderitos perdidos: rescatarlos, te siguen y hay que protegerlos
- [x] Al anochecer (final de cada partida) los lobos ven menos (×0,6) pero huelen mejor (×1,6). Aviso "🌙 Anochece"
- [ ] De noche la oveja también ve menos (solo ojos brillantes)
- [ ] Modo por noches: de día comes y construyes, de noche vienen los lobos;
      la base se mantiene de una noche a otra y cada noche es más difícil
- [ ] Casa (2×2): dentro no te ven ni huelen, recuperas aguante; si te ven entrar, la asedian

---

## 👥 Multijugador

El servidor (`server/index.ts`) ejecuta la simulación de cada sala y manda el estado unas 30 veces por segundo.
Los jugadores solo envían sus órdenes (`PlayerInput`). Mensajes en `src/net/protocol.ts`, fotos del estado en `src/net/snapshot.ts`
y el cliente en `src/net/NetClient.ts`.

- En local: `npm run server` en una terminal y `npm run dev` en otra → menú «👥 Con amigos» (Vite redirige `/ws` al servidor).
  Para jugar desde otro ordenador de casa: `http://<ip-de-tu-pc>:5173`
- En el VPS: `npm install && npm run build && PORT=8080 npm run server` (sirve el juego y el WebSocket en el mismo puerto).
  Con HTTPS, poner delante nginx/Caddy redirigiendo también `/ws` (cabeceras `Upgrade`).
- Comprobación sin navegador: `npx tsx scripts/net-check.ts`

- [x] Varias ovejas en el mismo prado; cada lobo caza a la que ve más cerca
- [x] Si cazan a una, las demás siguen (la cámara pasa a una compañera); se gana si alguna llega al final
- [x] Salas con nombre, anfitrión que elige la noche, se puede entrar a mitad de partida
- [x] Nombres sobre las ovejas, lista del rebaño en el HUD
- [ ] Rescatar a una compañera cazada (p. ej. quedarse a su lado unos segundos)
- [ ] Predicción de movimiento en el cliente si con el VPS se nota retraso al moverse
- [ ] Probar jugando de verdad: ¿demasiado fácil con varias? (más lobos según el número de ovejas)

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

### 2026-10-17 · Noches, oscuridad y roturas (bot programado, 50 partidas por prueba)

- `breakPenalty` 12 → 4: se rompen el doble de piezas (0,9 por partida, antes 0,4) y se sobrevive lo mismo.
  Con 8/6/2 no mejora. Lo que más limita es que el bot pone piezas sueltas en campo abierto.
- Oscuridad (vista ×0,6, olfato ×1,6): casi no cambia los números en la noche 5, porque el bot suele morir antes de que anochezca.
- Torre a 0,6 s: el bot programado no construye torres, así que no se puede medir con él (`check-build` pasa).
- Nuevas opciones del simulador: `--night N` y `--set wolf.breakPenalty=6` (cambiar balance sin tocar config.ts).

| Noche | Lobos (máx · cada) | Tiempo | Victorias | Supervivencia media |
|---|---|---|---|---|
| 1 | 1 | 1:30 | 44/50 | 1:25 |
| 2 | 2 · 40 s | 2:00 | 30/50 | 1:43 |
| 3 | 3 · 45 s | 2:30 | 22/50 | 2:00 |
| 4 | 4 · 50 s | 3:00 | 11/50 | 2:16 |
| 5 | 5 · 35 s | 3:00 | 5/50 | 1:48 |

### 2026-10-17 · Noches con jev (10 partidas por escenario, coste total ≈ $0.96)

| Escenario | Victorias | Supervivencia media | Rotas/partida | Comparación |
|---|---|---|---|---|
| Noche 1, seto | 8/10 | 1:22 de 1:30 | 1.1 | — |
| Noche 2, puerta | 6/10 | 1:40 de 2:00 | 1.3 | — |
| Noche 3, seto + torre/piñas | 3/10 (y 3/10 al repetir) | 1:39 / 1:46 | 0.4 / 1.6 | — |
| Noche 3, muro | 0/10 | 1:19 | 0.1 | come ~75% del tiempo para pagar muros y le cazan comiendo |
| Noche 5, seto + torre/piñas | 1/10 (y 0/10 al repetir) | 1:54 / 1:13 | 0.4 / 0.9 | antes 0/5, 1:47 · ¡primera victoria de jev! |
| Noche 5, valla | 0/10 | 1:22 | 1.1 | antes 0/5, 1:26, 0 rotas |

- La curva de noches funciona igual con jev que con el bot programado: 80% → 60% → 30% → 0-10%.
- Los lobos ya rompen las construcciones de jev (antes 0 en todas las pruebas).
- Con 10 partidas hay mucho ruido: la misma prueba (noche 5 + torre) dio 1:54 y 1:13.
- **jev sigue sin usar la torre** (0 veces en 30 partidas, máx 25% de probabilidad), tampoco con una descripción
  que explica que subir al final gana la partida. La mecánica funciona: un bot obligado a usarla construye, sube
  en 0,6 s y aguanta 20-55 s arriba. Es una limitación de jev, no del juego.
- Las instrucciones de jev ahora incluyen la oscuridad (`night_darkness_percent`) y el tiempo de subida real.
- `sim.ts` da error si se pide una pieza bloqueada en esa noche; las repeticiones se guardan como
  `jev-n3-hedge-extras-mejor`, etc. (sin sufijos con la noche 5 por defecto).

### Pendiente de probar a mano
- [ ] Que la curva de noches se sienta bien jugando (un jugador debería hacerlo mejor que el bot)
- [ ] Que apuntar con la mira se sienta bien (distancia, altura de la mira, mantener click para filas)
