import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = resolve(packageDir, '../..');
const sourceDir = resolve(packageDir, 'pdfium-src');
const projectRoot = resolve(packageDir, '../../../..');
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (cwd) => execFileSync('git', ['-c', `safe.directory=${cwd}`, 'rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

const manifest = {
  embedpdf_parent_sha: git(vendorDir),
  pdfium_src_sha: git(sourceDir),
  native_patch_sha256: hash(resolve(sourceDir, 'fpdfsdk/fpdf_annot.cpp')),
  pdfium_wasm_sha256: hash(resolve(packageDir, 'src/vendor/pdfium.wasm')),
  pdfium_js_sha256: hash(resolve(packageDir, 'src/vendor/pdfium.js')),
  pdfium_cjs_sha256: hash(resolve(packageDir, 'src/vendor/pdfium.cjs')),
  runtime_id: 'yubin-korean-freetext-shared-font-v2',
  canonical_font: 'backend/assets/fonts/NotoSansKR-Regular.ttf',
  canonical_font_sha256: hash(resolve(projectRoot, 'backend/assets/fonts/NotoSansKR-Regular.ttf')),
};

writeFileSync(resolve(packageDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
