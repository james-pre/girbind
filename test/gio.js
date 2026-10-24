// Usage test for generated Gio bindings: interfaces, out parameters, async functions, callbacks and subclasses.
// Invoked by test/gio.sh with the path to the built entry point (tmp/gio/native/gio.js).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GObject, internal } from 'girbind';

const addonPath = process.argv[2];
assert.ok(addonPath, 'usage: node test/gio.js <path-to-gio.js>');

const { default: Gio } = await import(pathToFileURL(addonPath).href);

const directory = mkdtempSync(join(tmpdir(), 'girbind-'));
const path = join(directory, 'lines.txt');
writeFileSync(path, 'first\nsecond:third\n');

// --- interfaces ---------------------------------------------------------------
const file = Gio.File.newForPath(path);
assert.ok(file instanceof Gio.File, 'instanceof checks the GType against an interface');
assert.ok(!(new Gio.SimpleActionGroup() instanceof Gio.File), 'instanceof rejects other objects');
assert.ok(!({} instanceof Gio.File), 'instanceof rejects non-wrappers');
assert.notEqual(file.constructor, Gio.File, 'a private implementation gets its own class');
assert.equal(file.getPath(), path, 'interface methods work on a private implementation');
assert.equal(file.getBasename(), 'lines.txt');
assert.ok(file.equal(Gio.File.newForPath(path)), 'interface-typed arguments accept implementations');
assert.throws(() => new Gio.File(), /cannot be constructed/, 'interfaces cannot be constructed');

const group = new Gio.SimpleActionGroup();
group.addAction(new Gio.SimpleAction('quit', null));
assert.ok(group instanceof Gio.ActionGroup && group instanceof Gio.ActionMap);
assert.ok(group.hasAction('quit'), 'a bound class gets the members of the interfaces it implements');
assert.deepEqual(group.listActions(), ['quit']);
assert.equal(Object.getPrototypeOf(group), Gio.SimpleActionGroup.prototype, 'a bound class keeps its prototype');

// --- out parameters -----------------------------------------------------------
const stream = new Gio.DataInputStream(file.read(null));
assert.deepEqual(stream.readLineUtf8(null), ['first', 5], 'a return value and an out parameter form a tuple');
assert.deepEqual(stream.readUpto(':', -1, null), ['second', 6]);
stream.close(null);

const [temporary, temporaryStream] = Gio.File.newTmp(null);
assert.ok(temporary instanceof Gio.File && temporaryStream instanceof Gio.FileIOStream, 'static interface functions');
temporaryStream.close(null);
assert.ok(temporary.delete(null), 'a throwing interface method succeeds');
assert.throws(
	() => temporary.delete(null),
	error => error.domain === 'g-io-error-quark' && error.code === Gio.IOErrorEnum.not_found,
	'a GError becomes a JS error with its domain and code'
);

// --- asynchronous functions -----------------------------------------------------
const [loaded, contents] = await file.loadContentsAsync(null);
assert.ok(loaded && contents instanceof Uint8Array, 'an async function resolves with its finish function result');
assert.equal(Buffer.from(contents).toString(), 'first\nsecond:third\n', 'a byte array with a length is a Uint8Array');

const [replaced] = await file.replaceContentsAsync(
	Buffer.from('replaced'),
	null,
	false,
	Gio.FileCreateFlags.none,
	null
);
assert.ok(replaced, 'a Uint8Array argument is kept alive until the call completes');
assert.equal(Buffer.from(file.loadContents(null)[1]).toString(), 'replaced');
const [bytesReplaced] = await new Promise((resolve, reject) => {
	file.replaceContentsBytesAsync(Buffer.from('bytes'), null, false, Gio.FileCreateFlags.none, null, (_, result) => {
		try {
			resolve(file.replaceContentsFinish(result));
		} catch (error) {
			reject(error);
		}
	});
});
assert.ok(bytesReplaced, 'an async-scoped callback runs once, keeping Node alive until then');
assert.equal(Buffer.from(file.loadContents(null)[1]).toString(), 'bytes', 'a Uint8Array converts to GLib.Bytes');

const [created, createdStream] = await Gio.File.newTmpAsync(null, 0, null);
assert.ok(created instanceof Gio.File && createdStream instanceof Gio.FileIOStream, 'static async functions');
createdStream.close(null);
created.delete(null);

await assert.rejects(
	Gio.File.newForPath(join(directory, 'missing')).loadContentsAsync(null),
	error => error.domain === 'g-io-error-quark' && error.code === Gio.IOErrorEnum.not_found,
	'a GError rejects the promise'
);

