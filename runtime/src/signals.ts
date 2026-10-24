import type { Object } from './gobject.js';
import { type Handle, handle } from './internal.js';
import native from './native.js';

/** Type-only key of the signal map that `GObject.Object` declares. */
export const signals: unique symbol = Symbol('girbind.signals');

/** The signals of a GObject class: each signal's arguments (excluding the emitter) and return value, by name. */
export type SignalMap<T> = T extends { readonly [signals]: infer Map } ? Map : never;

/** A handler for a signal of `T`, which receives `T` before the signal's arguments. */
export type SignalHandler<T, Signal> = Signal extends (...args: infer Args) => infer Result
	? (self: T, ...args: Args) => Result
	: never;

export interface ConnectOptions {
	/** Disconnect the handler when this signal aborts. */
	signal?: AbortSignal;
	/** Run the handler after the class handler, like `g_signal_connect_after`. */
	after?: boolean;
}

/**
 * Connected handlers, by target and handler ID. A target's wrapper keeps its
 * handlers alive, and lives while C holds its object, so a handler capturing
 * its own target is collected with it once only JS holds the object.
 */
const handlers = new WeakMap<object, Map<number, (...args: never[]) => unknown>>();

/** Abort listeners of handlers connected with `ConnectOptions.signal`, by target and handler ID. */
const abortListeners = new WeakMap<object, Map<number, { signal: AbortSignal; listener: () => void }>>();

function handleOf(target: Object): Handle {
	return (target as unknown as Record<typeof handle, Handle>)[handle];
}

/**
 * Connect `handler` to a signal of `target`, such as `close-request` or
 * `notify::title`. The handler receives `target`, then the signal's arguments;
 * its return value is the signal's return value. Returns the handler ID, or 0
 * when `options.signal` has already aborted.
 */
export function connect<T extends Object, S extends keyof SignalMap<T> & string>(
	target: T,
	signal: S,
	handler: SignalHandler<T, SignalMap<T>[S]>,
	options?: ConnectOptions
): number;
/** Connect to a signal the class's declarations do not list, such as one added at runtime. */
export function connect<T extends Object, S extends string>(
	target: T,
	signal: S extends keyof SignalMap<T> ? never : S,
	handler: (self: T, ...args: any[]) => unknown, // eslint-disable-line @typescript-eslint/no-explicit-any
	options?: ConnectOptions
): number;
export function connect(
	target: Object,
	signal: string,
	handler: (...args: never[]) => unknown,
	options: ConnectOptions = {}
): number {
	if (options.signal?.aborted) return 0;
	native.toggle(handleOf(target), target, true);
	const id = native.connect(handleOf(target), signal, handler, options.after ?? false);
	let connected = handlers.get(target);
	if (!connected) {
		connected = new Map();
		handlers.set(target, connected);
	}
	connected.set(id, handler);
	if (!options.signal) return id;

	const listener = () => disconnect(target, id);
	options.signal.addEventListener('abort', listener, { once: true });
	let listeners = abortListeners.get(target);
	if (!listeners) {
		listeners = new Map();
		abortListeners.set(target, listeners);
	}
	listeners.set(id, { signal: options.signal, listener });
	return id;
}

/** Disconnect a handler connected with {@link connect}. */
export function disconnect(target: Object, id: number): void {
	native.disconnect(handleOf(target), id);
	handlers.get(target)?.delete(id);
	const listeners = abortListeners.get(target);
	const entry = listeners?.get(id);
	if (!entry) return;
	entry.signal.removeEventListener('abort', entry.listener);
	listeners!.delete(id);
}

/**
 * Resolve with the arguments of the next emission of `signal`, excluding
 * `target`. Rejects with the abort reason if `options.signal` aborts first.
 */
export function once<T extends Object, S extends keyof SignalMap<T> & string>(
	target: T,
	signal: S,
	options?: Omit<ConnectOptions, 'after'>
): Promise<Parameters<Extract<SignalMap<T>[S], (...args: never[]) => unknown>>>;
export function once<T extends Object, S extends string>(
	target: T,
	signal: S extends keyof SignalMap<T> ? never : S,
	options?: Omit<ConnectOptions, 'after'>
): Promise<unknown[]>;
export function once(target: Object, signal: string, options: Omit<ConnectOptions, 'after'> = {}): Promise<unknown[]> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
	if (options.signal?.aborted) {
		reject(options.signal.reason as Error);
		return promise;
	}
	const onAbort = () => {
		disconnect(target, id);
		reject(options.signal!.reason as Error);
	};
	const id = connect(target, signal, (_self: Object, ...args: unknown[]) => {
		disconnect(target, id);
		options.signal?.removeEventListener('abort', onAbort);
		resolve(args);
	});
	options.signal?.addEventListener('abort', onAbort, { once: true });
	return promise;
}
