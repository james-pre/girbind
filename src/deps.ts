/**
 * girbind dependency model: the `girbindDependencies` field in a consumer/author
 * package.json, and the built-in library configs shipped in `configs.json`.
 *
 * An entry is either a string (the name of a built-in config) or an object with
 * an explicit config for a library girbind doesn't ship. Both resolve to the
 * same {@link ResolvedDep}.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import builtinConfigs from './configs.json' with { type: 'json' };

/** A library build config: where its GIR is and what C++/pkg-config it needs. */
export interface LibraryConfig {
	gir: string;
	include: string[];
	pkgConfig: string[];
}

/** A built-in config plus its name (the configs.json key). */
export interface ResolvedDep extends LibraryConfig {
	name: string;
}

/** An explicit dependency entry: a custom config carrying its own name. */
export interface NamedDep extends LibraryConfig {
	name: string;
}

/** A `girbindDependencies` entry: a built-in name or an inline config. */
export type DepEntry = string | NamedDep;

const configs: Record<string, LibraryConfig> = builtinConfigs;

/** Names of all built-in library configs. */
export function builtinNames(): string[] {
	return Object.keys(configs);
}

/** The name a dependency entry refers to. */
export function depName(entry: DepEntry): string {
	return typeof entry === 'string' ? entry : entry.name;
}

/**
 * Resolve an entry to a full config. A string is looked up in the built-in
 * configs; an object is used as-is (allowing libraries girbind doesn't ship).
 */
export function resolveDep(entry: DepEntry): ResolvedDep {
	if (typeof entry === 'string') {
		const config = configs[entry];
		if (!config) {
			throw new Error(
				`No built-in config for "${entry}". Known: ${builtinNames().join(', ') || '(none)'}. `
					+ `Pass an inline config object in girbindDependencies for custom libraries.`
			);
		}
		return { name: entry, ...config };
	}
	if (!entry.name) throw new Error('girbindDependencies object entry is missing a "name"');
	return { name: entry.name, gir: entry.gir, include: entry.include, pkgConfig: entry.pkgConfig };
}

interface PackageJson {
	girbindDependencies?: DepEntry[];
	[key: string]: unknown;
}

/** Read a package.json, returning its parsed contents (or an empty object shape). */
export function readPackageJson(path: string): PackageJson {
	return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
}

/** Write a package.json back, preserving 4-space-tab indentation and a trailing newline. */
export function writePackageJson(path: string, pkg: PackageJson): void {
	writeFileSync(path, JSON.stringify(pkg, null, '\t') + '\n');
}
