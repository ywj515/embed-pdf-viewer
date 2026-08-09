import { execFileSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['pdfium.cjs', 'pdfium.js', 'pdfium.wasm', 'functions.ts', 'runtime-methods.ts'];
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

run('docker', ['compose', 'run', '--rm', 'pdfium-build'], packageDir);
for (const file of files) {
  cpSync(resolve(packageDir, 'build/wasm', file), resolve(packageDir, 'src/vendor', file));
}
run(process.execPath, [resolve(packageDir, 'node_modules/rollup/dist/bin/rollup'), '-c'], packageDir);
run(process.execPath, [resolve(packageDir, 'scripts/write-runtime-manifest.mjs')], packageDir);
