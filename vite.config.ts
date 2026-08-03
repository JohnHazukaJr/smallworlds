import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Locks script execution to the app's own bundle so injected markup can't run code.
// connect-src stays open because users can point the app at any AI endpoint they own
// (including local Ollama over http). Build-only: the dev server needs inline scripts for HMR.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:*",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

function injectCsp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend'
        }]
      };
    }
  };
}

export default defineConfig({
  plugins: [
    injectCsp(),
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
