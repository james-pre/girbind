import { adopt, attach, constructObject, type Handle, handle, register } from './internal.js';
import native from './native.js';
import { signals } from './signals.js';

/**
 * Base class of every GObject wrapper. `Signals` maps each signal name to its
 * arguments and return value; subclasses pass their own signals up through it.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class Object<Signals extends object = {}> {
	declare readonly [signals]: Signals & {
		[name: `notify::${string}`]: (pspec: { name: string }) => void;
	};
	/** The class's GType, registered the first time it is read for a JS subclass. */
	declare static readonly $gtype: number;

	/** Construct an instance with the given GObject property values. */
	constructor(properties?: Record<string, unknown>);
	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		attach(this, args[0] === adopt ? (args[1] as Handle) : constructObject(new.target, args[0])!);
	}

	/**
	 * Run the object's dispose, so it drops its references to other objects: a
	 * GTK widget releases its children, event controllers and signal handlers.
	 * Use it when removing an object whose wrapper is reachable from a handler on
	 * an object it owns, such as a widget whose controller's handler captures the
	 * widget, a cycle through C that garbage collection cannot see.
	 * Remove a widget from its parent before disposing it.
	 */
	dispose(): void {
		native.dispose((this as unknown as Record<typeof handle, Handle>)[handle]);
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class InitiallyUnowned<Signals extends object = {}> extends Object<Signals> {}

/** Base class of every record (boxed or plain struct) wrapper. */
export class Boxed {
	declare static readonly $gtype: number;

	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		if (args[0] !== adopt) throw new TypeError(`${new.target.name} cannot be constructed directly`);
		attach(this, args[1] as Handle);
	}
}

register('GObject', Object);
register('GInitiallyUnowned', InitiallyUnowned);
register('GBoxed', Boxed);
