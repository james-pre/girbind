/**
 * GIR (GObject Introspection) XML parser.
 *
 * Parses a `.gir` file into the namespace-agnostic {@link Namespace} IR defined
 * in {@link ./model}. Uses `fast-xml-parser` with namespace prefixes preserved
 * (`c:type`, `c:identifier`, `glib:type-name`) since those carry the C symbols
 * the bindings target.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type {
	Callback,
	Class,
	Direction,
	EnumMember,
	Enumeration,
	Field,
	Func,
	Include,
	Interface,
	Namespace,
	Parameter,
	Property,
	Struct,
	ReturnValue,
	Signal,
	Transfer,
	TypeInfo,
	TypeRef,
} from './ir.js';
import { isSupported } from './names.js';
import { TypeContext } from './types.js';

/** Attribute key prefix used by the parser (e.g. `@_name`, `@_c:type`). */
const ATTR = '@_';

/**
 * fast-xml-parser rejects `constructor` as a tag name (prototype-pollution
 * guard), and GIR uses `<constructor>`. We rename it to this safe key on the way
 * in via `transformTagName` and read it under the new name.
 */
const CONSTRUCTOR_TAG = 'gir-constructor';

/**
 * Elements that may appear more than once under a parent. Forcing them to
 * always be arrays avoids the fast-xml-parser footgun where a single occurrence
 * becomes an object and multiple become an array (which would break codegen on
 * small libraries but not large ones).
 */
const ARRAY_ELEMENTS = new Set([
	'class',
	'interface',
	'record',
	'function',
	'method',
	CONSTRUCTOR_TAG,
	'static-method',
	'virtual-method',
	'property',
	'parameter',
	'enumeration',
	'bitfield',
	'member',
	'implements',
	'prerequisite',
	'include',
	'callback',
	'union',
	'field',
	'glib:signal',
]);

/** A parsed XML node: attributes (prefixed) plus child element keys. */
type Node = Record<string, unknown>;

function attr(node: Node, name: string): string | undefined {
	const value = node[ATTR + name];
	// eslint-disable-next-line @typescript-eslint/no-base-to-string
	return value === undefined ? undefined : String(value);
}

function boolAttr(node: Node, name: string, fallback = false): boolean {
	const value = attr(node, name);
	if (value === undefined) return fallback;
	return value === '1' || value === 'true';
}

/** Normalize a child element into an array (it is missing, an object, or already an array). */
function children(node: Node | undefined, key: string): Node[] {
	if (!node) return [];
	const value = node[key];
	if (value === undefined) return [];
	return (Array.isArray(value) ? value : [value]) as Node[];
}

/** Return the single child element of the given key, if present. */
function child(node: Node | undefined, key: string): Node | undefined {
	return children(node, key)[0];
}

/** Prefix an unqualified GIR name with its namespace (`Ref` → `Flatpak.Ref`). */
function qualify(name: string, namespace: string): string {
	return name.includes('.') ? name : `${namespace}.${name}`;
}

function splitPrefixes(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
}

/** Parse a `<type>` or `<array>` child of a parameter / return-value / property. */
function parseTypeRef(owner: Node | undefined): TypeRef {
	const arrayElem = child(owner, 'array');
	if (arrayElem) {
		const inner = child(arrayElem, 'type');
		const length = attr(arrayElem, 'length');
		const fixedSize = attr(arrayElem, 'fixed-size');
		return {
			girType: attr(arrayElem, 'name') ?? '',
			cType: attr(arrayElem, 'c:type') ?? '',
			isArray: true,
			elementType: inner ? (attr(inner, 'name') ?? '') : '',
			elementCType: inner ? attr(inner, 'c:type') : undefined,
			length: length === undefined ? undefined : Number(length),
			fixedSize: fixedSize === undefined ? undefined : Number(fixedSize),
			zeroTerminated: boolAttr(arrayElem, 'zero-terminated', length === undefined && fixedSize === undefined),
		};
	}

	const typeElem = child(owner, 'type');
	return {
		girType: attr(typeElem ?? {}, 'name') ?? 'none',
		cType: attr(typeElem ?? {}, 'c:type') ?? '',
		isArray: false,
	};
}

function parseTransfer(node: Node): Transfer {
	const value = attr(node, 'transfer-ownership');
	return value === 'full' || value === 'container' ? value : 'none';
}

