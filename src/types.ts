/**
 * Type classification and mapping shared by the emitters.
 *
 * GIR types fall into a few buckets that each emitter handles differently:
 * primitives, enums/bitfields, "our" classes (GObject classes declared in this
 * namespace, which become wrapper classes), and "foreign" types (everything
 * else — other namespaces' GObjects, boxed types, etc.).
 */

import type { Class, Enumeration, Namespace, TypeRef } from './ir.js';
import girToCxx from './types/cxx.json' with { type: 'json' };
import girToTs from './types/ts.json' with { type: 'json' };

const cxxTable: Record<string, string> = girToCxx;
const tsTable: Record<string, string> = girToTs;

/** Strip a namespace prefix from a qualified GIR name (`Flatpak.Ref` → `Ref`). */
export function shortName(girType: string): string {
	const dot = girType.lastIndexOf('.');
	return dot === -1 ? girType : girType.slice(dot + 1);
}

/**
 * Index of a namespace's classes and enums, with predicates the emitters use to
 * classify types. Built once per generation.
 */
export class TypeContext {
	readonly classes = new Map<string, Class>();
	readonly enums = new Map<string, Enumeration>();

	constructor(readonly ns: Namespace) {
		for (const c of ns.classes) this.classes.set(c.name, c);
		for (const e of ns.enumerations) this.enums.set(e.name, e);
	}

	/** The wrapper class for a GIR type, if it is one of ours; else undefined. */
	ourClass(girType: string): Class | undefined {
		if (!girType) return undefined;
		return this.classes.get(shortName(girType));
	}

	/** The enum/bitfield for a GIR type, if it is one declared in this namespace. */
	enumeration(girType: string): Enumeration | undefined {
		if (!girType) return undefined;
		return this.enums.get(shortName(girType));
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
	 * The pointed-to C base type for a (foreign) pointer type, with the trailing
	 * `*` stripped. Used for `Napi::External<T>`. Falls back to deriving a name
	 * from the GIR namespace when no `c:type` is present (`Gio.File` → `GFile`).
	 */
	cBaseType(type: TypeRef): string {
		const ct = this.cType(type).replace(/\*+$/, '').trim();
		if (ct && ct !== 'void') return ct;
		const dot = type.girType.indexOf('.');
		if (dot !== -1) {
			// `Gio.File` → `GFile`, `GLib.Variant` → `GVariant`.
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
		if (type.girType === 'GLib.Strv' || type.elementType === 'utf8' || type.elementType === 'filename') {
			return 'strv';
		}
		if (type.girType === 'GLib.PtrArray' || /GPtrArray/.test(type.cType)) return 'ptrArray';
		if (type.elementType) return 'cArray';
		return 'unknown';
	}

	/** Map a GIR type to its TypeScript type. */
	tsType(type: TypeRef): string {
		if (type.isArray) {
			const elem = type.elementType ?? '';
			if (elem === 'utf8' || elem === 'filename') return 'string[]';
			const cls = this.ourClass(elem);
			if (cls) return `${cls.name}[]`;
			return `${this.tsScalar(elem)}[]`;
		}
		return this.tsScalar(type.girType);
	}

	private tsScalar(girType: string): string {
		if (this.enumeration(girType)) return shortName(girType);
		const cls = this.ourClass(girType);
		if (cls) return cls.name;
		if (girType === 'GLib.Strv') return 'string[]';
		if (girType === 'GLib.Bytes') return 'Uint8Array';
		const mapped = tsTable[girType];
		if (mapped === 'External') return 'unknown';
		return mapped ?? 'unknown';
	}
}
