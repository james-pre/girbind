import { createRequire } from 'node:module';

/** An opaque, type-tagged native value owned by a wrapper. */
export type Handle = object & { readonly __girbindHandle: unique symbol };

export interface Native {
	abi: number;
	/** Address of the native value, unique while the handle is alive. */
	address(handle: Handle): number;
	/** GType names of an object's instance type and its ancestors, most derived first. */
	typeChain(handle: Handle): string[];
	/** GType names of the interfaces an object's instance type implements. */
	interfaces(handle: Handle): string[];
	/** Whether the handle's value is an instance of the GType named `typeName`. */
	isA(handle: Handle, typeName: string): boolean;
	release(handle: Handle): void;
	watchFinalization(handle: Handle): void;
	/** Number of watched objects finalized so far. */
	finalized(): number;
	/** Store the runtime ABI so the runtime's own native code can wrap values. */
	$init(abi: object): void;
	/** Keep the event loop alive until a matching {@link Native.releaseLoop}. */
	holdLoop(): void;
	releaseLoop(): void;
	/** Connect a JS handler to a GObject signal, returning the handler ID. */
	connect(handle: Handle, signal: string, handler: (...args: never[]) => unknown, after: boolean): number;
	disconnect(handle: Handle, id: number): void;
	/** Call `callback` once from a GLib timeout source after `delay` milliseconds. */
	timeout(delay: number, callback: () => void): void;
	/** Use `installer` for overrides of the virtual methods the class named `typeName` declares. */
	virtualMethods(typeName: string, installer: object): void;
	/** Register a GType named after `name`, extending `parent` and overriding the virtual methods `overrides`. */
	registerSubclass(name: string, parent: number, overrides: string[]): number;
	typeName(type: number): string;
	/** A registered GType by name, or 0. */
	typeFromName(name: string): number;
	/** A handle to a new instance of `type` with the given GObject properties. */
	newObject(type: number, properties: unknown): Handle;
	/** Hold a JS subclass instance through a toggle reference keeping `wrapper` alive while C also holds it. */
	toggle(handle: Handle, wrapper: object): void;
}

const require = createRequire(import.meta.url);

function load(): Native {
	const candidates = [`./girbind.${process.platform}-${process.arch}.node`, './girbind.node'];
	for (const candidate of candidates) {
		try {
			return require(candidate) as Native;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
		}
	}
	throw new Error(
		`girbind: no runtime binary for ${process.platform}-${process.arch}; build it with \`npm run build:native\` in the girbind package`
	);
}

const native = load();
export default native;