/**
 * GIR scalar value types. For these, a parameter whose `c:type` is a pointer
 * (e.g. `gboolean*`) is an output parameter even when the GIR omits
 * `direction="out"` — common in real-world GIRs (e.g. Flatpak's `out_changed`).
 */
const SCALAR_GIR_TYPES = new Set([
	'gboolean',
	'gint',
	'guint',
	'gint8',
	'guint8',
	'gint16',
	'guint16',
	'gint32',
	'guint32',
	'gint64',
	'guint64',
	'glong',
	'gulong',
	'gshort',
	'gushort',
	'gsize',
	'gssize',
	'gdouble',
	'gfloat',
]);

function parseParameter(node: Node, isInstance: boolean): Parameter {
	const declared = (attr(node, 'direction') as Direction) ?? 'in';
	const type = parseTypeRef(node);

	// Trust an explicit out/inout; otherwise infer `out` from a reliable
	// structural signal (we avoid name-based guessing, which misfires on
	// well-annotated GIRs):
	//   - a scalar value type carried by a pointer c:type (`gboolean*`), or
	//   - any type carried by a pointer-to-pointer c:type (`FlatpakInstance**`),
	//     which is the classic "fill in my pointer" output convention.
	// A non-scalar single pointer (`const char*`, `FlatpakRef*`) is an ordinary
	// by-reference input, not an output.
	const pointerDepth = (type.cType.match(/\*/g) ?? []).length;
	let direction: Direction = declared === 'out' || declared === 'inout' ? declared : 'in';
	if (direction === 'in' && !type.isArray) {
		// Arrays carry their own pointer level and are handled as inputs by the
		// emitter, so the pointer heuristics below apply to scalars/objects only.
		const scalarOut = SCALAR_GIR_TYPES.has(type.girType) && pointerDepth >= 1;
		const pointerOut = pointerDepth >= 2 && type.girType !== 'utf8' && type.girType !== 'filename';
		if (scalarOut || pointerOut) direction = 'out';
	}

	return {
		name: attr(node, 'name') ?? '',
		type,
		transfer: parseTransfer(node),
		nullable: boolAttr(node, 'nullable'),
		direction,
		isInstance,
		callerAllocates: boolAttr(node, 'caller-allocates'),
		scope: attr(node, 'scope'),
		closure: index(attr(node, 'closure')),
		destroy: index(attr(node, 'destroy')),
	};
}

function index(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

function parseReturnValue(node: Node | undefined): ReturnValue {
	if (!node) {
		return { type: { girType: 'none', cType: 'void', isArray: false }, transfer: 'none', nullable: false };
	}
	return {
		type: parseTypeRef(node),
		transfer: parseTransfer(node),
		nullable: boolAttr(node, 'nullable'),
	};
}

interface FuncKind {
	isMethod?: boolean;
	isConstructor?: boolean;
	isStatic?: boolean;
}

function parseFunction(node: Node, kind: FuncKind): Func | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;

	const params: Parameter[] = [];
	const container = child(node, 'parameters');
	if (container) {
		const instance = child(container, 'instance-parameter');
		if (kind.isMethod && !kind.isStatic && instance) {
			params.push(parseParameter(instance, true));
		}
		for (const p of children(container, 'parameter')) {
			params.push(parseParameter(p, false));
		}
	}

	return {
		name,
		cName: attr(node, 'c:identifier') ?? name,
		parameters: params,
		returnValue: parseReturnValue(child(node, 'return-value')),
		isMethod: kind.isMethod ?? false,
		isConstructor: kind.isConstructor ?? false,
		isStatic: kind.isStatic ?? false,
		throws: boolAttr(node, 'throws'),
		introspectable: boolAttr(node, 'introspectable', true),
		shadows: attr(node, 'shadows'),
		finishName: attr(node, 'glib:finish-func'),
	};
}

function parseCallback(node: Node, nsPrefix: string): Callback | undefined {
	const func = parseFunction(node, {});
	if (!func) return undefined;
	return {
		name: func.name,
		cName: attr(node, 'c:type') ?? nsPrefix + func.name,
		parameters: func.parameters,
		returnValue: func.returnValue,
		throws: func.throws,
	};
}

function parseProperty(node: Node): Property | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;
	return {
		name,
		type: parseTypeRef(node),
		readable: boolAttr(node, 'readable', true),
		writable: boolAttr(node, 'writable'),
		construct: boolAttr(node, 'construct'),
		constructOnly: boolAttr(node, 'construct-only'),
		transfer: parseTransfer(node),
		getter: attr(node, 'getter'),
		setter: attr(node, 'setter'),
	};
}

