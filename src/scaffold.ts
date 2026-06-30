/**
 * Scaffolding of the build configuration (CMakeLists.txt) from the templates
 * shipped with girbind. Templates use `@PLACEHOLDER@` markers that are filled in
 * here from the binding's settings.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DepEntry, type NamedDep, resolveDep } from './deps.js';

/** Directory holding the shipped templates, resolved relative to this module. */
const templatesDir = join(import.meta.dirname, '..', 'templates');

export interface CMakeOptions {
	/** CMake project / addon target name (becomes `<name>.node`). */
	projectName: string;
	/** Directory containing the generated `.cc` source(s), relative to the CMake root. */
	srcDir: string;
	/** Directory the built `.node` is written to, relative to the CMake root. */
	outputDir: string;
	/** pkg-config modules to require, e.g. `['flatpak', 'glib-2.0']`. */
	pkgConfigModules: string[];
}

/** Render the CMakeLists.txt template with the given options. */
export function renderCMakeLists(options: CMakeOptions): string {
	const template = readFileSync(join(templatesDir, 'CMakeLists.txt'), 'utf8');
	const replacements: Record<string, string> = {
		'@PROJECT_NAME@': options.projectName,
		'@SRC_DIR@': options.srcDir,
		'@OUTPUT_DIR@': options.outputDir,
		'@PKGCONFIG_MODULES@': options.pkgConfigModules.join(' '),
	};
	return template.replace(/@[A-Z_]+@/g, m => replacements[m] ?? m);
}

export interface WriteCmakeOptions extends NamedDep {
	buildDir: string;
	outdir: string;
}

// `generate` also scaffolds a standalone per-directory CMakeLists (the
// aggregate flow uses girbind/CMakeLists.txt instead).
export function writeCMakeLists(opts: WriteCmakeOptions) {
	writeFileSync(
		join(opts.outdir, 'CMakeLists.txt'),
		renderCMakeLists({
			projectName: opts.name,
			srcDir: '.',
			outputDir: resolve(opts.buildDir),
			pkgConfigModules: [...BASE_PKGCONFIG, ...opts.pkgConfig],
		})
	);
}

/** One addon in an aggregate build. */
export interface CMakeTarget {
	/** Addon name; the output is `<name>.node`. */
	name: string;
	/** Directory holding this addon's `.cc`, relative to the CMake root. */
	srcDir: string;
	/** pkg-config modules to require for this addon. */
	pkgConfigModules: string[];
}

export interface AggregateCMakeOptions {
	projectName: string;
	outputDir: string;
	targets: CMakeTarget[];
}

/**
 * Emit one CMake target block per addon. The target is named `<name>_addon`
 * (distinct from the linked library, which may share the addon's name) with
 * `OUTPUT_NAME <name>` so the file is `<name>.node`. Each target resolves its
 * own pkg-config group so packages don't share link flags.
 */
function targetBlock(target: CMakeTarget): string {
	const deps = `${target.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DEPS`;
	return [
		`pkg_check_modules(${deps} REQUIRED ${target.pkgConfigModules.join(' ')})`,
		`file(GLOB ${target.name}_SRC "${target.srcDir}/*.cc")`,
		`add_library(${target.name}_addon SHARED \${${target.name}_SRC} \${CMAKE_JS_SRC})`,
		`set_target_properties(${target.name}_addon PROPERTIES`,
		`\tOUTPUT_NAME "${target.name}"`,
		'\tPREFIX ""',
		'\tSUFFIX ".node"',
		'\tLIBRARY_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"',
		'\tRUNTIME_OUTPUT_DIRECTORY "${GIRBIND_OUTPUT_DIR}"',
		')',
		`target_include_directories(${target.name}_addon PRIVATE \${CMAKE_JS_INC} \${NODE_ADDON_API_DIR} \${${deps}_INCLUDE_DIRS})`,
		`target_link_libraries(${target.name}_addon PRIVATE \${CMAKE_JS_LIB} \${${deps}_LIBRARIES})`,
		`target_compile_features(${target.name}_addon PRIVATE cxx_std_23)`,
	].join('\n');
}

/** Render the aggregate CMakeLists.txt that builds every girbind package. */
export function renderAggregateCMakeLists(options: AggregateCMakeOptions): string {
	const template = readFileSync(join(templatesDir, 'CMakeLists.aggregate.txt'), 'utf8');
	const replacements: Record<string, string> = {
		'@PROJECT_NAME@': options.projectName,
		'@OUTPUT_DIR@': options.outputDir,
		'@TARGETS@': options.targets.map(targetBlock).join('\n\n'),
	};
	return template.replace(/@[A-Z_]+@/g, m => replacements[m] ?? m);
}

/** glib is always linked (we include <glib-object.h>); package configs add the target library. */
export const BASE_PKGCONFIG = ['glib-2.0', 'gobject-2.0'];

/** Directory under the project root holding generated per-package sources. */
export const GIRBIND_DIR = 'girbind';

/** Write `girbind/CMakeLists.txt` with one target per dependency. */
export function writeAggregateCMake(root: string, deps: DepEntry[]): void {
	const girbindRoot = join(root, GIRBIND_DIR);
	mkdirSync(girbindRoot, { recursive: true });
	writeFileSync(
		join(girbindRoot, 'CMakeLists.txt'),
		renderAggregateCMakeLists({
			projectName: 'girbind_addons',
			outputDir: resolve(root, 'native'),
			targets: deps.map(entry => {
				const dep = resolveDep(entry);
				return {
					name: dep.name,
					srcDir: dep.name,
					pkgConfigModules: [...BASE_PKGCONFIG, ...dep.pkgConfig],
				};
			}),
		})
	);
}
