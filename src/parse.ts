/**
 * GIR (GObject Introspection) XML parser.
 *
 * Parses a `.gir` file into the namespace-agnostic {@link Namespace} IR defined
 * in {@link ./model}. Uses `fast-xml-parser` with namespace prefixes preserved
 * (`c:type`, `c:identifier`, `glib:type-name`) since those carry the C symbols
 * the bindings target.
 */

import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type {
	Class,
	Direction,
	EnumMember,
	Enumeration,
	Func,
	Namespace,
	Parameter,
	Property,
	ReturnValue,
	Transfer,
	TypeRef,
} from './ir.js';

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

/** Strip a namespace prefix from a qualified name (`Flatpak.Ref` → `Ref`). */
function stripNamespace(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? name : name.slice(dot + 1);
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
		return {
			girType: attr(arrayElem, 'name') ?? '',
			cType: attr(arrayElem, 'c:type') ?? '',
			isArray: true,
			elementType: inner ? (attr(inner, 'name') ?? '') : '',
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
	};
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

function parseClass(node: Node, nsPrefix: string): Class | undefined {
	const name = attr(node, 'name');
	if (!name) return undefined;

	const parent = attr(node, 'parent');
	return {
		name,
		cName: attr(node, 'c:type') ?? nsPrefix + name,
		parent: parent ? stripNamespace(parent) : undefined,
		constructors: children(node, CONSTRUCTOR_TAG)
			.map(c => parseFunction(c, { isConstructor: true }))
			.filter((f): f is Func => !!f),
		methods: children(node, 'method')
			.map(m => parseFunction(m, { isMethod: true }))
			.filter((f): f is Func => !!f),
		staticMethods: children(node, 'static-method')
			.map(m => parseFunction(m, { isMethod: true, isStatic: true }))
			.filter((f): f is Func => !!f),
		properties: children(node, 'property')
			.map(parseProperty)
			.filter((p): p is Property => !!p),
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
		const cls = parseClass(c, nsPrefix);
		if (cls) classes.push(cls);
	}

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

	return {
		name,
		version: attr(nsNode, 'version') ?? '',
		sharedLibraries: splitPrefixes(attr(nsNode, 'shared-library')),
		identifierPrefixes,
		symbolPrefixes: splitPrefixes(attr(nsNode, 'c:symbol-prefixes')),
		classes,
		functions,
		enumerations,
	};
}

/** Read and parse a `.gir` file from disk. */
export function parseGirFile(path: string): Namespace {
	return parseGir(readFileSync(path, 'utf8'));
}