function parseSignal(node: Node): Signal | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;
	return {
		name,
		parameters: children(child(node, 'parameters'), 'parameter').map(p => parseParameter(p, false)),
		returnValue: parseReturnValue(child(node, 'return-value')),
	};
}

function parseField(node: Node): Field | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;
	return {
		name,
		type: parseTypeRef(node),
		readable: boolAttr(node, 'readable', true),
		writable: boolAttr(node, 'writable'),
		hidden: boolAttr(node, 'private') || attr(node, 'bits') !== undefined || !!child(node, 'callback'),
	};
}

/** Constructors, methods and static functions shared by classes and records. */
function parseMembers(node: Node): Pick<Class, 'constructors' | 'methods' | 'staticMethods'> {
	return {
		constructors: children(node, CONSTRUCTOR_TAG)
			.map(c => parseFunction(c, { isConstructor: true }))
			.filter((f): f is Func => !!f),
		methods: children(node, 'method')
			.map(m => parseFunction(m, { isMethod: true }))
			.filter((f): f is Func => !!f),
		staticMethods: children(node, 'function')
			.map(m => parseFunction(m, { isMethod: true, isStatic: true }))
			.filter((f): f is Func => !!f),
	};
}

function parseRecord(node: Node, nsPrefix: string): Struct | undefined {
	const info = parseTypeInfo(node, nsPrefix);
	if (!info) return undefined;
	return {
		...info,
		...parseMembers(node),
		fields: children(node, 'field')
			.map(parseField)
			.filter((f): f is Field => !!f),
		isGTypeStruct: attr(node, 'glib:is-gtype-struct-for') !== undefined,
		isOpaque: boolAttr(node, 'disguised') || boolAttr(node, 'opaque'),
	};
}

function parseTypeInfo(node: Node, nsPrefix: string): TypeInfo | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;
	return {
		name,
		cName: attr(node, 'c:type') ?? nsPrefix + name,
		typeName: attr(node, 'glib:type-name'),
		getType: attr(node, 'glib:get-type'),
	};
}

function parseClass(node: Node, nsPrefix: string, namespace: string): Class | undefined {
	const info = parseTypeInfo(node, nsPrefix);
	if (!info) return undefined;

	const parent = attr(node, 'parent');
	return {
		...info,
		parent: parent ? qualify(parent, namespace) : undefined,
		fundamental: boolAttr(node, 'glib:fundamental'),
		abstract: boolAttr(node, 'abstract'),
		...parseMembers(node),
		properties: children(node, 'property')
			.map(parseProperty)
			.filter((p): p is Property => !!p),
		signals: children(node, 'glib:signal')
			.map(parseSignal)
			.filter((s): s is Signal => !!s),
		implements: children(node, 'implements')
			.map(implemented => attr(implemented, 'name'))
			.filter((name): name is string => !!name)
			.map(name => qualify(name, namespace)),
		virtualMethods: children(node, 'virtual-method')
			.map(method => parseFunction(method, { isMethod: true }))
			.filter((f): f is Func => !!f),
		typeStruct: attr(node, 'glib:type-struct'),
	};
}

function parseEnumeration(node: Node, isBitfield: boolean): Enumeration | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;
	const members: EnumMember[] = [];
	for (const m of children(node, 'member')) {
		const memberName = attr(m, 'name');
		if (!memberName) continue;
		members.push({
			name: memberName,
			cName: attr(m, 'c:identifier') ?? '',
			value: attr(m, 'value') ?? '',
		});
	}
	return { name, cName: attr(node, 'c:type') ?? name, isBitfield, members };
}

