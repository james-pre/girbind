// Runtime test: GLib sources dispatch from Node's event loop, microtasks run after
// GLib callbacks, and keepAlive() alone decides whether GLib keeps Node running.
// Needs the runtime binary (`npm run build:native`) but no generated bindings.

import assert from 'node:assert/strict';
import { keepAlive } from 'girbind';
import native from '../runtime/dist/native.js';

const order = [];
const start = performance.now();
const hold = keepAlive();

native.timeout(30, () => {
	order.push('glib timeout');
	assert.ok(performance.now() - start >= 25, 'GLib timeouts fire on time');
	Promise.resolve().then(() => order.push('microtask'));
	process.nextTick(() => order.push('nextTick'));
	setTimeout(() => {
		order.push('node timer');
		native.timeout(10, () => {
			order.push('second glib timeout');
			hold.release();
		});
	}, 10);
});

// A pending GLib source must not keep the process alive once the hold is released.
native.timeout(60_000, () => assert.fail('a GLib source kept the process alive'));

process.on('exit', code => {
	if (code) return;
	assert.deepEqual(order, ['glib timeout', 'nextTick', 'microtask', 'node timer', 'second glib timeout']);
	assert.ok(performance.now() - start < 5_000, 'the process exits once the hold is released');
	console.log('runtime.js: all assertions passed');
});
