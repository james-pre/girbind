/**
 * Name resolution shared by every emitter.
 *
 * The critical invariant (see the reference notes §2): the JS export names, the
 * TypeScript declarations, and the C++ registration must all use the *exact*
 * same names. To guarantee that, name derivation lives here and nowhere else —
 * the C++ and TS emitters both call into this module.
 */

import type { Func, Namespace } from './ir.js';

/**
 * Whether girbind can currently emit a binding for a function. Functions taking
 * a callback (a parameter with a GIR `scope`) are skipped for now — wrapping
 * GObject callbacks across the JS boundary is not yet implemented. Used by every
 * emitter so the JS/TS/C++ exported sets stay identical.
 */
export function isSupported(func: Func): boolean {
	return !func.parameters.some(p => p.scope !== undefined);
}

/** Convert a snake_case / hyphenated GIR name to camelCase. */
export function camelCase(name: string): string {
	const parts = name.split(/[-_]/).filter(Boolean);
	if (parts.length === 0) return name;
	return (
		parts[0]
		+ parts
			.slice(1)
			.map(p => p[0].toUpperCase() + p.slice(1))
			.join('')
	);
}

/** Convert a hyphenated/underscored property name to an identifier-safe form. */
export function snakeCase(name: string): string {
	return name.replace(/-/g, '_');
}

/**
 * JS method name for a function. Preserves `get`/`set`/`is` prefixes
 * (`get_no_interaction` → `getNoInteraction`) — these are part of the public API
 * shape and must not be stripped.
 */
export function methodName(func: Func): string {
	return camelCase(func.name);
}

/**
 * JS name for a constructor exposed as a static factory method
 * (`new_for_path` → `newForPath`). The primary `new` constructor maps to JS
 * `new X(...)` and has no factory name.
 */
export function factoryName(func: Func): string {
	return camelCase(func.name);
}

/**
 * Choose the constructor bound to JS `new`: the plain `new` if present,
 * otherwise the first constructor, or undefined for return-only classes.
 */
export function primaryConstructor(constructors: Func[]): Func | undefined {
	if (constructors.length === 0) return undefined;
	return constructors.find(c => c.name === 'new') ?? constructors[0];
}

/** Constructors exposed as static factories (everything but the primary). */
export function secondaryConstructors(constructors: Func[]): Func[] {
	const primary = primaryConstructor(constructors);
	return constructors.filter(c => c !== primary);
}

/**
 * Resolve the exported JS name for every standalone function, applying quark
 * special-cases and de-duplication. Returns a stable, ordered list so the C++
 * init emitter and the TS/JS emitters agree exactly.
 *
 * - `*_quark` functions camelCase awkwardly and frequently collide; we map them
 *   to `<prefix>ErrorQuark` form derived from the C symbol so two quark
 *   functions in one namespace stay distinct.
 * - Any remaining collision after camelCasing is disambiguated by prefixing the
 *   C symbol's first token.
 */
export function functionExportNames(ns: Namespace): { func: Func; jsName: string }[] {
	const used = new Set<string>();
	const result: { func: Func; jsName: string }[] = [];

	for (const func of ns.functions) {
		if (!isSupported(func)) continue;
		let jsName = methodName(func);

		if (func.name.endsWith('quark') || func.name.includes('quark')) {
			// e.g. flatpak_error_quark -> errorQuark,
			//      flatpak_portal_error_quark -> portalErrorQuark
			const tokens = func.cName.split('_');
			// Drop the namespace symbol prefix (first token), camelCase the rest.
			jsName = camelCase(tokens.slice(1).join('_')) || jsName;
		}

		if (used.has(jsName)) {
			jsName = camelCase(func.cName.split('_')[0] + '_' + jsName);
		}

		used.add(jsName);
		result.push({ func, jsName });
	}

	return result;
}

/** Property getter/setter accessor names, JS-facing (camelCase). */
export function propertyAccessorName(propName: string): string {
	return camelCase(propName);
}