/** Parse GIR XML text into the {@link Namespace} IR. */
export function parseGir(xml: string): Namespace {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: ATTR,
		removeNSPrefix: false,
		transformTagName: tagName => (tagName === 'constructor' ? CONSTRUCTOR_TAG : tagName),
		isArray: tagName => ARRAY_ELEMENTS.has(tagName),
	});

	const root = parser.parse(xml) as Node;
	const repository = child(root, 'repository');
	const nsNode = child(repository, 'namespace');
	if (!nsNode) throw new Error('GIR file has no <namespace>');

	const name = attr(nsNode, 'name') ?? '';
	// `c:identifier-prefixes` (e.g. `Flatpak`) is what class c:type names are
	// built from when a class omits its own c:type.
	const identifierPrefixes = splitPrefixes(attr(nsNode, 'c:identifier-prefixes'));
	const nsPrefix = identifierPrefixes[0] ?? name;

	const classes: Class[] = [];
	for (const c of children(nsNode, 'class')) {
		const cls = parseClass(c, nsPrefix, name);
		if (cls) classes.push(cls);
	}

	const typeInfos = (key: string) =>
		children(nsNode, key)
			.map(node => parseTypeInfo(node, nsPrefix))
			.filter((info): info is TypeInfo => !!info);

	// Standalone functions; dedup by C symbol (GIR repeats some).
	const functions: Func[] = [];
	const seen = new Set<string>();
	for (const f of children(nsNode, 'function')) {
		const func = parseFunction(f, {});
		if (func && !seen.has(func.cName)) {
			functions.push(func);
			seen.add(func.cName);
		}
	}

	const enumerations: Enumeration[] = [];
	for (const e of children(nsNode, 'enumeration')) {
		const parsed = parseEnumeration(e, false);
		if (parsed) enumerations.push(parsed);
	}
	for (const b of children(nsNode, 'bitfield')) {
		const parsed = parseEnumeration(b, true);
		if (parsed) enumerations.push(parsed);
	}

	const includes: Include[] = children(repository, 'include').map(node => ({
		name: attr(node, 'name') ?? '',
		version: attr(node, 'version') ?? '',
	}));

	return {
		name,
		version: attr(nsNode, 'version') ?? '',
		includes,
		sharedLibraries: splitPrefixes(attr(nsNode, 'shared-library')),
		identifierPrefixes,
		symbolPrefixes: splitPrefixes(attr(nsNode, 'c:symbol-prefixes')),
		classes,
		interfaces: children(nsNode, 'interface')
			.map((node): Interface | undefined => {
				const info = parseTypeInfo(node, nsPrefix);
				if (!info) return undefined;
				return {
					...info,
					prerequisites: children(node, 'prerequisite')
						.map(prerequisite => attr(prerequisite, 'name'))
						.filter((prerequisite): prerequisite is string => !!prerequisite)
						.map(prerequisite => qualify(prerequisite, name)),
					...parseMembers(node),
					properties: children(node, 'property')
						.map(parseProperty)
						.filter((p): p is Property => !!p),
					signals: children(node, 'glib:signal')
						.map(parseSignal)
						.filter((s): s is Signal => !!s),
				};
			})
			.filter((iface): iface is Interface => !!iface),
		records: children(nsNode, 'record')
			.map(node => parseRecord(node, nsPrefix))
			.filter((record): record is Struct => !!record),
		unions: typeInfos('union'),
		callbacks: children(nsNode, 'callback')
			.map(node => parseCallback(node, nsPrefix))
			.filter((callback): callback is Callback => !!callback),
		functions,
		enumerations,
	};
}

/** Read and parse a `.gir` file from disk. */
export function parseGirFile(path: string): Namespace {
	return parseGir(readFileSync(path, 'utf8'));
}

/** Parsed namespaces by name: a GIR file plus everything it transitively includes. */
export type Repository = Map<string, Namespace>;

function girSearchPath(girPath: string): string[] {
	const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
	return [dirname(girPath), ...dataDirs.map(dir => join(dir, 'gir-1.0'))];
}

/** Parse a GIR file and the GIRs it includes, skipping includes that cannot be found. */
export function loadRepository(girPath: string, parsed?: Namespace): Repository {
	const main = parsed ?? parseGirFile(girPath);
	const repository: Repository = new Map([[main.name, main]]);
	const searchPath = girSearchPath(girPath);
	const pending = [...main.includes];

	for (let include = pending.pop(); include; include = pending.pop()) {
		if (repository.has(include.name)) continue;
		const file = `${include.name}-${include.version}.gir`;
		const path = searchPath.map(dir => join(dir, file)).find(candidate => existsSync(candidate));
		if (!path) continue;
		const ns = parseGirFile(path);
		repository.set(ns.name, ns);
		pending.push(...ns.includes);
	}
	annotateParameters(repository);
	return repository;
}

/** Whether a C type names plain data: no pointers, no callbacks. */
function isPointerFree(cType: string): boolean {
	return !cType.includes('*') && !['gpointer', 'gconstpointer'].includes(cType.trim());
}

