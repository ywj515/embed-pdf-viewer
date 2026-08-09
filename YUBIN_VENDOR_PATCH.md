# Yubin EmbedPDF vendor patch

This checkout is pinned to EmbedPDF `v2.14.4` (`07ed5fe`) and contains the
Yubin Korean FreeText writer investigation.

## Dependency installation record

The initial, credential-free installation used a temporary project `.npmrc`
containing only:

```ini
registry=https://registry.npmjs.org/
@embedpdf:registry=https://registry.npmjs.org/
```

It was then run only from this checkout:

```powershell
corepack pnpm@10.4.0 install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org/ --store-dir .pnpm-store
```

The normal upstream `.npmrc` was restored byte-for-byte afterwards. No token
was supplied to the command. The offline reconstruction command was:

```powershell
corepack pnpm@10.4.0 install --frozen-lockfile --ignore-scripts --offline --registry=https://registry.npmjs.org/ --store-dir .pnpm-store
```

## Patch scope

`packages/engines/src/lib/pdfium/font-fallback.ts` now exposes the configured
self-hosted charset font bytes to the writer. `engine.ts` uses those bytes only
for Hangul-containing FreeText to create a PDFium `FPDFText_LoadFont` TrueType
CID text object and append it to the annotation appearance. English-only
FreeText continues to use the upstream standard-font appearance path.

The patched `@embedpdf/engines` package compiled successfully with:

```powershell
corepack pnpm@10.4.0 --filter @embedpdf/engines run build
```

## Current release blocker

The upstream `build:snippet` script builds all packages, not just its runtime
dependencies. At this pinned source revision it fails in unrelated framework
package variants (for example `plugin-viewport` and `plugin-attachment`) and
leaves required snippet dependencies such as `plugin-capture/dist/preact` absent.
Therefore no generated browser asset was copied into Yubin, and no claim is
made that this source patch is integrated or that Korean export works.
