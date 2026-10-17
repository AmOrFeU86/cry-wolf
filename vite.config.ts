import { defineConfig } from 'vite';

// base relativa para poder subir el build a itch.io / GitHub Pages sin tocar rutas
export default defineConfig({
  base: './',
  server: {
    host: true, // accesible desde otros ordenadores de la red local (para jugar juntos en casa)
    // multijugador: el WebSocket va al servidor (npm run server)
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