const reason = new Error('stop');
await assert.rejects(file.loadContentsAsync(AbortSignal.abort(reason)), error => error === reason, 'an aborted signal');
const controller = new AbortController();
const pending = file.loadContentsAsync(controller.signal);
controller.abort();
await assert.rejects(pending, { name: 'AbortError' }, 'aborting a pending call rejects with the reason');
assert.throws(() => file.loadContentsAsync({}), TypeError, 'cancellables are Gio.Cancellables or AbortSignals');

// --- callbacks ----------------------------------------------------------------
const copy = Gio.File.newForPath(join(directory, 'copy.txt'));
const progress = [];
assert.ok(file.copy(copy, Gio.FileCopyFlags.overwrite, null, (current, total) => progress.push([current, total])));
assert.ok(progress.length > 0, 'a call-scoped callback runs during the call');
assert.deepEqual(progress.at(-1), [5, 5]);

const failure = new Error('from a callback');
assert.throws(
	() =>
		file.copy(copy, Gio.FileCopyFlags.overwrite, null, () => {
			throw failure;
		}),
	error => error === failure,
	"a call-scoped callback's exception is rethrown to the caller"
);

const asyncProgress = [];
assert.ok(await file.copyAsync(copy, Gio.FileCopyFlags.overwrite, 0, null, current => asyncProgress.push(current)));
assert.ok(asyncProgress.length > 0, 'a callback passed to an async function runs until it completes');

const vfs = Gio.Vfs.getDefault();
const lookups = [];
assert.ok(
	vfs.registerUriScheme(
		'girbind',
		(_, identifier) => {
			lookups.push(identifier);
			return Gio.File.newForPath(path);
		},
		null
	),
	'a notified callback is registered'
);
assert.equal(Gio.File.newForUri('girbind://anything').getPath(), path, "a notified callback's result is returned to C");
assert.deepEqual(lookups, ['girbind://anything']);
assert.ok(vfs.unregisterUriScheme('girbind'), 'its destroy notify frees it');

// --- subclasses ---------------------------------------------------------------
class Item extends GObject.Object {
	constructor(label) {
		super();
		this.label = label;
	}
}

/** Collect garbage until `condition` holds, letting finalizers and WeakRefs settle between rounds. */
async function collect(condition = () => false) {
	for (let round = 0; round < 10 && !condition(); round++) {
		globalThis.gc();
		await new Promise(resolve => setImmediate(resolve));
	}
}

assert.ok(Item.$gtype > 0 && Item.$gtype !== GObject.Object.$gtype, 'a JS subclass gets its own GType');
const store = new Gio.ListStore(Item.$gtype);
// Objects are only touched in synchronous functions, so no suspended async frame keeps a wrapper alive.
const fill = () => {
	for (const label of ['beta', 'gamma', 'alpha']) {
		const item = new Item(label);
		internal.watchFinalization(item);
		store.append(item);
	}
};
const labels = () => [0, 1, 2].map(i => store.getItem(i).label);
fill();
await collect();
assert.deepEqual(labels(), ['beta', 'gamma', 'alpha'], 'a wrapper lives, with its fields, while C holds its object');
assert.ok((() => store.getItem(0) instanceof Item && store.getItem(0) === store.getItem(0))());

store.sort((a, b) => a.label.localeCompare(b.label));
assert.deepEqual(labels(), ['alpha', 'beta', 'gamma'], 'a compare function receives the items as objects');

const before = internal.finalized();
store.removeAll();
await collect(() => internal.finalized() - before === 3);
assert.equal(internal.finalized() - before, 3, 'objects are finalized once neither JS nor C holds them');

const events = [];
class App extends Gio.Application {
	vfunc_startup() {
		super.vfunc_startup();
		events.push('startup');
	}

	vfunc_activate() {
		events.push(`activate ${this.getApplicationId()}`);
	}
}
const app = new App({ applicationId: 'dev.girbind.Test', flags: Gio.ApplicationFlags.non_unique });
assert.ok(app instanceof Gio.Application);
app.register(null);
app.activate();
assert.deepEqual(events, ['startup', 'activate dev.girbind.Test'], 'GLib calls the overrides, which can chain up');
assert.throws(() => new App(5), TypeError, 'subclass constructors take an object of properties');

assert.equal(new Gio.SimpleAction({ name: 'save' }).getName(), 'save', 'classes construct from GObject properties');
assert.throws(() => new Gio.InputStream({}), /abstract/, 'abstract classes are constructed only through subclasses');

rmSync(directory, { recursive: true });
console.log('gio.js: all assertions passed');
