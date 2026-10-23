import { adopt, attach, type Handle, register } from './internal.js';
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

	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		if (args[0] !== adopt) throw new TypeError(`${new.target.name} cannot be constructed directly`);
		attach(this, args[1] as Handle);
	}
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class InitiallyUnowned<Signals extends object = {}> extends Object<Signals> {}

/** Base class of every record (boxed or plain struct) wrapper. */
export class Boxed {
	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		if (args[0] !== adopt) throw new TypeError(`${new.target.name} cannot be constructed directly`);
		attach(this, args[1] as Handle);
	}
}

register('GObject', Object);
register('GInitiallyUnowned', InitiallyUnowned);
register('GBoxed', Boxed);
