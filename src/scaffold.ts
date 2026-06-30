/**
 * Scaffolding of the build configuration (CMakeLists.txt) from the templates
 * shipped with girbind. Templates use `@PLACEHOLDER@` markers that are filled in
 * here from the binding's settings.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
