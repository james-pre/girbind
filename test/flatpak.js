// Usage test for the generated Flatpak bindings. Invoked by test/flatpak.sh with
// the path to the built entry point (build/flatpak/flatpak.js).

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

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

console.log('flatpak.js: all assertions passed');
