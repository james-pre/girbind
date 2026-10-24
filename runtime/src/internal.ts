/**
 * The runtime's half of the addon ABI: wrapper creation, the registry of
 * classes and interfaces by GType name shared by every generated addon, and the
 * registration of JS subclasses as GTypes.
 */

import native, { type Handle } from './native.js';

export type { Handle };

/** Property key under which every wrapper stores its handle. */
export const handle: unique symbol = Symbol.for('girbind.handle');

/** Passed as the first constructor argument when a handle already exists. */
export const adopt: unique symbol = Symbol('girbind.adopt');

export const abi = native.abi;

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type Constructor = Function & { prototype: object };

const classes = new Map<string, Constructor>();
const interfaces = new Map<string, Constructor>();
/** Functions returning the GType of each registered class, interface and JS subclass. */
const gtypes = new Map<Constructor, () => number>();
/** Classes for GTypes without a registered class, such as private implementations of an interface. */
const derived = new Map<string, Constructor>();
const wrappers = new Map<number, WeakRef<object>>();
const finalization = new FinalizationRegistry<number>(address => {
	if (!wrappers.get(address)?.deref()) wrappers.delete(address);
});

/** Add the members of the registered interfaces named `typeNames` that `prototype` lacks. */
function implement(prototype: object, typeNames: Iterable<string>): void {
	for (const typeName of typeNames) {
		const source = interfaces.get(typeName)?.prototype;
		if (!source) continue;
		for (const key of Reflect.ownKeys(source)) {
			if (key === 'constructor' || key in prototype) continue;
			Object.defineProperty(prototype, key, Object.getOwnPropertyDescriptor(source, key)!);
		}
	}
}

/** Define `$gtype` on a class or interface, returning the GType of the class it is read from. */
function defineGType(constructor: Constructor, gtype: () => number): void {
	gtypes.set(constructor, gtype);
	Object.defineProperty(constructor, '$gtype', {
		get(this: Constructor) {
			return gtypeOf(this);
		},
		configurable: true,
	});
}

/**
 * Use `constructor` for objects whose GType, or nearest registered ancestor, is
 * named `typeName`, adding the members of the registered `implemented` interfaces.
 * `gtype` returns its GType, and `installer` sets JS subclasses' overrides of the
 * virtual methods it declares.
 */
export function register(
	typeName: string,
	constructor: Constructor,
	implemented: string[] = [],
	gtype: () => number = () => native.typeFromName(typeName),
	installer?: object
): void {
	classes.set(typeName, constructor);
	derived.delete(typeName);
	implement(constructor.prototype, implemented);
	defineGType(constructor, gtype);
	if (installer) native.virtualMethods(typeName, installer);
}

/** The GType of a class, registering one for a JS subclass the first time. */
function gtypeOf(constructor: Constructor): number {
	const gtype = gtypes.get(constructor);
	if (gtype) return gtype();
	const parent: unknown = Object.getPrototypeOf(constructor);
	if (typeof parent !== 'function' || parent === Function.prototype) {
		throw new TypeError(`${constructor.name} does not extend a GObject class`);
	}
	const overrides = Object.getOwnPropertyNames(constructor.prototype)
		.filter(name => name.startsWith('vfunc_'))
		.map(name => name.slice('vfunc_'.length));
	const type = native.registerSubclass(constructor.name, gtypeOf(parent), overrides);
	gtypes.set(constructor, () => type);
	classes.set(native.typeName(type), constructor);
	return type;
}

/** Whether `constructor` is or extends the class registered for `typeName`. */
function extendsClass(constructor: Constructor, typeName: string): boolean {
	const base = classes.get(typeName);
	return !!base && (constructor === base || constructor.prototype instanceof base);
}

/**
 * The handle for a new instance of the GObject class (or JS subclass)
 * `constructor`, with the GObject `properties` given, or undefined for a class
 * that is not a GObject class.
 */
