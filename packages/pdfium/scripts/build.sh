#!/usr/bin/env bash
set -euo pipefail

ROOT=/workspace
SRC="$ROOT/packages/pdfium/pdfium-src"
OUT="$SRC/out/wasm"
PDFIUM="$ROOT/packages/pdfium"
export ROOT SRC OUT PDFIUM
export PATH="$HOME/.cargo/bin:$PATH"

ensure_deps() {
  if [[ -x "$SRC/buildtools/linux64/gn" && -d "$SRC/third_party/llvm-build" ]]; then
    return
  fi

  local gclient_file="$ROOT/.gclient"
  cat > "$gclient_file" <<'EOF'
solutions = [
  { "name": "packages/pdfium/pdfium-src",
    "url": "https://pdfium.googlesource.com/pdfium.git",
    "deps_file": "DEPS",
    "managed": False,
    "custom_deps": {},
  },
]
EOF
  trap 'rm -f "$gclient_file"' RETURN
  (cd "$SRC" && gclient sync --no-history --shallow --nohooks --deps=builder)
}

apply_wasm_patches() {
  cp -f "$PDFIUM/build/patch/build/config/BUILDCONFIG.gn" "$SRC/build/config/BUILDCONFIG.gn"
  cp -f "$PDFIUM/build/patch/build/toolchain/wasm/BUILD.gn" "$SRC/build/toolchain/wasm/BUILD.gn"
}

configure_wasm() {
  mkdir -p "$OUT"
  apply_wasm_patches
  (
    cd "$SRC"
    gn gen out/wasm --args='is_debug=false treat_warnings_as_errors=false pdf_use_skia=false pdf_enable_xfa=false pdf_enable_v8=false is_component_build=false clang_use_chrome_plugins=false pdf_is_standalone=true use_debug_fission=false use_custom_libcxx=false use_sysroot=false pdf_is_complete_lib=true pdf_use_partition_alloc=false is_clang=false symbol_level=0 target_os="wasm" target_cpu="wasm"'
  )
}

gen_exports() {
  local ws="$PDFIUM/build/wasm"
  rm -rf "$ws"
  mkdir -p "$ws"
  (
    cd "$SRC"
    find public -path public/cpp -prune -o -name '*.h' -print | sort | sed 's|^|#include "|;s|$|"|' > "$ws/all.h"
  )
  echo '#include "../build/code/cpp/ext_api.h"' >> "$ws/all.h"
  clang -std=c11 -I"$SRC" -I"$ROOT/build/code/cpp" -fsyntax-only -Xclang -ast-dump=json "$ws/all.h" > "$ws/ast.json"
  node "$PDFIUM/build/generate-functions.mjs" "$ws/ast.json" "$ws"
  node "$PDFIUM/build/generate-runtime-methods.mjs" "$ws"
}

ensure_deps
configure_wasm
ninja -C "$OUT" pdfium -v
gen_exports
(
  cd "$PDFIUM/build"
  bash ./compile.esm.sh
  bash ./compile.sh
)
for file in runtime-methods.ts functions.ts pdfium.wasm pdfium.js pdfium.cjs; do
  cp -f "$PDFIUM/build/wasm/$file" "$PDFIUM/src/vendor/$file"
done
