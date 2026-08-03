import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Small Worlds AI',
        short_name: 'Small Worlds',
        description: 'Longform AI roleplay: worlds, cast that holds a line, and seasons that remember.',
        theme_color: '#08090c',
        background_color: '#08090c',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // API calls must never be cached; only same-origin app shell is.
        navigateFallbackDenylist: [/^\/api/]
      }
    })
  ]
});
