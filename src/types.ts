/**
 * Type classification and mapping shared by the emitters.
 *
 * GIR types fall into a few buckets that each emitter handles differently:
 * primitives, enums/bitfields, object types (GObject classes and interfaces from
 * any loaded namespace, which the runtime wraps), and "foreign" types
 * (everything else — boxed records, fundamental types, unknown namespaces).
 */

import type {
	Callback,
	Class,
	Enumeration,
	Interface,
	Namespace,
	RecordBinding,
	Struct,
	Transfer,
	TypeInfo,
	TypeRef,
} from './ir.js';
import type { Repository } from './parse.js';
import girToCxx from './types/cxx.json' with { type: 'json' };
import girToTs from './types/ts.json' with { type: 'json' };

const cxxTable: Record<string, string> = girToCxx;
const tsTable: Record<string, string> = girToTs;

/** Qualify the type names in a type from `namespace`'s GIR so they resolve from any namespace. */
export function qualifyType(type: TypeRef, namespace: string): TypeRef {
	const qualify = (name: string) =>
		/^[A-Z]/.test(name) && !name.includes('.') && !(name in cxxTable) ? `${namespace}.${name}` : name;
	return {
		...type,
		girType: qualify(type.girType),
		elementType: type.elementType && qualify(type.elementType),
	};
}

/** Strip a namespace prefix from a qualified GIR name (`Flatpak.Ref` → `Ref`). */
export function shortName(girType: string): string {
	const dot = girType.lastIndexOf('.');
	return dot === -1 ? girType : girType.slice(dot + 1);
}

/** GType names of the classes the runtime defines itself, by qualified GIR name. */
const runtimeClasses: Record<string, string> = {
	'GObject.Object': 'GObject',
	'GObject.InitiallyUnowned': 'GInitiallyUnowned',
};

/** How the elements of a C array convert: bytes become a `Uint8Array`, the rest a JS array. */
export type ArrayElement = 'bytes' | 'number' | 'boolean' | 'string' | 'object' | 'record';

/** A record from any loaded namespace that girbind can hold. */
export interface RecordType {
	namespace: string;
	record: Struct;
	/** Qualified GIR name, e.g. `Graphene.Rect`. */
	qualified: string;
	binding: RecordBinding;
}

/** The nearest ancestor (or the class itself) that exists at runtime. */
export interface BoundClass {
	/** Qualified GIR name, e.g. `Gtk.Widget`. */
	qualified: string;
	/** Registered GType name, e.g. `GtkWidget`. */
	typeName: string;
	/** Where the class is defined: by the runtime, this namespace, or another bound namespace. */
	source: 'runtime' | 'local' | 'imported';
}

/** A GObject class or interface from any loaded namespace. */
export interface ObjectType {
	namespace: string;
	info: TypeInfo;
	/** Qualified GIR name, e.g. `Gdk.Paintable`. */
	qualified: string;
	isInterface: boolean;
}

/**
 * Index of the namespace being generated and the namespaces it includes, with
 * predicates the emitters use to classify types. Built once per generation.
 */
export class TypeContext {
	readonly classes = new Map<string, Class>();
	readonly enums = new Map<string, Enumeration>();
	readonly repository: Repository;
	/** `get_type` functions the generated code calls, which it declares itself. */
	readonly typeFunctions = new Set<string>();
	/** Qualified names of the callback types the generated code calls JS through. */
	readonly callbacks = new Set<string>();
	/** Whether the generated code converts AbortSignals to cancellables. */
	usesAbortSignals = false;

	/**
	 * @param modules import specifiers of other bound namespaces, by namespace name
	 */
	constructor(
		readonly ns: Namespace,
		repository?: Repository,
		readonly modules: Record<string, string> = {}
	) {
		this.repository = repository ?? new Map([[ns.name, ns]]);
		for (const c of ns.classes) this.classes.set(c.name, c);
		for (const e of ns.enumerations) this.enums.set(e.name, e);
	}

	/** Qualify a GIR type name with this namespace when it has no namespace of its own. */
	qualify(girType: string): string {
		return girType.includes('.') ? girType : `${this.ns.name}.${girType}`;
	}

