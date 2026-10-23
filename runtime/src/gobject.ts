import { adopt, attach, type Handle, handle, register } from './internal.js';
import native from './native.js';

export interface ConnectOptions {
	/** Disconnect the handler when this signal aborts. */
	signal?: AbortSignal;
	/** Run the handler after the class handler, like `g_signal_connect_after`. */
	after?: boolean;
}

/** Abort listeners of handlers connected with `ConnectOptions.signal`, by wrapper and handler ID. */
const abortListeners = new WeakMap<object, Map<number, { signal: AbortSignal; listener: () => void }>>();

function handleOf(wrapper: object): Handle {
	return (wrapper as Record<typeof handle, Handle>)[handle];
}

/** Base class of every GObject wrapper. */
export class Object {
	constructor(marker: typeof adopt, value: Handle);
	constructor(...args: unknown[]) {
		if (args[0] !== adopt) throw new TypeError(`${new.target.name} cannot be constructed directly`);
		attach(this, args[1] as Handle);
	}

	/**
	 * Connect `handler` to a signal, such as `close-request` or `notify::title`.
	 * The handler receives this object, then the signal's arguments; its return
	 * value is the signal's return value. Returns the handler ID, or 0 when
	 * `options.signal` has already aborted.
	 */
	connect(
		signal: string,
		handler: (self: this, ...args: any[]) => unknown, // eslint-disable-line @typescript-eslint/no-explicit-any
		options: ConnectOptions = {}
	): number {
		if (options.signal?.aborted) return 0;
		const id = native.connect(handleOf(this), signal, handler, options.after ?? false);
		if (!options.signal) return id;

		const listener = () => this.disconnect(id);
		options.signal.addEventListener('abort', listener, { once: true });
		let listeners = abortListeners.get(this);
		if (!listeners) {
			listeners = new Map();
			abortListeners.set(this, listeners);
		}
		listeners.set(id, { signal: options.signal, listener });
		return id;
	}

	disconnect(id: number): void {
		native.disconnect(handleOf(this), id);
		const listeners = abortListeners.get(this);
		const entry = listeners?.get(id);
		if (!entry) return;
		entry.signal.removeEventListener('abort', entry.listener);
		listeners!.delete(id);
	}

	/**
	 * Resolve with the arguments of the next emission of `signal`, excluding this
	 * object. Rejects with the abort reason if `options.signal` aborts first.
	 */
	once(signal: string, options: Omit<ConnectOptions, 'after'> = {}): Promise<unknown[]> {
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			const id = this.connect(
				signal,
				(_self, ...args: unknown[]) => {
					this.disconnect(id);
					options.signal?.removeEventListener('abort', onAbort);
					resolve(args);
				},
				{}
			);
			const onAbort = () => {
				this.disconnect(id);
				reject(options.signal!.reason);
			};
			options.signal?.addEventListener('abort', onAbort, { once: true });
		});
	}
}

export class InitiallyUnowned extends Object {}

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
