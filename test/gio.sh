#!/usr/bin/env bash
#
# End-to-end test: build Gio bindings with `girbind build` in a scratch project,
# then exercise interfaces and out parameters (test/gio.js). Requires gio-2.0
# development files and its GIR; skips cleanly when they are absent.

set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)
cd "$project_dir"

out=tmp/gio

if ! pkg-config --exists gio-2.0; then
	echo "SKIP: gio-2.0 pkg-config not found (install GLib development files)"
	exit 0
fi
if [ ! -f /usr/share/gir-1.0/Gio-2.0.gir ]; then
	echo "SKIP: Gio-2.0.gir not found"
	exit 0
fi

echo "==> Building girbind"
npm run build

echo "==> Building Gio bindings in $out"
mkdir -p "$out"
echo '{ "name": "gio-test", "private": true, "type": "module", "girbindDependencies": ["gio"] }' >"$out/package.json"
(cd "$out" && node "$project_dir/dist/main.js" build)

echo "==> Type-checking the declarations"
node test/assignability.js "$out/native" "$out/native/assignability.ts"
cat >"$out/tsconfig.json" <<'EOF'
{
	"compilerOptions": {
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"target": "ESNext",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": false,
		"types": ["node"]
	},
	"files": ["native/assignability.ts"]
}
EOF
npx tsc -p "$out/tsconfig.json"

echo "==> Running usage test"
node test/gio.js "$out/native/gio.js"

echo "PASS"
