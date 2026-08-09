import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// This is deliberately not the EmbedPDF viewer/snippet build.  It serves one
// page that imports the already-built @embedpdf/engines direct bundle.
export default defineConfig({
  root: __dirname,
  server: {
    host: '127.0.0.1',
    fs: { allow: [resolve(__dirname, '../../../..')] },
  },
});
