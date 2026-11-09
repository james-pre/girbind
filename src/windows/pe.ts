/**
 * Reading which DLLs Windows executables and DLLs import.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The names of the DLLs a PE file imports, including delay-loaded ones */
export function imports(path: string): string[] {
	const data = readFileSync(path);
	const header = data.readUInt32LE(0x3c);
	if (data.toString('latin1', header, header + 4) != 'PE\0\0') throw new Error('Not a PE file: ' + path);
	const sectionCount = data.readUInt16LE(header + 6);
	const optionalSize = data.readUInt16LE(header + 20);
	const optional = header + 24;
	const directories = optional + (data.readUInt16LE(optional) == 0x20b ? 112 : 96);
	const sections = Array.from({ length: sectionCount }, (_, i) => {
		const section = optional + optionalSize + i * 40;
		return {
			address: data.readUInt32LE(section + 12),
			size: Math.max(data.readUInt32LE(section + 8), data.readUInt32LE(section + 16)),
			offset: data.readUInt32LE(section + 20),
		};
	});
	const position = (address: number) => {
		const section = sections.find(
			section => address >= section.address && address < section.address + section.size
		);
		if (!section) throw new Error(`Address ${address} is outside every section of ${path}`);
		return address - section.address + section.offset;
	};

	const names: string[] = [];
	const read = (directory: number, entrySize: number, nameField: number) => {
		const address = data.readUInt32LE(directories + directory * 8);
		if (!address) return;
		for (let entry = position(address); ; entry += entrySize) {
			const name = data.readUInt32LE(entry + nameField);
			if (!name) break;
			const start = position(name);
			names.push(data.toString('latin1', start, data.indexOf(0, start)));
		}
	};
	read(1, 20, 12);
	read(13, 32, 4);
	return names;
}

/**
 * Every DLL in `directory` that the files need, directly or through other DLLs.
 * DLLs that aren't in `directory` are assumed to come with Windows.
 */
export function dependencies(files: string[], directory: string): string[] {
	const available = new Map(readdirSync(directory).map(name => [name.toLowerCase(), join(directory, name)]));
	const own = new Set(files.map(file => basename(file).toLowerCase()));
	const found = new Map<string, string>();
	const queue = [...files];
	for (let file = queue.shift(); file; file = queue.shift()) {
		for (const name of imports(file).map(name => name.toLowerCase())) {
			const path = available.get(name);
			if (!path || found.has(name) || own.has(name)) continue;
			found.set(name, path);
			queue.push(path);
		}
	}
	return [...found.values()];
}
