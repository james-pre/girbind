# girbind

Convert GObject Introspection (GIR) files into Node.js addons.

girbind reads a `.gir` file and emits a statically-typed Node.js binding: a C++
N-API addon, TypeScript declarations (`.d.ts`), and an ESM entry point that loads
the compiled addon. GObject classes become real JS classes with a normal
prototype chain, including across namespaces (`Adw.ApplicationWindow` extends
`Gtk.ApplicationWindow`, which extends `Gtk.Window`), methods and properties are
exposed, and `GError`s are thrown.

## Installation

girbind is two packages:

- `girbind` is the runtime that every generated binding loads. It ships a
  prebuilt native addon and the C++ header generated addons compile against.
- `girbind-devel` is the code generator and the `girbind` CLI.

```sh
npm install girbind
npm install --save-dev girbind-devel
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

`npx girbind build` then regenerates the sources and builds everything. Bindings
that depend on each other (for example `gtk` on `gdk` and `gio`) import each
other, so objects pass between them.

### Building for Windows

`build --target win32-x64` builds `<name>.win32-x64.node` files next to the
others in `native/`, and the generated entry points load them on Windows. It
works on Linux, cross-compiling, and on Windows from an MSYS2 UCRT64 shell. It
needs CMake, `pkg-config` and MinGW-w64 targeting UCRT (on Fedora,
`ucrt64-gcc-c++`).

```sh
npx girbind build                       # entry points and the .node files for this platform
npx girbind build --target win32-x64    # also native/<name>.win32-x64.node
npx girbind dlls --target win32-x64 dll # the DLLs those need, into dll/
```

The libraries, headers and GIR files come from [MSYS2](https://www.msys2.org/)'s
UCRT64 packages, which girbind downloads into
`node_modules/.cache/girbind/win32-x64` (or `--sysroot <dir>`). The sources for
Windows are generated from MSYS2's GIR files, leaving out headers and
`pkg-config` modules Windows doesn't have, such as `gtk4-unix-print`. Inline
configs name their MSYS2 packages with an `msys2` field, e.g. `["gtk4"]`. Set
`GIRBIND_MINGW` to the MinGW tools' prefix if it isn't
`x86_64-w64-mingw32ucrt-`.

Windows only finds DLLs on `PATH` or next to the program, so add the directory
`dlls` copied them into to `PATH` before importing any bindings. Addons load
Node-API from whichever program runs them, so they also work in single
executable applications. The `girbind` package comes with its runtime built for
Windows; `npx girbind runtime --target win32-x64` builds it for a version that
doesn't.

### 2. Author: publish a bindings package

Use this when you maintain a standalone bindings package to publish to npm.
`generate` writes the sources plus a per-directory `CMakeLists.txt`, and
`compile` builds the addon.

```sh
npx girbind generate /usr/share/gir-1.0/Flatpak-1.0.gir \
	-o src -i flatpak/flatpak.h -p flatpak
npx girbind compile -o src --build-dir build
```

| Option                       | Meaning                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `-o, --outdir <dir>`         | where to write the generated `.cxx`/`.js`/`.d.ts`/`CMakeLists.txt` |
| `-m, --module-name <name>`   | addon name (defaults to the GIR namespace, lowercased)             |
| `-i, --include <header…>`    | extra C++ `#include`s for the target library                       |
| `-p, --pkg-config <module…>` | `pkg-config` modules to link                                       |
| `--build-dir <dir>`          | where `compile` places the built `.node`                           |

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
