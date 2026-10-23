import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ResolvedDep } from '../deps.js';
import type { Namespace } from '../ir.js';
import { loadRepository, parseGirFile } from '../parse.js';

import * as cxx from './cxx.js';
import * as js from './js.js';
import * as ts from './ts.js';

export { cxx, js, ts };

/** Write `content` to `path` unless the file already holds it, so unchanged sources are not rebuilt. */
function writeIfChanged(path: string, content: string): void {
	if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
	writeFileSync(path, content);
}

/**
 * Generate the .cxx/.js/.d.ts for one resolved dependency into `dir`, using
 * `dep.name` as the module name. The entry point requires the sibling
 * `./<name>.node` that the build colocates with it. Returns the parsed namespace
 * so callers can report on it.
 *
 * @param modules import specifiers of other bound namespaces, by namespace name
 */
export function generatePackage(
	dep: ResolvedDep,
	dir: string,
	parsed?: Namespace,
	modules: Record<string, string> = {}
): Namespace {
	const ns = parsed ?? parseGirFile(dep.gir);
	const repository = loadRepository(dep.gir, ns);
	const moduleName = dep.name;
	mkdirSync(dir, { recursive: true });
	writeIfChanged(
		join(dir, `${moduleName}.cxx`),
		cxx.generate(ns, { moduleName, includes: dep.include, defines: dep.defines, repository, modules })
	);
	writeIfChanged(join(dir, `${moduleName}.d.ts`), ts.generate(ns, { repository, modules }));
	writeIfChanged(
		join(dir, `${moduleName}.js`),
		js.generate(ns, { addonPath: `./${moduleName}.node`, repository, modules })
	);
	return ns;
}

/**
 * Parse each dependency's namespace and map namespace names to sibling
 * `./<name>.js` modules, as laid out by `girbind build`.
 */
export function siblingModules(deps: ResolvedDep[]): {
	namespaces: Map<ResolvedDep, Namespace>;
	modules: Record<string, string>;
} {
	const namespaces = new Map<ResolvedDep, Namespace>();
	const modules: Record<string, string> = {};
	for (const dep of deps) {
		const ns = parseGirFile(dep.gir);
		namespaces.set(dep, ns);
		modules[ns.name] = `./${dep.name}.js`;
	}
	return { namespaces, modules };
}
