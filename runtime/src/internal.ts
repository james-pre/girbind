/**
 * The runtime's half of the addon ABI: wrapper creation and the registry of
 * classes by GType name, shared by every generated addon.
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
const wrappers = new Map<number, WeakRef<object>>();
const finalization = new FinalizationRegistry<number>(address => {
	if (!wrappers.get(address)?.deref()) wrappers.delete(address);
});

/** Use `constructor` for objects whose GType, or nearest registered ancestor, is named `typeName`. */
export function register(typeName: string, constructor: Constructor): void {
	classes.set(typeName, constructor);
}

/** Bind `wrapper` to `value`, making it the wrapper returned for that native value. */
export function attach(wrapper: object, value: Handle): void {
	Object.defineProperty(wrapper, handle, { value });
	const address = native.address(value);
	wrappers.set(address, new WeakRef(wrapper));
	finalization.register(wrapper, address);
}

/** The class registered for a GType name; throws when the namespace defining it has not been loaded. */
export function lookup(typeName: string): Constructor {
	const constructor = classes.get(typeName);
	if (!constructor) throw new Error(`girbind: no class registered for ${typeName}; import its bindings first`);
	return constructor;
}

function classFor(value: Handle): Constructor {
	for (const typeName of native.typeChain(value)) {
		const constructor = classes.get(typeName);
		if (constructor) return constructor;
	}
	throw new Error('girbind: no class registered for GObject');
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
