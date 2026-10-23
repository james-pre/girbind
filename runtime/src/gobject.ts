import { adopt, attach, type Handle, register } from './internal.js';

/** Base class of every GObject wrapper. */
export class Object {
	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		if (args[0] !== adopt) throw new TypeError(`${new.target.name} cannot be constructed directly`);
		attach(this, args[1] as Handle);
	}
}

export class InitiallyUnowned extends Object {}

register('GObject', Object);
register('GInitiallyUnowned', InitiallyUnowned);