	private split(girType: string): [Namespace | undefined, string] {
		const qualified = this.qualify(girType);
		const dot = qualified.lastIndexOf('.');
		return [this.repository.get(qualified.slice(0, dot)), qualified.slice(dot + 1)];
	}

	/** An interface from any loaded namespace. */
	anyInterface(girType: string): Interface | undefined {
		const [namespace, name] = this.split(girType);
		return namespace?.interfaces.find(i => i.name === name);
	}

	/** A callback type from any loaded namespace. */
	anyCallback(girType: string): Callback | undefined {
		const [namespace, name] = this.split(girType);
		return namespace?.callbacks.find(c => c.name === name);
	}

	/** A class from any loaded namespace. */
	anyClass(girType: string): Class | undefined {
		const [namespace, name] = this.split(girType);
		return namespace?.classes.find(c => c.name === name);
	}

	/** Whether a class derives from `GObject.Object` (fundamental types such as `Gsk.RenderNode` do not). */
	isGObjectClass(cls: Class, namespace: string = this.ns.name): boolean {
		let current: Class | undefined = cls;
		let qualified = `${namespace}.${cls.name}`;
		while (current) {
			if (qualified === 'GObject.Object') return true;
			if (current.fundamental || !current.parent) return false;
			qualified = current.parent;
			current = this.anyClass(qualified);
		}
		return false;
	}

	/** The GObject class or interface named by a GIR type, from any loaded namespace. */
	objectType(girType: string): ObjectType | undefined {
		if (!girType || !/^[A-Za-z_]/.test(girType) || cxxTable[girType] !== undefined) return undefined;
		const [namespace, name] = this.split(girType);
		if (!namespace) return undefined;
		const qualified = `${namespace.name}.${name}`;
		const cls = namespace.classes.find(c => c.name === name);
		if (cls) {
			if (!this.isGObjectClass(cls, namespace.name)) return undefined;
			return { namespace: namespace.name, info: cls, qualified, isInterface: false };
		}
		const iface = namespace.interfaces.find(i => i.name === name);
		if (iface) return { namespace: namespace.name, info: iface, qualified, isInterface: true };
		return undefined;
	}

	/** The record named by a GIR type, from any loaded namespace, if girbind can hold it. */
	recordType(girType: string): RecordType | undefined {
		if (!girType || !/^[A-Za-z_]/.test(girType) || cxxTable[girType] !== undefined) return undefined;
		const [namespace, name] = this.split(girType);
		const record = namespace?.records.find(r => r.name === name);
		if (!namespace || !record?.binding) return undefined;
		return { namespace: namespace.name, record, qualified: `${namespace.name}.${name}`, binding: record.binding };
	}

	/** C++ expression evaluating to the GType a record's handles carry. */
	recordGType(type: RecordType): string {
		if (type.binding === 'plain') return `girbind::plain_type("${type.record.cName}")`;
		this.typeFunctions.add(type.record.getType!);
		return `${type.record.getType}()`;
	}

	/** Whether an object type is declared in the namespace being generated. */
	isOurs(type: ObjectType): boolean {
		return type.namespace === this.ns.name;
	}

	/** The registered GType name of an object type. */
	typeName(type: ObjectType): string {
		return type.info.typeName ?? type.info.cName;
	}

	/** C++ expression evaluating to an object type's GType, or 0 while it is unregistered. */
	gtypeExpression(type: ObjectType): string {
		return `girbind::type_named("${this.typeName(type)}")`;
	}

	/** The class declared in this namespace for a GIR type, if it is a GObject class. */
	ourClass(girType: string): Class | undefined {
		const type = this.objectType(girType);
		if (!type || type.isInterface || !this.isOurs(type)) return undefined;
		return this.classes.get(type.info.name);
	}

	/** The enum/bitfield for a GIR type, from any loaded namespace. */
	enumeration(girType: string): Enumeration | undefined {
		if (!girType) return undefined;
		const [namespace, name] = this.split(girType);
		return namespace?.enumerations.find(e => e.name === name);
	}

