import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import $pkg from '../package.json' with { type: 'json' };
import { generatePackage } from './codegen/index.js';
import { builtinNames, depName, readPackageJson, resolveDep, writePackageJson } from './deps.js';
import { parseGirFile } from './parse.js';
import { GIRBIND_DIR, writeAggregateCMake, writeCMakeLists } from './scaffold.js';

const cli = new Command('girbind').version($pkg.version).description($pkg.description);

cli.command('generate')
	.description('Generate a C++ N-API addon, TypeScript types, JS entry point and CMakeLists from a GIR file')
	.argument('<gir>', 'path to the .gir file (e.g. /usr/share/gir-1.0/Flatpak-1.0.gir)')
	.requiredOption('-o, --outdir <dir>', 'directory to write the generated files to')
	.option('-m, --name <name>', 'addon module name (defaults to the namespace name, lowercased)')
	.option('-i, --include <header...>', "additional C++ #include(s), e.g. 'flatpak/flatpak.h'", [])
	.option('-p, --pkg-config <module...>', "pkg-config module(s) to link, e.g. 'flatpak'", [])
	.option('--build-dir <dir>', 'directory the built .node will be placed in by `build`', 'build')
	.action((gir: string, opts) => {
		const parsed = parseGirFile(gir);
		const dep = { name: parsed.name.toLowerCase(), ...opts, gir };

		generatePackage(dep, opts.outdir, parsed);
		writeCMakeLists(dep);

		console.error(`Generated bindings for ${parsed.name}-${parsed.version} into ${opts.outdir}/`);
	});

cli.command('add')
	.description('Add girbind packages: generate their sources and record them in girbindDependencies')
	.argument('<packages...>', `built-in package name(s); known: ${builtinNames().join(', ') || '(none)'}`)
	.option('--root <dir>', 'project root (where package.json lives)', '.')
	.action((packages: string[], opts: { root: string }) => {
		const pkgPath = join(opts.root, 'package.json');
		const pkg = readPackageJson(pkgPath);
		const deps = pkg.girbindDependencies ?? [];
		const have = new Set(deps.map(depName));

		for (const name of packages) {
			const dep = resolveDep(name); // validates against built-in configs
			generatePackage(dep, join(opts.root, GIRBIND_DIR, dep.name));
			if (!have.has(dep.name)) {
				deps.push(name);
				have.add(dep.name);
			}
			console.error(`Added ${dep.name}`);
		}

		pkg.girbindDependencies = deps;
		writePackageJson(pkgPath, pkg);
		writeAggregateCMake(opts.root, deps);
	});

cli.command('remove')
	.alias('rm')
	.description('Remove girbind packages: delete their sources and drop them from girbindDependencies')
	.argument('<packages...>', 'package name(s) to remove')
	.option('--root <dir>', 'project root (where package.json lives)', '.')
	.action((packages: string[], opts: { root: string }) => {
		const pkgPath = join(opts.root, 'package.json');
		const pkg = readPackageJson(pkgPath);
		const drop = new Set(packages);

		const remaining = pkg.girbindDependencies?.filter(entry => !drop.has(depName(entry))) ?? [];
		for (const name of packages) {
			rmSync(join(opts.root, GIRBIND_DIR, name), { recursive: true, force: true });
			console.error(`Removed ${name}`);
		}

		pkg.girbindDependencies = remaining;
		writePackageJson(pkgPath, pkg);
		writeAggregateCMake(opts.root, remaining);
	});

cli.command('build')
	.description('Build all girbindDependencies and colocate the JS + types with each .node')
	.option('--root <dir>', 'project root (where package.json lives)', '.')
	.option('--build-dir <dir>', 'directory the built .node files (and copied js/d.ts) go in', 'native')
	.action((opts: { root: string; buildDir: string }) => {
		const pkg = readPackageJson(join(opts.root, 'package.json'));
		const deps = pkg.girbindDependencies ?? [];
		if (!deps.length) {
			console.error('No girbindDependencies to build. Use `girbind add <package>` first.');
			return;
		}

		const girbindRoot = join(opts.root, GIRBIND_DIR);
		// Ensure sources and the aggregate CMakeLists exist (regenerate if missing).
		for (const entry of deps) {
			const dep = resolveDep(entry);
			if (!existsSync(join(girbindRoot, dep.name, `${dep.name}.cc`))) {
				generatePackage(dep, join(girbindRoot, dep.name));
			}
		}
		writeAggregateCMake(opts.root, deps);

		const buildDir = join(opts.root, opts.buildDir);
		mkdirSync(buildDir, { recursive: true });
		cmakeCompile(girbindRoot, buildDir);

		// Colocate each addon's entry point + types with the compiled .node.
		for (const entry of deps) {
			const name = depName(entry);
			for (const ext of ['js', 'd.ts']) {
				copyFileSync(join(girbindRoot, name, `${name}.${ext}`), join(buildDir, `${name}.${ext}`));
			}
		}

		console.error(`Built ${deps.length} package(s) into ${opts.buildDir}/`);
		for (const entry of deps) console.error(`  ${depName(entry)}.node`);
	});

cli.command('compile')
	.description('Compile a single generated directory (from `generate`) and colocate the JS + types')
	.requiredOption('-o, --outdir <dir>', 'directory containing the generated sources (from `generate`)')
	.option('-m, --module-name <name>', 'addon name (defaults to the single .cc found in outdir)')
	.option('--build-dir <dir>', 'directory the built .node (and copied js/d.ts) go in', 'build')
	.action((opts: { outdir: string; moduleName?: string; buildDir: string }) => {
		const name = opts.moduleName ?? inferModuleName(opts.outdir);
		mkdirSync(opts.buildDir, { recursive: true });
		cmakeCompile(opts.outdir, opts.buildDir);
		for (const ext of ['js', 'd.ts']) {
			copyFileSync(join(opts.outdir, `${name}.${ext}`), join(opts.buildDir, `${name}.${ext}`));
		}
		console.error(`Built ${name}.node into ${opts.buildDir}/`);
	});

/** Run `cmake-js compile` against `directory`, emitting .node files into `outputDir`. */
function cmakeCompile(directory: string, outputDir: string): void {
	const result = spawnSync(
		'npx',
		[
			'cmake-js',
			'compile',
			'--directory',
			resolve(directory),
			'--out',
			resolve(outputDir, '.cmake-build'),
			`--CDGIRBIND_OUTPUT_DIR=${resolve(outputDir)}`,
		],
		{ stdio: 'inherit' }
	);
	if (result.status !== 0) {
		// main.ts treats a thrown number as an exit code.
		// eslint-disable-next-line @typescript-eslint/only-throw-error
		throw typeof result.status === 'number' ? result.status : 1;
	}
}

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
