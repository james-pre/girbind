// Usage test for the generated Flatpak bindings. Invoked by test/flatpak.sh with
// the path to the built entry point (build/flatpak/flatpak.js).

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { GObject, internal } from 'girbind';

const addonPath = process.argv[2];
assert.ok(addonPath, 'usage: node test/flatpak.js <path-to-flatpak.js>');

const { default: flatpak } = await import(pathToFileURL(addonPath).href);

// --- exports ----------------------------------------------------------------
for (const cls of ['Installation', 'Remote', 'Ref', 'RelatedRef', 'Transaction']) {
	assert.equal(typeof flatpak[cls], 'function', `${cls} is exported as a class`);
}
for (const fn of ['getDefaultArch', 'getSystemInstallations']) {
	assert.equal(typeof flatpak[fn], 'function', `${fn} is exported as a function`);
}

// --- standalone functions ---------------------------------------------------
assert.equal(typeof flatpak.getDefaultArch(), 'string', 'getDefaultArch returns a string');
assert.ok(Array.isArray(flatpak.getSupportedArches()), 'getSupportedArches returns an array');

// --- instances, methods, accessors, inheritance -----------------------------
const installs = flatpak.getSystemInstallations(null);
assert.ok(Array.isArray(installs), 'getSystemInstallations returns an array');
if (installs.length) {
	const inst = installs[0];
	assert.ok(inst instanceof flatpak.Installation, 'installation instanceof Installation');

	const remotes = inst.listRemotes(null);
	assert.ok(Array.isArray(remotes), 'listRemotes returns an array');
	for (const remote of remotes) {
		assert.ok(remote instanceof flatpak.Remote, 'remote instanceof Remote');
		// method and the matching accessor must agree
		assert.equal(remote.getName(), remote.name, 'remote.getName() === remote.name');
		assert.equal(typeof remote.getUrl(), 'string', 'remote.getUrl() is a string');
	}
}

// --- construction rules -----------------------------------------------------
const remote = new flatpak.Remote('girbind-test');
assert.ok(remote instanceof flatpak.Remote, 'new Remote(name) constructs');
assert.equal(remote.name, 'girbind-test', 'constructed remote reports its name');

assert.throws(() => new flatpak.Ref(), /cannot be constructed/, 'return-only class throws on new');

// --- runtime: prototype chain, identity, type checks -------------------------
assert.equal(Object.getPrototypeOf(flatpak.InstalledRef.prototype), flatpak.Ref.prototype, 'InstalledRef extends Ref');
assert.ok(remote instanceof GObject.Object, 'wrappers extend GObject.Object');
assert.ok(!Object.hasOwn(flatpak.InstalledRef.prototype, 'getName'), 'inherited methods live on the parent only');
assert.throws(() => flatpak.Ref.prototype.getName.call(remote), /Expected Flatpak\.Ref/, 'self is type-checked');

if (installs.length) {
	const inst = installs[0];
	for (const ref of inst.listInstalledRefs(null).slice(0, 3)) {
		assert.ok(ref instanceof flatpak.InstalledRef, 'installed ref wraps as InstalledRef');
		assert.equal(typeof ref.getName(), 'string', 'Ref method works on an InstalledRef');
	}

	const transaction = new flatpak.Transaction(inst, null);
	assert.equal(transaction.getInstallation(), inst, 'the same GObject returns the same wrapper');

	// Gio is not bound here, so a GFile comes back as GObject.Object and must round-trip by GType.
	const path = inst.getPath();
	assert.ok(path instanceof GObject.Object, 'objects from unbound namespaces wrap as GObject.Object');
	const reopened = new flatpak.Installation(path, inst.getIsUser(), null);
	assert.ok(reopened instanceof flatpak.Installation, 'a foreign interface object is accepted by GType');
	assert.throws(() => new flatpak.Installation(remote, false, null), /Expected Gio\.File/);

	// --- references: every wrapper's GObject is finalized once the wrapper is collected
	const collect = async () => {
		for (let i = 0; i < 6; i++) {
			globalThis.gc();
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	};
	// Wrappers are created in synchronous scopes: a suspended async frame can keep its last values alive.
	let watched = 0;
	(() => {
		for (let i = 0; i < 1000; i++) {
			for (const listed of inst.listRemotes(null)) {
				internal.watchFinalization(listed);
				watched++;
			}
		}
	})();
	(() => {
		const scoped = new flatpak.Installation(path, inst.getIsUser(), null);
		const scopedTransaction = new flatpak.Transaction(scoped, null);
		for (let i = 0; i < 1000; i++) scopedTransaction.getInstallation();
		internal.watchFinalization(scoped);
		watched++;
	})();
	await collect();
	assert.equal(internal.finalized(), watched, 'no wrapped GObject outlives its wrapper');
}

console.log('flatpak.js: all assertions passed');
