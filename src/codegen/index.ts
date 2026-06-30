import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ResolvedDep } from '../deps.js';
import type { Namespace } from '../ir.js';
import { parseGirFile } from '../parse.js';

import * as cxx from './cxx.js';
import * as js from './js.js';
import * as ts from './ts.js';

export { cxx, js, ts };

/**
 * Generate the .cc/.js/.d.ts for one resolved dependency into `dir`, using
 * `dep.name` as the module name. The entry point requires the sibling
 * `./<name>.node` that the build colocates with it. Returns the parsed namespace
 * so callers can report on it.
 */
export function generatePackage(dep: ResolvedDep, dir: string, parsed?: Namespace): Namespace {
	const ns = parsed ?? parseGirFile(dep.gir);
	const moduleName = dep.name;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${moduleName}.cc`), cxx.generate(ns, { moduleName, includes: dep.include }));
	writeFileSync(join(dir, `${moduleName}.d.ts`), ts.generate(ns));
	writeFileSync(join(dir, `${moduleName}.js`), js.generate(ns, `./${moduleName}.node`));
	return ns;
}