/** Decide each record's binding, which can depend on records from other namespaces. */
function bindRecords(repository: Repository, callbacks: Set<string>): void {
	const records = new Map<string, Struct>();
	for (const ns of repository.values())
		for (const record of ns.records) records.set(`${ns.name}.${record.name}`, record);

	const plainData = new Map<Struct, boolean>();
	const isPlainData = (record: Struct, namespace: string): boolean => {
		const known = plainData.get(record);
		if (known !== undefined) return known;
		plainData.set(record, false);
		const result =
			!record.isOpaque
			&& record.fields.length > 0
			&& record.fields.every(field => {
				const typeName = qualify(
					field.type.isArray ? (field.type.elementType ?? '') : field.type.girType,
					namespace
				);
				if (callbacks.has(typeName) || field.type.girType === 'none') return false;
				if (field.type.cType && !isPointerFree(field.type.cType)) return false;
				const nested = records.get(typeName);
				if (nested) return isPlainData(nested, typeName.slice(0, typeName.lastIndexOf('.')));
				return !!field.type.cType || field.type.isArray;
			});
		plainData.set(record, result);
		return result;
	};

	for (const ns of repository.values()) {
		for (const record of ns.records) {
			if (record.isGTypeStruct) continue;
			if (record.getType) record.binding = 'boxed';
			else if (isPlainData(record, ns.name)) record.binding = 'plain';
		}
	}
}

/** Constructors, methods and static functions, grouped by the type (or namespace) declaring them. */
function functionGroups(ns: Namespace): Func[][] {
	return [
		ns.functions,
		...[...ns.classes, ...ns.interfaces, ...ns.records].map(owner => [
			...owner.constructors,
			...owner.methods,
			...owner.staticMethods,
		]),
	];
}

/** The index of a callback type's user data parameter, if it has one. */
export function callbackData(callback: Callback): number | undefined {
	const index = callback.parameters.findIndex(p => p.closure !== undefined);
	if (index !== -1) return index;
	const last = callback.parameters.at(-1);
	return last?.type.girType === 'gpointer' ? callback.parameters.length - 1 : undefined;
}

/** Indices of parameters holding the length of an array parameter or return value. */
export function lengthIndices(parameters: Parameter[], returnValue?: ReturnValue): Set<number> {
	const types = [...parameters.map(p => p.type), ...(returnValue ? [returnValue.type] : [])];
	return new Set(types.flatMap(type => (type.isArray && type.length !== undefined ? [type.length] : [])));
}

/** Whether JS functions can be passed for a callback type: girbind converts its arguments and result. */
function isBindable(ctx: TypeContext, callback: Callback): boolean {
	const data = callbackData(callback);
	if (callback.throws || data === undefined) return false;
	const lengths = lengthIndices(callback.parameters);
	return (
		callback.parameters.every(
			(p, i) => i === data || lengths.has(i) || (p.direction === 'in' && ctx.convertsToJs(p.type))
		) && ctx.convertsResult(callback.returnValue.type, callback.returnValue.transfer)
	);
}

/** Flag arrays girbind cannot convert, and hide the length parameters of those it can. */
function annotateArrays(ctx: TypeContext, func: Func): void {
	const parameters = func.parameters.filter(p => !p.isInstance);
	const arrays = [
		...parameters.map(p => ({ holder: p, direction: p.direction })),
		{ holder: func.returnValue, direction: 'out' as Direction },
	];
	for (const { holder, direction } of arrays) {
		const { type } = holder;
		if (!type.isArray) continue;
		const owned = holder.transfer !== 'none' && ctx.arrayKind(type) !== 'strv';
		const length = type.length === undefined ? undefined : parameters[type.length];
		if (
			direction === 'inout'
			|| !ctx.convertsArray(type, direction)
			|| (direction === 'in' && owned)
			|| length?.direction === 'inout'
		) {
			holder.isOpaqueArray = true;
			continue;
		}
		if (length && (direction === 'in' || length.direction === 'out')) length.isHidden = true;
	}
}

/** Mark callback parameters girbind can pass JS functions for, hiding their user data and destroy notify. */
function annotateCallbacks(callbacks: Map<string, Callback>, namespace: string, func: Func): void {
	const parameters = func.parameters.filter(p => !p.isInstance);
	for (const [i, p] of parameters.entries()) {
		if (!p.isCallback || p.direction !== 'in') continue;
		const found = parameters.findIndex(other => other.closure === i);
		const data = p.closure ?? (found === -1 ? undefined : found);
		if (!callbacks.get(qualify(p.type.girType, namespace))?.isBindable || data === undefined || data === i)
			continue;
		const shared = parameters.some((other, j) => j !== i && other.isCallback && other.closure === data);
		if (shared || parameters[data].direction !== 'in') continue;
		p.isBindableCallback = true;
		parameters[data].isHidden = true;
		if (p.destroy !== undefined) parameters[p.destroy].isHidden = true;
	}
}

