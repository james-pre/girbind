/**
 * Building addons for Windows with MinGW, against GObject libraries from MSYS2.
 * This works on Linux, cross-compiling, and on Windows with MSYS2's UCRT64 toolchain.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import type { ResolvedDep } from '../deps.js';
import { install } from './msys2.js';

export * as msys2 from './msys2.js';
export * as pe from './pe.js';

const require = createRequire(import.meta.url);

const templates = join(import.meta.dirname, '../../templates/windows');

/** Targets girbind can build addons for besides the current platform */
export const targets = ['win32-x64'];

export function checkTarget(target: string): void {
	if (!targets.includes(target)) throw new Error(`Unsupported target ${target}; supported: ${targets.join(', ')}`);
}

/** The prefix of the MinGW tools' names, from `GIRBIND_MINGW` or the usual name for the platform */
export function toolPrefix(): string {
	return process.env.GIRBIND_MINGW ?? (process.platform == 'win32' ? '' : 'x86_64-w64-mingw32ucrt-');
}

/** The MSYS2 prefix within a sysroot, where libraries, headers and GIR files are */
export function prefix(sysroot: string): string {
	return join(sysroot, 'ucrt64');
}

/** Downloads the MSYS2 packages the dependencies need into the sysroot */
export async function prepareSysroot(dependencies: ResolvedDep[], sysroot: string): Promise<void> {
	const packages = new Set(['glib2', ...dependencies.flatMap(dependency => dependency.msys2 ?? [])]);
	await install([...packages], sysroot, { exclude: ['python', 'python-packaging'] });
}

/**
 * Adapts dependencies to the sysroot: GIR files come from the sysroot,
 * and headers and pkg-config modules the sysroot doesn't have, like Unix-only ones, are left out.
 */
export function forSysroot(dependencies: ResolvedDep[], sysroot: string): ResolvedDep[] {
	const root = prefix(sysroot);
	const headers = globSync('**/*.h', { cwd: join(root, 'include') }).map(path => path.replaceAll('\\', '/'));
	return dependencies.map(dependency => {
		const gir = join(root, 'share/gir-1.0', basename(dependency.gir));
		if (!existsSync(gir)) {
			throw new Error(
				`${dependency.name} isn't available for Windows: no MSYS2 package installed ${basename(dependency.gir)}. `
					+ 'Name the packages with it in an `msys2` field.'
			);
		}
		return {
			...dependency,
			gir,
			include: dependency.include.filter(header =>
				headers.some(path => path == header || path.endsWith('/' + header))
			),
			pkgConfig: dependency.pkgConfig.filter(name => existsSync(join(root, 'lib/pkgconfig', name + '.pc'))),
		};
	});
}

/**
 * Writes an import library for the Node-API and libuv functions node.exe exports.
 * It is loaded when first used, so the delay-load hook can load it from the running executable.
 */
function nodeLibrary(directory: string): string {
	mkdirSync(directory, { recursive: true });
	const definitions = join(directory, 'node.def');
	const nodeApi = readFileSync(
		join(dirname(require.resolve('node-api-headers/package.json')), 'def/node_api.def'),
		'utf8'
	);
	writeFileSync(definitions, nodeApi.trimEnd() + '\n' + readFileSync(join(templates, 'uv.def'), 'utf8'));
	const library = join(directory, 'libnode.a');
	execFileSync(
		toolPrefix() + 'dlltool',
		['--input-def', definitions, '--dllname', 'node.exe', '--output-delaylib', library],
		{ stdio: 'inherit' }
	);
	return library;
}

/**
 * Configures and builds a CMake project of addons for Windows.
 * @param definitions Extra CMake cache entries, e.g. `GIRBIND_OUTPUT_DIR`
 */
export function compile(source: string, binary: string, sysroot: string, definitions: Record<string, string>): void {
	sysroot = resolve(sysroot);
	binary = resolve(binary);
	const root = prefix(sysroot);
	const options: Record<string, string> = {
		CMAKE_TOOLCHAIN_FILE: join(templates, 'toolchain.cmake'),
		CMAKE_BUILD_TYPE: 'Release',
		GIRBIND_SYSROOT: sysroot,
		GIRBIND_MINGW: toolPrefix(),
		CMAKE_JS_INC: (require('node-api-headers') as { include_dir: string }).include_dir,
		CMAKE_JS_SRC: join(templates, 'delay-load-hook.c'),
		CMAKE_JS_LIB: nodeLibrary(binary),
		...definitions,
	};
	const env = {
		...process.env,
		PKG_CONFIG_LIBDIR: [join(root, 'lib/pkgconfig'), join(root, 'share/pkgconfig')].join(delimiter),
		PKG_CONFIG_SYSROOT_DIR: sysroot,
	};
	const generator = process.platform == 'win32' ? ['-G', 'MinGW Makefiles'] : [];
	execFileSync(
		'cmake',
		[
			'-S',
			source,
			'-B',
			binary,
			...generator,
			...Object.entries(options).map(([key, value]) => `-D${key}=${value.replaceAll('\\', '/')}`),
		],
		{ stdio: 'inherit', env }
	);
	execFileSync('cmake', ['--build', binary, '--parallel'], { stdio: 'inherit', env });
}
