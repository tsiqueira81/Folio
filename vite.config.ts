import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';
import {csp} from './electron/csp.cjs';

const CSP = csp({connect: "'self' https: http: data: blob:"});

const cspMeta: Plugin = {
  name: 'folio-csp-meta',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<title>', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <title>`),
};

export default defineConfig(() => {
  return {
    plugins: [react(), cspMeta],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      target: 'es2022',
      license: true,
      chunkSizeWarningLimit: 1200,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
