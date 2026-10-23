// Usage test for generated Gio bindings: interfaces and out parameters.
// Invoked by test/gio.sh with the path to the built entry point (tmp/gio/native/gio.js).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
assert.throws(() => temporary.delete(null), /No such file/, 'a GError becomes a JS error');

rmSync(directory, { recursive: true });
console.log('gio.js: all assertions passed');