/** Replace a function by one shadowing it, if girbind can bind that one. */
function annotateShadows(func: Func, group: Func[]): void {
	if (!func.shadows || !isSupported(func)) return;
	const shadowed = group.find(candidate => candidate.name === func.shadows);
	if (shadowed) shadowed.isShadowed = true;
}

/** Pair an asynchronous function with the function completing it, so it is bound as a promise. */
function annotateAsync(namespace: string, func: Func, group: Func[]): void {
	const ready = func.parameters.find(
		p => p.isBindableCallback && qualify(p.type.girType, namespace) === 'Gio.AsyncReadyCallback'
	);
	if (!ready) return;
	const name = func.finishName ?? (func.name.endsWith('_async') ? func.name.slice(0, -6) : func.name) + '_finish';
	const finish = group.find(candidate => candidate.name === name);
	if (!finish || !isSupported(finish)) return;
	const inputs = finish.parameters.filter(
		p => !p.isInstance && p.direction !== 'out' && p.type.cType.replace(/\s/g, '') !== 'GError**'
	);
	if (inputs.length !== 1 || qualify(inputs[0].type.girType, namespace) !== 'Gio.AsyncResult') return;
	func.finish = finish;
}

/**
 * Callback arguments the GIR types as `gpointer` that are objects wherever the
 * namespaces girbind binds pass them, such as the items `Gtk.CustomSorter` and
 * `Gio.ListStore` compare.
 */
const objectArguments: Record<string, string[]> = { 'GLib.CompareDataFunc': ['a', 'b'] };

/** Flag parameters whose handling depends on types from other namespaces in the repository. */
function annotateParameters(repository: Repository): void {
	const callbacks = new Map<string, Callback>();
	const records = new Map<string, Struct>();
	const enumerations = new Set<string>();
	for (const ns of repository.values()) {
		for (const callback of ns.callbacks) callbacks.set(`${ns.name}.${callback.name}`, callback);
		for (const record of ns.records) records.set(`${ns.name}.${record.name}`, record);
		for (const enumeration of ns.enumerations) enumerations.add(`${ns.name}.${enumeration.name}`);
	}
	bindRecords(repository, new Set(callbacks.keys()));
	for (const [qualified, names] of Object.entries(objectArguments)) {
		for (const p of callbacks.get(qualified)?.parameters ?? []) {
			if (names.includes(p.name)) p.type = { ...p.type, girType: 'GObject.Object' };
		}
	}

	for (const ns of repository.values()) {
		const ctx = new TypeContext(ns, repository);
		const functions = functionGroups(ns).flat();
		for (const func of functions) {
			if (callbacks.has(qualify(func.returnValue.type.girType, ns.name))) func.returnValue.isCallback = true;
			annotateArrays(ctx, func);
		}
		for (const parameter of functions.flatMap(func => func.parameters)) {
			const qualified = qualify(parameter.type.girType, ns.name);
			if (callbacks.has(qualified)) parameter.isCallback = true;
			if (parameter.direction === 'inout') {
				const scalar =
					!parameter.type.isArray
					&& (SCALAR_GIR_TYPES.has(parameter.type.girType) || enumerations.has(qualified))
					&& (parameter.type.cType.match(/\*/g) ?? []).length === 1;
				if (!scalar) parameter.isComplexInout = true;
				continue;
			}
			const record = records.get(qualified);
			if (parameter.direction === 'in' || !record || /\*\s*\*/.test(parameter.type.cType)) continue;
			if (record.binding && !record.isOpaque && record.fields.length) parameter.fillsRecord = true;
			else parameter.isRecordOut = true;
		}
		for (const callback of ns.callbacks) callback.isBindable = isBindable(ctx, callback);
	}

	for (const ns of repository.values()) {
		for (const func of functionGroups(ns).flat()) annotateCallbacks(callbacks, ns.name, func);
	}
	for (const ns of repository.values()) {
		for (const group of functionGroups(ns)) for (const func of group) annotateShadows(func, group);
	}
	for (const ns of repository.values()) {
		for (const group of functionGroups(ns)) for (const func of group) annotateAsync(ns.name, func, group);
	}
}