export function constructObject(constructor: Constructor, properties?: unknown): Handle | undefined {
	if (!extendsClass(constructor, 'GObject')) return undefined;
	return native.newObject(gtypeOf(constructor), properties);
}

/** Whether `value` is a wrapper of an object whose GType is or implements `typeName`. */
function isA(value: unknown, typeName: string): boolean {
	if (typeof value !== 'object' || value === null || !(handle in value)) return false;
	return native.isA((value as Record<typeof handle, Handle>)[handle], typeName);
}

/**
 * Use `iface` for the interface named `typeName`, whose prototype holds the
 * members its implementations share, and whose GType `gtype` returns.
 */
export function registerInterface(
	typeName: string,
	iface: Constructor,
	gtype: () => number = () => native.typeFromName(typeName)
): void {
	interfaces.set(typeName, iface);
	defineGType(iface, gtype);
	derived.clear();
	Object.defineProperty(iface, Symbol.hasInstance, {
		value: (value: unknown) => isA(value, typeName),
		configurable: true,
	});
}

/**
 * Bind `wrapper` to `value`, making it the wrapper returned for that native
 * value. A JS subclass instance's wrapper then lives as long as its object.
 */
export function attach(wrapper: object, value: Handle): void {
	Object.defineProperty(wrapper, handle, { value });
	const address = native.address(value);
	wrappers.set(address, new WeakRef(wrapper));
	finalization.register(wrapper, address);
	native.toggle(value, wrapper);
}

/** The class registered for a GType name; throws when the namespace defining it has not been loaded. */
export function lookup(typeName: string): Constructor {
	const constructor = classes.get(typeName);
	if (!constructor) throw new Error(`girbind: no class registered for ${typeName}; import its bindings first`);
	return constructor;
}

/**
 * The class for a value: the class registered for its GType, or else a class
 * extending its nearest registered ancestor with the interfaces the type
 * implements.
 */
function classFor(value: Handle): Constructor {
	const chain = native.typeChain(value);
	const [typeName] = chain;
	const known = classes.get(typeName) ?? derived.get(typeName);
	if (known) return known;
	const parent = chain.map(name => classes.get(name)).find(constructor => constructor);
	if (!parent) throw new Error('girbind: no class registered for GObject');
	const extra = native.interfaces(value).filter(name => interfaces.has(name));
	let constructor = parent;
	if (extra.length) {
		constructor = class extends (parent as new (...args: never[]) => object) {};
		Object.defineProperty(constructor, 'name', { value: typeName });
		implement(constructor.prototype, extra);
	}
	derived.set(typeName, constructor);
	return constructor;
}

/** The wrapper for an object handle, reusing the live one for the same object. */
export function wrap(value: Handle): object {
	const existing = wrappers.get(native.address(value))?.deref();
	if (existing) {
		native.release(value);
		return existing;
	}
	const wrapper = Object.create(classFor(value).prototype) as object;
	attach(wrapper, value);
	return wrapper;
}

/** Count the finalization of `wrapper`'s GObject in {@link finalized}, for leak tests. */
export function watchFinalization(wrapper: object): void {
	native.watchFinalization((wrapper as Record<typeof handle, Handle>)[handle]);
}

/** Number of objects passed to {@link watchFinalization} that have been finalized. */
export function finalized(): number {
	return native.finalized();
}

/** Keep the event loop alive while an asynchronous call is pending. */
export function holdLoop(): void {
	native.holdLoop();
}

export function releaseLoop(): void {
	native.releaseLoop();
}

/**
 * Call `listener` when `signal` aborts (now, if it already has), returning a
 * function that stops listening. Throws unless `signal` is an AbortSignal.
 */
export function onAbort(signal: unknown, listener: () => void): () => void {
	if (!(signal instanceof AbortSignal)) throw new TypeError('Expected a Gio.Cancellable or an AbortSignal');
	if (signal.aborted) {
		listener();
		return () => {};
	}
	signal.addEventListener('abort', listener, { once: true });
	return () => signal.removeEventListener('abort', listener);
}
