/**
 * TypeScript declaration (`.d.ts`) emitter.
 *
 * Emits one `declare class` per GObject class (using real `extends` to mirror
 * the C++/JS inheritance), enum types, and standalone function declarations.
 * All names come from {@link ../names} so they match the addon's exports exactly.
 *
 * Like the C++ emitter, this is built from generator functions that `yield`
 * lines; {@link generate} joins them. Emitted code is tab-indented.
 */

import type { Class, Enumeration, Func, Namespace, Signal, TypeRef } from '../ir.js';
import { factoryName, functionExportNames, methodName, propertyKey } from '../names.js';
import type { Repository } from '../parse.js';
import { type RecordType, TypeContext } from '../types.js';
import {
	boundClasses,
	boundRecords,
	classOwner,
	factories,
	fields,
	hasSetter,
	methods,
	type Owner,
	properties,
	recordOwner,
	statics,
	zeroConstructible,
} from './cxx.js';

type Lines = Generator<string, void, void>;

function memberName(name: string): string {
	return name.replace(/-/g, '_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function* enumDecl(e: Enumeration): Lines {
	yield `export enum ${e.name} {`;
	for (const m of e.members) yield `\t${propertyKey(m.name)} = ${m.value},`;
	yield '}';
	yield '';
}

function params(ctx: TypeContext, func: Func): string {
	const inParams = func.parameters.filter(
		p => !p.isInstance && p.direction === 'in' && p.type.cType.replace(/\s/g, '') !== 'GError**'
	);
	// A param may be syntactically optional (`?`) only if every later param is
	// also optional; otherwise TS rejects "required after optional". A nullable
	// param that precedes a required one stays required but accepts `| null`.
	// `optionalFrom` is the index of the first param in the trailing run of
	// nullable params (= length when there is no such run).
	let optionalFrom = inParams.length;
	while (optionalFrom > 0 && inParams[optionalFrom - 1].nullable) optionalFrom--;
	return inParams
		.map((p, i) => {
			const name = parameterName(p.name);
			const type = ctx.tsType(p.type);
			const optional = p.nullable && i >= optionalFrom;
			return `${name}${optional ? '?' : ''}: ${type}${p.nullable ? ' | null' : ''}`;
		})
		.join(', ');
}

function ret(ctx: TypeContext, func: Func): string {
	const rv = func.returnValue;
	if (rv.type.girType === 'none') return 'void';
	const base = ctx.tsType(rv.type);
	return rv.nullable ? `${base} | null` : base;
}

/** Parameter and tuple-label names that are reserved words get a trailing underscore. */
const reserved = new Set([
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'import',
	'in',
	'instanceof',
	'new',
	'null',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
]);

function parameterName(name: string): string {
	const camel = memberName(name);
	return reserved.has(camel) ? `${camel}_` : camel;
}

/** Qualify a type name from another namespace's GIR so it resolves in this one. */
function inNamespace(type: TypeRef, namespace: string): TypeRef {
	const qualify = (name: string) => (/^[A-Z]/.test(name) && !name.includes('.') ? `${namespace}.${name}` : name);
	return {
		...type,
		girType: qualify(type.girType),
		elementType: type.elementType && qualify(type.elementType),
	};
}

/**
 * Classes from `cls` up to (excluding) the bound parent its declaration
 * extends, each with the namespace that declares it. Their signals are the ones
 * this declaration adds to the signal map.
 */
function unboundChain(ctx: TypeContext, cls: Class): { cls: Class; namespace: string }[] {
	const stop = ctx.boundParent(cls).qualified;
	const chain: { cls: Class; namespace: string }[] = [];
	for (let qualified: string | undefined = ctx.qualify(cls.name); qualified && qualified !== stop;) {
		const current = ctx.anyClass(qualified);
		if (!current) break;
		chain.push({ cls: current, namespace: qualified.slice(0, qualified.lastIndexOf('.')) });
		qualified = current.parent;
	}
	return chain;
}

/** The signal map a class passes to its parent: arguments (excluding the emitter) and return value, by name. */
function signalMap(ctx: TypeContext, cls: Class): string {
	const seen = new Set<string>();
	const entries: string[] = [];
	const add = (signals: Signal[], namespace: string) => {
		for (const signal of signals) {
			if (seen.has(signal.name)) continue;
			seen.add(signal.name);
			const args = signal.parameters.map(p => {
				const type = ctx.tsType(inNamespace(p.type, namespace));
				return `${parameterName(p.name)}: ${type}${p.nullable ? ' | null' : ''}`;
			});
			const rv = signal.returnValue;
			const result =
				rv.type.girType === 'none' ? 'void' : `${ctx.tsType(inNamespace(rv.type, namespace))} | void`;
			entries.push(`'${signal.name}': (${args.join(', ')}) => ${result}`);
		}
	};
	for (const { cls: owner, namespace } of unboundChain(ctx, cls)) {
		add(owner.signals, namespace);
		for (const implemented of owner.implements) {
			const iface = ctx.anyInterface(implemented);
			if (iface) add(iface.signals, implemented.slice(0, implemented.lastIndexOf('.')));
		}
	}
	return entries.length ? `{ ${entries.join('; ')} }` : '{}';
}

/** JS names of the instance members of every ancestor, which a member of the same name overrides. */
function ancestorMembers(ctx: TypeContext, cls: Class): Set<string> {
	const names = new Set<string>();
	for (let qualified = cls.parent; qualified;) {
		const current = ctx.anyClass(qualified);
		if (!current) break;
		for (const f of current.methods) names.add(methodName(f));
		for (const p of current.properties) names.add(memberName(p.name));
		qualified = current.parent;
	}
	return names;
}

function* members(ctx: TypeContext, owner: Owner, inherited = new Set<string>()): Lines {
	const type = owner.name;
	// A GIR override may change an inherited member's signature, which TypeScript rejects.
	const override = function* (name: string): Lines {
		if (inherited.has(name)) yield '\t// @ts-ignore';
	};
	if (owner.primary) yield `\tconstructor(${params(ctx, owner.primary)});`;
	else if (zeroConstructible(owner)) yield '\tconstructor();';
	// `protected` (not `private`) so subclasses can still `extends` a return-only
	// base; the runtime constructor throws for these classes regardless.
	else yield '\tprotected constructor();';

	for (const f of factories(owner)) yield `\tstatic ${factoryName(f)}(${params(ctx, f)}): ${type};`;
	for (const f of statics(owner)) yield `\tstatic ${methodName(f)}(${params(ctx, f)}): ${ret(ctx, f)};`;
	for (const f of methods(owner)) {
		yield* override(methodName(f));
		yield `\t${methodName(f)}(${params(ctx, f)}): ${ret(ctx, f)};`;
	}
	for (const p of properties(owner)) {
		const propertyType = ctx.tsType(p.type);
		yield* override(memberName(p.name));
		if (p.readable) yield `\tget ${memberName(p.name)}(): ${propertyType};`;
		if (hasSetter(ctx, owner.members as Class, p)) {
			yield* override(memberName(p.name));
			yield `\tset ${memberName(p.name)}(value: ${propertyType});`;
		}
	}
	for (const field of fields(ctx, owner)) {
		const fieldType = ctx.tsType(field.type);
		yield `\tget ${memberName(field.name)}(): ${fieldType};`;
		if (field.writable) yield `\tset ${memberName(field.name)}(value: ${fieldType});`;
	}
}

function* classDecl(ctx: TypeContext, cls: Class): Lines {
	const parent = ctx.classReference(ctx.boundParent(cls).qualified);
	yield `export declare class ${cls.name}<S extends object = {}> extends ${parent}<${signalMap(ctx, cls)} & S> {`;
	yield* members(ctx, classOwner(ctx, cls), ancestorMembers(ctx, cls));
	yield '}';
	yield '';
}

function* recordDecl(ctx: TypeContext, type: RecordType): Lines {
	yield `export declare class ${type.record.name} extends GObject.Boxed {`;
	yield* members(ctx, recordOwner(ctx, type));
	yield '}';
	yield '';
}

export interface Options {
	repository?: Repository;
	/** Import specifiers of other bound namespaces, by namespace name. */
	modules?: Record<string, string>;
}

function* file(ns: Namespace, options: Options): Lines {
	const ctx = new TypeContext(ns, options.repository, options.modules);
	const records = boundRecords(ctx);
	const classes = boundClasses(ctx);
	const functions = functionExportNames(ns);
	yield `// Generated by girbind from ${ns.name}-${ns.version}`;
	yield '// DO NOT EDIT THIS FILE DIRECTLY';
	yield '';
	yield "import type { GObject } from 'girbind';";
	for (const name of ctx.importedNamespaces()) yield `import type * as ${name} from '${ctx.modules[name]}';`;
	yield '';
	for (const e of ns.enumerations) yield* enumDecl(e);
	for (const type of records) yield* recordDecl(ctx, type);
	for (const cls of classes) yield* classDecl(ctx, cls);
	for (const { func, jsName } of functions) {
		yield `export declare function ${jsName}(${params(ctx, func)}): ${ret(ctx, func)};`;
	}
	yield '';
	yield 'declare const _default: {';
	for (const { record } of records) yield `\t${record.name}: typeof ${record.name};`;
	for (const cls of classes) yield `	${cls.name}: typeof ${cls.name};`;
	for (const { jsName } of functions) yield `	${jsName}: typeof ${jsName};`;
	for (const e of ns.enumerations) yield `	${e.name}: typeof ${e.name};`;
	yield '};';
	yield 'export default _default;';
}

export function generate(ns: Namespace, options: Options = {}): string {
	return [...file(ns, options)].join('\n') + '\n';
}
