// Todos los números de balance del juego en un único sitio.
export const CONFIG = {
  mapSize: 64, // celdas por lado (1 celda = 1 unidad)
  prepTime: 40, // segundos tranquilos al empezar para comer y construir
  startWool: 6,

  sheep: {
    radius: 0.42,
    walkSpeed: 5.2,
    sprintSpeed: 8.6,
    accel: 12,
    staminaMax: 100,
    staminaDrain: 22, // por segundo esprintando
    staminaRegen: 20,
    exhaustedUntil: 30, // si llegas a 0, no puedes esprintar hasta recuperar esto
    dashSpeed: 17,
    dashTime: 0.18,
    dashCooldown: 2.5,
    dashStamina: 0, // el esquive solo depende de su recarga
    eatRate: 2, // lana por segundo
    eatRange: 1.4,
    // Ruido que hace la oveja (radio en metros en el que la oyen los lobos)
    walkNoise: 2.5,
    sprintNoise: 16,
    dashNoise: 14,
    buildNoise: 12,
    // Rastro de olor que deja al moverse
    scentInterval: 0.4,
    scentLife: 25,
  },

  wolf: {
    radius: 0.68, // grande: no cabe por huecos de una celda (la oveja sí), ver findWolfPath
    speed: 5.6, // persiguiendo: algo más rápido que la oveja andando
    turnRate: 3.0, // rad/s persiguiendo a la vista (gira peor que la oveja)
    pathTurnRate: 7, // rad/s siguiendo un camino
    catchDistance: 1.2, // distancia entre centros (radios 0.68 + 0.42 = 1.1)
    goalReach: 1.4, // cuando no caza, le basta con acercarse esto al punto al que va
    biteDamage: 30, // daño por segundo a construcciones
    repathInterval: 0.4,
    breakPenalty: 12, // coste extra de romper una construcción (por cada 150 de vida) al buscar camino
    firstWolves: 1, // llegan al acabar la preparación (cuántos más y cada cuánto: ver nights)
    // Salto de ataque: se agacha (aviso), salta en línea recta y queda agotado un momento
    pounceRange: 4.5,
    windupTime: 0.4,
    pounceSpeed: 12,
    pounceTime: 0.4,
    recoverTime: 0.9,
    recoverSpeed: 2.5,
    pounceCooldown: 2.5,
    // Sentidos y comportamiento
    sightRange: 15,
    fov: 1.0, // medio ángulo del cono de visión (rad) → ~115° en total
    closeSense: 2.5, // a esta distancia te nota aunque estés a su espalda
    smellRange: 2.2, // distancia a la que detecta tu rastro
    trackSpeed: 4.4, // siguiendo el rastro (algo más lento que tú andando)
    howlRange: 18, // al verte, avisa a los lobos en este radio
    wanderSpeed: 3,
    searchSpeed: 4.6,
    loseSightTime: 1.2, // te sigue la pista este tiempo tras dejar de verte
    searchTime: 8, // segundos buscando tras perderte de vista
    predict: 1.0, // segundos que extrapola tu movimiento al perderte
    wanderTowardSheep: 0.3, // probabilidad de merodear hacia tu zona (olfato)
  },

  // Piezas construibles (vida = segundos de mordisco × biteDamage). Qué tapa cada una: Grid.blocksSight
  pieces: {
    fence: { name: 'Valla', icon: '🪵', cost: 3, hp: 150 }, // se ve a través
    hedge: { name: 'Seto', icon: '🌿', cost: 4, hp: 90 }, // tapa la vista, pero cae rápido
    wall: { name: 'Muro', icon: '🧱', cost: 8, hp: 450 }, // tapa y aguanta mucho
    gate: { name: 'Puerta', icon: '🚪', cost: 5, hp: 200 }, // tapa; la oveja pasa, los lobos no
    tower: { name: 'Torre', icon: '🗼', cost: 12, hp: 600 }, // se sube: arriba no te atrapan, pero la muerden
  },
  tower: {
    height: 2.2, // altura a la que está la oveja arriba (solo visual)
    climbTime: 1, // segundos quieta a su lado manteniendo E (vulnerable mientras)
    fallStun: 0.6, // si la derriban contigo encima, caes aturdida
    sightBonus: 1.4, // arriba te ven desde más lejos, y ni árboles ni setos te tapan
  },
  bridge: {
    name: 'Puente',
    icon: '🌉',
    cost: 4, // lana
    range: 6, // distancia máxima entre las dos torres
    speed: 3, // al cruzarlo (más despacio que andando)
  },
  pinecone: {
    name: 'Piña',
    icon: '🌰',
    cost: 1, // lana
    cooldown: 2,
    range: 14,
    flightTime: 0.7,
    noise: 14, // al caer hace ruido: los lobos que lo oyen van a mirar
  },
  buildRange: 4, // distancia máxima desde la oveja a la que se puede construir
  dismantleRefund: 0.5, // parte de la lana que recuperas al desmontar (según la vida que le quede)

  grass: { count: 28, amount: 4, regrowTime: 18 },

  // Noches: cada una es una partida y al ganarla se desbloquea la siguiente. La última es la dificultad completa.
  // survivalTime: segundos a sobrevivir una vez llegan los lobos · speedGrowth: velocidad extra del lobo por segundo
  // unlock: lo que se puede construir o lanzar a partir de esa noche
  nights: [
    { survivalTime: 90, maxWolves: 1, spawnInterval: 35, speedGrowth: 0, unlock: ['fence', 'hedge', 'pinecone'] },
    { survivalTime: 120, maxWolves: 2, spawnInterval: 40, speedGrowth: 0.003, unlock: ['gate'] },
    { survivalTime: 150, maxWolves: 3, spawnInterval: 40, speedGrowth: 0.004, unlock: ['wall', 'tower'] },
    { survivalTime: 180, maxWolves: 4, spawnInterval: 38, speedGrowth: 0.005, unlock: ['bridge'] },
    { survivalTime: 180, maxWolves: 5, spawnInterval: 35, speedGrowth: 0.006, unlock: [] },
  ],

  // Al final de cada partida anochece: los lobos ven menos pero huelen mejor
  darkness: {
    sight: 1, // multiplicador del alcance de la vista con noche cerrada
    smell: 1, // multiplicador del olfato con noche cerrada
  },
};
