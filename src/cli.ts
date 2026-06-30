import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import $pkg from '../package.json' with { type: 'json' };
import { generateCxx } from './codegen/cxx.js';
import { generateJs } from './codegen/js.js';
import { generateTs } from './codegen/ts.js';
import { parseGirFile } from './parse.js';
import { renderCMakeLists } from './scaffold.js';

const cli = new Command('girbind').version($pkg.version).description($pkg.description);

/** glib is always linked (we include <glib-object.h>); extra modules add the target library. */
const BASE_PKGCONFIG = ['glib-2.0', 'gobject-2.0'];

cli.command('generate')
	.description('Generate a C++ N-API addon, TypeScript types, JS entry point and CMakeLists from a GIR file')
	.argument('<gir>', 'path to the .gir file (e.g. /usr/share/gir-1.0/Flatpak-1.0.gir)')
	.requiredOption('-o, --outdir <dir>', 'directory to write the generated files to')
	.option('-m, --module-name <name>', 'addon module name (defaults to the namespace name, lowercased)')
	.option(
		'-i, --include <header...>',
		"additional C++ #include(s) for the target library, e.g. 'flatpak/flatpak.h'",
		[]
	)
	.option('-p, --pkg-config <module...>', "pkg-config module(s) to link, e.g. 'flatpak'", [])
	.option('--build-dir <dir>', 'directory the built .node will be placed in by `build`', 'build')
	.action(
		(
			gir: string,
			opts: { outdir: string; moduleName?: string; include: string[]; pkgConfig: string[]; buildDir: string }
		) => {
			const ns = parseGirFile(gir);
			const moduleName = opts.moduleName ?? ns.name.toLowerCase();

			mkdirSync(opts.outdir, { recursive: true });

			const cc = join(opts.outdir, `${moduleName}.cc`);
			const dts = join(opts.outdir, `${moduleName}.d.ts`);
			const js = join(opts.outdir, `${moduleName}.js`);
			const cmake = join(opts.outdir, 'CMakeLists.txt');

			// The addon is colocated with the JS entry point by `build`, so the
			// entry point requires its sibling `./<addon>.node`.
			writeFileSync(cc, generateCxx(ns, { moduleName, includes: opts.include }));
			writeFileSync(dts, generateTs(ns));
			writeFileSync(js, generateJs(ns, `./${moduleName}.node`));

			// CMake runs with `outdir` as its source root; the .cc sits there and the
			// .node is emitted into the build dir (relative to that root).
			writeFileSync(
				cmake,
				renderCMakeLists({
					projectName: moduleName,
					srcDir: '.',
					// Absolute so it is unaffected by where cmake-js places its binary dir.
					outputDir: resolve(opts.buildDir),
					pkgConfigModules: [...BASE_PKGCONFIG, ...opts.pkgConfig],
				})
			);

			console.error(`Generated bindings for ${ns.name}-${ns.version} into ${opts.outdir}/`);
			for (const f of [cc, dts, js, cmake]) console.error(`  ${basename(f)}`);
		}
	);

cli.command('build')
	.description('Compile the generated addon with cmake-js and colocate the JS + types with it')
	.requiredOption('-o, --outdir <dir>', 'directory containing the generated sources (from `generate`)')
	.option('-m, --module-name <name>', 'addon module name; defaults to the single .cc found in outdir')
	.option('--build-dir <dir>', 'directory the built .node (and copied js/d.ts) go in', 'build')
	.action((opts: { outdir: string; moduleName?: string; buildDir: string }) => {
		const moduleName = opts.moduleName ?? inferModuleName(opts.outdir);

		mkdirSync(opts.buildDir, { recursive: true });

		// cmake-js compiles using outdir's CMakeLists. We pass the output dir as a
		// CMake define (overriding the generate-time default) so `build` controls
		// where the .node lands regardless of what `generate` baked in.
		const result = spawnSync(
			'npx',
			[
				'cmake-js',
				'compile',
				'--directory',
				resolve(opts.outdir),
				'--out',
				resolve(opts.buildDir, '.cmake-build'),
				`--CDGIRBIND_OUTPUT_DIR=${resolve(opts.buildDir)}`,
			],
			{ stdio: 'inherit' }
		);
		if (result.status !== 0) {
			// main.ts treats a thrown number as an exit code.
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw typeof result.status === 'number' ? result.status : 1;
		}

		// Colocate the entry point and types next to the compiled addon.
		for (const ext of ['js', 'd.ts']) {
			copyFileSync(join(opts.outdir, `${moduleName}.${ext}`), join(opts.buildDir, `${moduleName}.${ext}`));
		}

		console.error(`Built ${moduleName}.node into ${opts.buildDir}/`);
		for (const f of [`${moduleName}.node`, `${moduleName}.js`, `${moduleName}.d.ts`]) console.error(`  ${f}`);
	});

/** Infer the addon name from the single `<name>.cc` in a directory. */
function inferModuleName(outdir: string): string {
	const sources = readdirSync(outdir).filter(f => f.endsWith('.cc'));
	if (sources.length !== 1) {
		throw new Error(
			`Expected exactly one .cc in ${outdir} to infer the module name (found ${sources.length}); pass --module-name`
		);
	}
	return sources[0].replace(/\.cc$/, '');
}

export default cli;