	/**
	 * A scalar value type that maps to a JS number (ints, floats, enums-by-width).
	 * Excludes strings (handled separately) and pointer/boxed `GLib.*` entries
	 * such as `GLib.Bytes`/`GLib.Variant`, which need dedicated conversion.
	 */
	isPrimitive(girType: string): boolean {
		const c = cxxTable[girType];
		if (c === undefined) return false;
		if (girType === 'utf8' || girType === 'filename' || girType === 'none') return false;
		return !c.includes('*');
	}

	/** Map a GIR type to its C type, preferring the explicit `c:type`. */
	cType(type: TypeRef): string {
		if (type.cType) return type.cType;
		return cxxTable[type.girType] ?? 'void*';
	}

	/**
	 * The pointed-to C base type for a pointer type, with `const` and the
	 * trailing `*` stripped. Falls back to deriving a name from the GIR namespace
	 * when no `c:type` is present (`Gio.File` → `GFile`).
	 */
	cBaseType(type: TypeRef): string {
		const ct = this.cType(type)
			.replace(/\*+$/, '')
			.replace(/^const\s+/, '')
			.trim();
		if (ct && ct !== 'void') return ct;
		const dot = type.girType.indexOf('.');
		if (dot !== -1) {
			return 'G' + type.girType.slice(dot + 1);
		}
		return type.girType || 'void';
	}

	/**
	 * Classify an array `<type>` for conversion. `strv` is a NULL-terminated
	 * `char**`; `ptrArray` is a `GPtrArray*`; `cArray` is a plain C array with a
	 * known element type; `unknown` otherwise.
	 */
	arrayKind(type: TypeRef): 'strv' | 'ptrArray' | 'cArray' | 'unknown' {
		const strings = type.elementType === 'utf8' || type.elementType === 'filename';
		if (type.girType === 'GLib.Strv' || (strings && type.length === undefined && type.fixedSize === undefined)) {
			return 'strv';
		}
		if (type.girType === 'GLib.PtrArray' || /GPtrArray/.test(type.cType)) return 'ptrArray';
		if (type.elementType && !type.girType) return 'cArray';
		return 'unknown';
	}

	/** How the elements of a C array convert, or undefined when girbind cannot convert them. */
	arrayElement(type: TypeRef): ArrayElement | undefined {
		const element = type.elementType ?? '';
		if (element === 'guint8' || element === 'gint8') return 'bytes';
		if (element === 'utf8' || element === 'filename') return 'string';
		if (element === 'gboolean') return 'boolean';
		if (this.enumeration(element) || this.isPrimitive(element)) return 'number';
		if (this.objectType(element)) return 'object';
		if (this.recordType(element)) return 'record';
		return undefined;
	}

	/**
	 * The type of a C array's elements, with a C type derived from the array's
	 * when the GIR omits it. Records are stored inline unless the array's C type
	 * points to pointers, whatever the element's C type says.
	 */
	arrayElementType(type: TypeRef): TypeRef {
		const girType = type.elementType ?? '';
		const element = { girType, cType: type.elementCType ?? '', isArray: false };
		const record = this.recordType(girType);
		if (record) {
			element.cType = record.record.cName + (/\*\s*\*/.test(type.cType) ? '*' : '');
			return element;
		}
		if (element.cType) return element;
		const object = this.objectType(girType);
		const enumeration = this.enumeration(girType);
		if (object) element.cType = `${object.info.cName}*`;
		else if (enumeration) element.cType = enumeration.cName;
		else if (girType === 'utf8' || girType === 'filename') element.cType = 'char*';
		else element.cType = this.cType(element);
		return element;
	}

	/** Whether girbind converts an array passed in `direction`. */
	convertsArray(type: TypeRef, direction: 'in' | 'out'): boolean {
		const kind = this.arrayKind(type);
		if (kind === 'strv') return true;
		if (kind === 'ptrArray') return direction === 'out';
		const element = kind === 'cArray' ? this.arrayElement(type) : undefined;
		if (!element) return false;
		if (type.length !== undefined || type.fixedSize !== undefined) return true;
		return !!type.zeroTerminated && element !== 'record';
	}

