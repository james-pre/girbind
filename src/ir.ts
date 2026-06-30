/**
 * Intermediate representation of a parsed GIR file.
 *
 * This mirrors the subset of GObject Introspection that girbind turns into
 * bindings. It is deliberately namespace-agnostic: unlike a per-library
 * generator, nothing here is hardcoded to a particular namespace (e.g. Flatpak).
 * The namespace name is read from the GIR and carried on {@link Namespace}.
 */

/** Direction of a parameter, as declared by the GIR `direction` attribute. */
export type Direction = 'in' | 'out' | 'inout';

/**
 * Ownership transfer for a parameter or return value, from the GIR
 * `transfer-ownership` attribute. Determines who is responsible for freeing the
 * value (see the reference notes on reference counting).
 */
export type Transfer = 'none' | 'container' | 'full';

/** A resolved type reference: either a plain `<type>` or an `<array>`. */
export interface TypeRef {
	/** The GIR type name, e.g. `utf8`, `gint`, `Flatpak.Remote`. */
	girType: string;
	/** The C type from `c:type`, e.g. `char*`, `FlatpakRemote*`. May be empty. */
	cType: string;
	/** True when the type is an `<array>`. */
	isArray: boolean;
	/** For arrays, the element's GIR type name (e.g. `utf8`, `Flatpak.Ref`). */
	elementType?: string;
}

export interface Parameter {
	name: string;
	type: TypeRef;
	transfer: Transfer;
	nullable: boolean;
	direction: Direction;
	/** True for the implicit `self` of an instance method. */
	isInstance: boolean;
	callerAllocates: boolean;
	/** GIR `scope` attribute, present on callback parameters (`call`/`async`/`notified`). */
	scope?: string;
}

export interface ReturnValue {
	type: TypeRef;
	transfer: Transfer;
	nullable: boolean;
}

export interface Func {
	/** Short GIR name, e.g. `get_name`, `new_for_path`. */
	name: string;
	/** C symbol from `c:identifier`, e.g. `flatpak_ref_get_name`. */
	cName: string;
	parameters: Parameter[];
	returnValue: ReturnValue;
	isMethod: boolean;
	isConstructor: boolean;
	isStatic: boolean;
	/** True when the function takes a trailing `GError**` (`throws="1"`). */
	throws: boolean;
}

export interface Property {
	name: string;
	type: TypeRef;
	readable: boolean;
	writable: boolean;
	construct: boolean;
	/** True for `construct-only="1"`: settable only at construction time. */
	constructOnly: boolean;
	/** Ownership transfer of the property value, for read conversion. */
	transfer: Transfer;
	/** Name of the GIR method implementing the getter (`getter` attr), if any. */
	getter?: string;
	/** Name of the GIR method implementing the setter (`setter` attr), if any. */
	setter?: string;
}

export interface Class {
	name: string;
	/** C type from `c:type`, e.g. `FlatpakRemote`. */
	cName: string;
	/** Parent class short name (namespace prefix stripped), or undefined. */
	parent?: string;
	constructors: Func[];
	methods: Func[];
	staticMethods: Func[];
	properties: Property[];
}

/** A GIR `<enumeration>` or `<bitfield>` and its members. */
export interface Enumeration {
	name: string;
	cName: string;
	/** True for `<bitfield>` (flags), false for plain `<enumeration>`. */
	isBitfield: boolean;
	members: EnumMember[];
}

export interface EnumMember {
	name: string;
	cName: string;
	value: string;
}

export interface Namespace {
	name: string;
	version: string;
	/** Shared library names from the `shared-library` attribute. */
	sharedLibraries: string[];
	/** C identifier prefixes, e.g. `Act`, `Flatpak`. */
	identifierPrefixes: string[];
	/** C symbol prefixes, e.g. `flatpak`. */
	symbolPrefixes: string[];
	classes: Class[];
	functions: Func[];
	enumerations: Enumeration[];
}
