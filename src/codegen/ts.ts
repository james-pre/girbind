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

import type { Class, Enumeration, Func, Interface, Namespace, Signal, TypeRef } from '../ir.js';
import { factoryName, functionExportNames, methodName, propertyKey } from '../names.js';
import type { Repository } from '../parse.js';
import { type RecordType, TypeContext } from '../types.js';
import {
	boundClasses,
	boundInterfaces,
	boundRecords,
	classOwner,
	factories,
	fields,
	hasSetter,
	interfaceOwner,
	isErrorParam,
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
	const inParams = func.parameters.filter(p => !p.isInstance && p.direction !== 'out' && !isErrorParam(p));
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

function typed(ctx: TypeContext, type: TypeRef, nullable: boolean): string {
	return nullable ? `${ctx.tsType(type)} | null` : ctx.tsType(type);
}

/** The return value alone, the only out parameter of a void function, or else a tuple of the return value and out parameters. */
function ret(ctx: TypeContext, func: Func): string {
	const rv = func.returnValue;
	const outputs = func.parameters.filter(p => !p.isInstance && p.direction !== 'in' && !isErrorParam(p));
	const returns = rv.type.girType !== 'none';
	if (!outputs.length) return returns ? typed(ctx, rv.type, rv.nullable) : 'void';
	if (!returns && outputs.length === 1) return typed(ctx, outputs[0].type, outputs[0].nullable);
	const elements = outputs.map(p => `${parameterName(p.name)}: ${typed(ctx, p.type, p.nullable)}`);
	if (returns) elements.unshift(`result: ${typed(ctx, rv.type, rv.nullable)}`);
	return `[${elements.join(', ')}]`;
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

/** A signal map: arguments (excluding the emitter) and return value, by name. */
function signalMap(ctx: TypeContext, sources: { signals: Signal[]; namespace: string }[]): string {
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const { signals, namespace } of sources) {
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
	}
	return entries.length ? `{ ${entries.join('; ')} }` : '{}';
}

function namespaceOf(qualified: string): string {
	return qualified.slice(0, qualified.lastIndexOf('.'));
}

/** The signals a class passes to its parent: its own, its unbound ancestors' and its interfaces'. */
function classSignals(ctx: TypeContext, cls: Class): { signals: Signal[]; namespace: string }[] {
	return unboundChain(ctx, cls).flatMap(({ cls: owner, namespace }) => [
		{ signals: owner.signals, namespace },
		...owner.implements.map(qualified => ({
			signals: ctx.anyInterface(qualified)?.signals ?? [],
			namespace: namespaceOf(qualified),
		})),
	]);
}

/** JS names of an interface's instance members. */
function interfaceMembers(ctx: TypeContext, qualified: string): string[] {
	const iface = ctx.anyInterface(qualified);
	if (!iface) return [];
	const owner = interfaceOwner(ctx, iface, qualified);
	return [...methods(owner).map(methodName), ...properties(owner).map(p => memberName(p.name))];
}

/** JS names of the instance members of `qualified` and its ancestors, including their interfaces'. */
function ancestorMembers(ctx: TypeContext, qualified: string | undefined): Set<string> {
	const names = new Set<string>();
	for (let current = qualified ? ctx.anyClass(qualified) : undefined; current;) {
		for (const f of current.methods) names.add(methodName(f));
		for (const p of current.properties) names.add(memberName(p.name));
		for (const implemented of current.implements) {
			for (const name of interfaceMembers(ctx, implemented)) names.add(name);
		}
		current = current.parent ? ctx.anyClass(current.parent) : undefined;
	}
	return names;
}

function* members(ctx: TypeContext, owner: Owner, inherited = new Set<string>()): Lines {
	if (owner.primary) yield `\tconstructor(${params(ctx, owner.primary)});`;
	else if (zeroConstructible(owner)) yield '\tconstructor();';
	// `protected` (not `private`) so subclasses can still `extends` a return-only
	// base; the runtime constructor throws for these classes regardless.
	else yield '\tprotected constructor();';
	yield* staticMembers(ctx, owner, 'static ');
	yield* instanceMembers(ctx, owner, inherited);
}

function* staticMembers(ctx: TypeContext, owner: Owner, modifier: string): Lines {
	for (const f of factories(owner)) yield `\t${modifier}${factoryName(f)}(${params(ctx, f)}): ${owner.name};`;
	for (const f of statics(owner)) yield `\t${modifier}${methodName(f)}(${params(ctx, f)}): ${ret(ctx, f)};`;
}

/**
 * Methods, properties and fields. A member named like an `inherited` one gets
 * `// @ts-ignore`, since a GIR override may change its signature, unless
 * `skipInherited` is set, which leaves it out instead.
 */
function* instanceMembers(ctx: TypeContext, owner: Owner, inherited: Set<string>, skipInherited = false): Lines {
	const override = function* (name: string): Lines {
		if (inherited.has(name)) yield '\t// @ts-ignore';
	};
	for (const f of methods(owner)) {
		if (skipInherited && inherited.has(methodName(f))) continue;
		yield* override(methodName(f));
		yield `\t${methodName(f)}(${params(ctx, f)}): ${ret(ctx, f)};`;
	}
	for (const p of properties(owner)) {
		if (skipInherited && inherited.has(memberName(p.name))) continue;
		const propertyType = ctx.tsType(p.type);
		yield* override(memberName(p.name));
		if (p.readable) yield `\tget ${memberName(p.name)}(): ${propertyType};`;
		if (hasSetter(ctx, owner.members as Class | Interface, p)) {
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

/**
 * Interfaces a class implements that its bound parent does not, which its
 * declaration merges with. Their `[signals]` maps always differ from the
 * class's, which TypeScript reports but resolves to the class's own.
 */
function* implementedDecl(ctx: TypeContext, cls: Class): Lines {
	const parent = ctx.anyClass(ctx.boundParent(cls).qualified);
	const references = cls.implements
		.filter(qualified => !parent?.implements.includes(qualified))
		.map(qualified => ctx.interfaceReference(qualified))
		.filter((reference): reference is string => !!reference);
	if (!references.length) return;
	yield '// @ts-ignore';
	yield `export interface ${cls.name}<S extends object = {}> extends ${references.map(reference => `${reference}<S>`).join(', ')} {}`;
}

function* classDecl(ctx: TypeContext, cls: Class): Lines {
	const parent = ctx.classReference(ctx.boundParent(cls).qualified);
	yield* implementedDecl(ctx, cls);
	yield `export declare class ${cls.name}<S extends object = {}> extends ${parent}<${signalMap(ctx, classSignals(ctx, cls))} & S> {`;
	yield* members(ctx, classOwner(ctx, cls), ancestorMembers(ctx, cls.parent));
	yield '}';
	yield '';
}

/**
 * An interface as an interface type extending its prerequisite class, and a
 * value holding its static members. Members the prerequisite class already has
 * are left out, as the class's take precedence at runtime.
 */
function* interfaceDecl(ctx: TypeContext, iface: Interface): Lines {
	const owner = interfaceOwner(ctx, iface);
	const prerequisite = iface.prerequisites.find(qualified => ctx.anyClass(qualified)) ?? 'GObject.Object';
	const parent = ctx.classReference(prerequisite);
	const signals = [
		{ signals: iface.signals, namespace: ctx.ns.name },
		...iface.prerequisites.map(qualified => ({
			signals: ctx.anyInterface(qualified)?.signals ?? [],
			namespace: namespaceOf(qualified),
		})),
	];
	yield `export interface ${iface.name}<S extends object = {}> extends ${parent}<${signalMap(ctx, signals)} & S> {`;
	yield* instanceMembers(ctx, owner, ancestorMembers(ctx, prerequisite), true);
	yield '}';
	yield `export declare const ${iface.name}: {`;
	yield `\treadonly prototype: ${iface.name};`;
	yield `\t[Symbol.hasInstance](value: unknown): value is ${iface.name};`;
	yield* staticMembers(ctx, owner, '');
	yield '};';
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
	const interfaces = boundInterfaces(ctx);
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
	for (const iface of interfaces) yield* interfaceDecl(ctx, iface);
	for (const cls of classes) yield* classDecl(ctx, cls);
	for (const { func, jsName } of functions) {
		yield `export declare function ${jsName}(${params(ctx, func)}): ${ret(ctx, func)};`;
	}
	yield '';
	yield 'declare const _default: {';
	for (const { record } of records) yield `\t${record.name}: typeof ${record.name};`;
	for (const iface of interfaces) yield `\t${iface.name}: typeof ${iface.name};`;
	for (const cls of classes) yield `	${cls.name}: typeof ${cls.name};`;
	for (const { jsName } of functions) yield `	${jsName}: typeof ${jsName};`;
	for (const e of ns.enumerations) yield `	${e.name}: typeof ${e.name};`;
	yield '};';
	yield 'export default _default;';
}

export function generate(ns: Namespace, options: Options = {}): string {
	return [...file(ns, options)].join('\n') + '\n';
}
