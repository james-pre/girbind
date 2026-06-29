#!/usr/bin/env node

import cli from './cli.js';
import { done, exit } from 'ioium/node';

try {
	await cli.parseAsync();
} catch (e) {
	if (typeof e == 'number') process.exit(e);
	done(true);
	exit(e);
}