	/** Whether girbind converts a C value of this type to JS. */
	convertsToJs(type: TypeRef): boolean {
		if (type.isArray) return this.convertsArray(type, 'out');
		const t = type.girType;
		if (t === 'utf8' || t === 'filename' || t === 'GLib.Bytes') return true;
		if (t === 'gboolean' || this.enumeration(t) || this.isPrimitive(t)) return !type.cType.includes('*');
		return !!this.recordType(t) || !!this.objectType(t);
	}

	/** Whether girbind converts a JS value to a C return value of this type, which the caller owns per `transfer`. */
	convertsResult(type: TypeRef, transfer: Transfer): boolean {
		if (type.isArray) return false;
		const t = type.girType;
		if (t === 'none' || t === 'gboolean' || this.enumeration(t) || this.isPrimitive(t))
			return !type.cType.includes('*');
		if (t === 'utf8' || t === 'filename' || this.recordType(t)) return transfer === 'full';
		return !!this.objectType(t);
	}

	/** Namespaces with an import specifier, other than this one, that this namespace can see. */
	importedNamespaces(): string[] {
		return [...this.repository.keys()].filter(name => name !== this.ns.name && name in this.modules);
	}

	/** The class or nearest ancestor of a class that is defined at runtime, falling back to `GObject.Object`. */
	boundClass(qualified: string): BoundClass {
		let current: string | undefined = qualified;
		while (current) {
			if (runtimeClasses[current])
				return { qualified: current, typeName: runtimeClasses[current], source: 'runtime' };
			const [namespace, name] = this.split(current);
			const cls = namespace?.classes.find(c => c.name === name);
			const typeName = cls?.typeName ?? cls?.cName ?? '';
			if (namespace?.name === this.ns.name) return { qualified: current, typeName, source: 'local' };
			if (namespace && namespace.name in this.modules)
				return { qualified: current, typeName, source: 'imported' };
			current = cls?.parent;
		}
		return { qualified: 'GObject.Object', typeName: 'GObject', source: 'runtime' };
	}

	/** The parent of a class that is defined at runtime. */
	boundParent(cls: Class): BoundClass {
		return this.boundClass(cls.parent ?? 'GObject.Object');
	}

	/** The TypeScript expression naming a class or its nearest ancestor defined at runtime. */
	classReference(qualified: string): string {
		const bound = this.boundClass(qualified);
		return bound.source === 'local' ? shortName(bound.qualified) : bound.qualified;
	}

	/** The TypeScript expression naming an interface, if it is defined at runtime. */
	interfaceReference(qualified: string): string | undefined {
		const [namespace, name] = this.split(qualified);
		if (!namespace?.interfaces.some(iface => iface.name === name && iface.typeName)) return undefined;
		if (namespace.name === this.ns.name) return name;
		return namespace.name in this.modules ? `${namespace.name}.${name}` : undefined;
	}

	/** Map a GIR type to its TypeScript type. */
	tsType(type: TypeRef): string {
		if (type.isArray && this.arrayKind(type) === 'cArray' && this.arrayElement(type) === 'bytes')
			return 'Uint8Array';
		if (type.isArray) {
			const elem = type.elementType ?? '';
			if (elem === 'utf8' || elem === 'filename') return 'string[]';
			return `${this.tsScalar(elem)}[]`;
		}
		return this.tsScalar(type.girType);
	}

	private tsScalar(girType: string): string {
		const enumeration = this.enumeration(girType);
		if (enumeration) {
			const [namespace] = this.split(girType);
			if (namespace?.name === this.ns.name) return enumeration.name;
			return namespace && namespace.name in this.modules ? `${namespace.name}.${enumeration.name}` : 'number';
		}
		const object = this.objectType(girType);
		if (object) {
			if (!object.isInterface) return this.classReference(object.qualified);
			return this.interfaceReference(object.qualified) ?? 'GObject.Object';
		}
		const record = this.recordType(girType);
		if (record) {
			if (record.namespace === this.ns.name) return record.record.name;
			return record.namespace in this.modules ? record.qualified : 'GObject.Boxed';
		}
		if (girType === 'GLib.Strv') return 'string[]';
		if (girType === 'GLib.Bytes') return 'Uint8Array';
		const mapped = tsTable[girType];
		if (mapped === 'External') return 'unknown';
		return mapped ?? 'unknown';
	}
}
