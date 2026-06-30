#!/usr/bin/env bash
#
# End-to-end test: generate Flatpak bindings from the system GIR, compile the
# addon, then exercise it (test/flatpak.js). Requires flatpak development files
# (flatpak pkg-config) and a C++ toolchain; skips cleanly when flatpak is absent.

set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)
cd "$project_dir"

gir=/usr/share/gir-1.0/Flatpak-1.0.gir
out=tmp/flatpak
build=build/flatpak

if ! pkg-config --exists flatpak; then
	echo "SKIP: flatpak pkg-config not found (install flatpak development files)"
	exit 0
fi
if [ ! -f "$gir" ]; then
	echo "SKIP: $gir not found"
	exit 0
fi

echo "==> Building girbind"
npm run build

echo "==> Generating bindings -> $out"
node dist/main.js generate "$gir" -o "$out" -i flatpak/flatpak.h -p flatpak

echo "==> Compiling addon -> $build"
node dist/main.js build -o "$out" --build-dir "$build"

echo "==> Running usage test"
node test/flatpak.js "$build/flatpak.js"

echo "PASS"
