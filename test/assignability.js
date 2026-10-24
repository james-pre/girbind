// Writes a TypeScript file asserting that every class in a directory of
// generated declarations is assignable to its parent and to the interfaces it
// merges with. Invoked by test/gio.sh as `node test/assignability.js <dir> <out>`.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [directory, output] = process.argv.slice(2);
const lines = ["import type { GObject } from 'girbind';"];

for (const file of readdirSync(directory).filter(name => name.endsWith('.d.ts'))) {
	const module = file.slice(0, -'.d.ts'.length);
	const alias = `Module_${module}`;
	lines.push(`import type * as ${alias} from './${module}.js';`);
	const text = readFileSync(join(directory, file), 'utf8');
	const imports = new Map(
		[...text.matchAll(/import type \* as (\w+) from '\.\/([^']+)\.js'/g)].map(([, name, target]) => [name, target])
	);
	const resolve = reference => {
		const [namespace, name] = reference.includes('.') ? reference.split('.') : [undefined, reference];
		if (!namespace) return `${alias}.${name}`;
		if (namespace === 'GObject') return reference;
		return `Module_${imports.get(namespace)}.${name}`;
	};
	const assignable = (name, base) => lines.push(`void ((value: ${alias}.${name}): ${resolve(base)} => value);`);

	for (const [, name, parent] of text.matchAll(
		/^export declare class (\w+)<S extends object = \{\}> extends ([\w.]+)</gm
	)) {
		assignable(name, parent);
	}
	for (const [, name, bases] of text.matchAll(
		/^export interface (\w+)<S extends object = \{\}> extends ([^{]+) \{\}$/gm
	)) {
		for (const base of bases.split(', ')) assignable(name, base.replace(/<S>$/, ''));
	}
}

writeFileSync(output, lines.join('\n') + '\n');
