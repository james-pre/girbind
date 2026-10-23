import * as internal from './internal.js';
import native from './native.js';

native.$init(internal);

export * as GObject from './gobject.js';
export { connect, disconnect, once, signals } from './signals.js';
export type { ConnectOptions, SignalHandler, SignalMap } from './signals.js';
export { internal };
export type { Handle } from './native.js';

/** A hold on the Node event loop, released with `release()` or `using`. */
export interface KeepAlive extends Disposable {
	release(): void;
}

/**
 * Keep the Node process running until the returned hold is released, for
 * example while a GTK application has windows open. GLib events are processed
 * either way; this only stops Node from exiting when nothing else is pending.
 */
export function keepAlive(): KeepAlive {
	native.holdLoop();
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			native.releaseLoop();
		},
		[Symbol.dispose]() {
			this.release();
		},
	};
}
