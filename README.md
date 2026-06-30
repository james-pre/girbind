# girbind

Convert GObject Introspection (GIR) files into Node.js addons.

girbind reads a `.gir` file and emits a statically-typed Node.js binding: a C++
N-API addon, TypeScript declarations (`.d.ts`), and an ESM entry point that loads
the compiled addon. GObject classes become real JS classes (with inheritance and
`instanceof`), methods and properties are exposed, and `GError`s are thrown.

## Installation

```sh
npm install girbind
```

Building an addon also needs a C++ toolchain (CMake + a C++23 compiler), the
target library's development files (its `pkg-config` module and headers), and
the GIR file (usually shipped by the library's `-devel`/`-dev` package under
`/usr/share/gir-1.0/`). `cmake-js` and `node-addon-api` are pulled in as needed.

## Usage

girbind supports two workflows.

### 1. Consumer: generate bindings in your own project

Use this when you just want to call a library from your app. girbind tracks the
libraries you add in a `girbindDependencies` field in your `package.json`, and
`build` compiles them all into `native/`.

```sh
npx girbind add flatpak        # generate sources into girbind/flatpak/ and record the dep
npx girbind build              # compile every dependency into native/
npx girbind remove flatpak     # (or `rm`) delete sources and drop the dep
```

Then import the built binding:

```ts
import flatpak from './native/flatpak.js';

const [installation] = flatpak.getSystemInstallations(null);
for (const remote of installation.listRemotes(null)) {
	console.log(remote.getName(), remote.getUrl()); // remote instanceof flatpak.Remote
}
```

`girbind add` accepts any built-in package (run `npx girbind add --help` to list
them). For a library girbind doesn't ship a config for, add an entry to
`girbindDependencies` by hand — either a built-in name or an inline config:

```jsonc
{
	"girbindDependencies": [
		"flatpak",
		{
			"name": "gtk",
			"gir": "/usr/share/gir-1.0/Gtk-4.0.gir",
			"include": ["gtk/gtk.h"],
			"pkgConfig": ["gtk4"],
		},
	],
}
```

`npx girbind build` then generates any missing sources and builds everything.

### 2. Author: publish a bindings package

Use this when you maintain a standalone bindings package to publish to npm.
`generate` writes the sources plus a per-directory `CMakeLists.txt`, and
`compile` builds the addon.

```sh
npx girbind generate /usr/share/gir-1.0/Flatpak-1.0.gir \
	-o src -i flatpak/flatpak.h -p flatpak
npx girbind compile -o src --build-dir build
```

| Option                       | Meaning                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `-o, --outdir <dir>`         | where to write the generated `.cc`/`.js`/`.d.ts`/`CMakeLists.txt` |
| `-m, --module-name <name>`   | addon name (defaults to the GIR namespace, lowercased)            |
| `-i, --include <header…>`    | extra C++ `#include`s for the target library                      |
| `-p, --pkg-config <module…>` | `pkg-config` modules to link                                      |
| `--build-dir <dir>`          | where `compile` places the built `.node`                          |

Run `npx girbind --help` (or `<command> --help`) for the full set of options.

### Programmatic API

The GIR parser and generators are also exposed as a library:

```ts
import { parseGirFile, cxx, ts, js } from 'girbind';

const ns = parseGirFile('/usr/share/gir-1.0/Flatpak-1.0.gir');
const source = cxx.generate(ns, { moduleName: 'flatpak', includes: ['flatpak/flatpak.h'] });
const types = ts.generate(ns);
const entry = js.generate(ns, './flatpak.node');
```

Or generate all three files for a resolved dependency in one call with
`generatePackage(dep, dir)`.
