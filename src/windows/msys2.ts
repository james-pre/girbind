/**
 * Downloading MSYS2 packages, which provide the GObject libraries, headers and GIR files for building Windows addons.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const mirror = 'https://repo.msys2.org/mingw/ucrt64/';

/** Prefix of the names of MSYS2's UCRT64 packages */
export const packagePrefix = 'mingw-w64-ucrt-x86_64-';

interface TarEntry {
	name: string;
	/** The tar type flag, e.g. `0` for a file and `5` for a directory */
	type: string;
	content: Buffer;
	link: string;
}

/** The entries of a tar archive */
function* untar(data: Buffer): Generator<TarEntry> {
	let longName: string | undefined;
	let paxPath: string | undefined;
	for (let offset = 0; offset + 512 <= data.length;) {
		const header = data.subarray(offset, offset + 512);
		if (header.every(byte => byte == 0)) break;
		const field = (start: number, length: number) =>
			header
				.subarray(start, start + length)
				.toString('utf8')
				.replace(/\0.*$/s, '');
		const size = parseInt(field(124, 12).trim() || '0', 8);
		const type = field(156, 1) || '0';
		const prefix = field(257, 6) == 'ustar' ? field(345, 155) : '';
		const name = paxPath ?? longName ?? (prefix ? prefix + '/' : '') + field(0, 100);
		const content = data.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;

		if (type == 'L') {
			longName = content.toString('utf8').replace(/\0.*$/s, '');
			continue;
		}
		if (type == 'x') {
			paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString('utf8'))?.[1];
			continue;
		}
		longName = paxPath = undefined;
		yield { name, type, content, link: field(157, 100) };
	}
}

/** Downloads a file from the mirror into the cache, unless it is already there or `refresh` is set */
async function download(file: string, cache: string, refresh = false): Promise<Buffer> {
	const path = join(cache, file);
	if (!refresh && existsSync(path)) return readFileSync(path);
	const response = await fetch(mirror + file);
	if (!response.ok) throw new Error(`Couldn't download ${file}: ${response.status} ${response.statusText}`);
	const data = Buffer.from(await response.arrayBuffer());
	mkdirSync(cache, { recursive: true });
	writeFileSync(path, data);
	return data;
}

interface Package {
	name: string;
	file: string;
	checksum: string;
	depends: string[];
}

interface Repository {
	packages: Map<string, Package>;
	/** The package that provides each name that isn't a package's own */
	providers: Map<string, string>;
}

function withoutVersion(name: string): string {
	return name.replace(/[<>=].*$/, '');
}

async function repository(cache: string): Promise<Repository> {
	const packages = new Map<string, Package>();
	const providers = new Map<string, string>();
	const database = zstdDecompressSync(await download('ucrt64.db', cache, true));
	for (const { name, content } of untar(database)) {
		if (!name.endsWith('/desc')) continue;
		const fields: Record<string, string[]> = {};
		for (const [, key, values] of content.toString('utf8').matchAll(/%([A-Z0-9]+)%\n((?:.+\n)*)/g)) {
			fields[key] = values.trim().split('\n');
		}
		const description: Package = {
			name: fields.NAME[0],
			file: fields.FILENAME[0],
			checksum: fields.SHA256SUM[0],
			depends: (fields.DEPENDS ?? []).map(withoutVersion),
		};
		packages.set(description.name, description);
		for (const provided of fields.PROVIDES ?? []) providers.set(withoutVersion(provided), description.name);
	}
	return { packages, providers };
}

export interface InstallOptions {
	/** Where downloads are kept, `<root>/.cache` by default */
	cache?: string;
	/** Packages to leave out even when something depends on them, without the package prefix */
	exclude?: string[];
}

/**
 * Downloads packages and everything they depend on, then unpacks them into `root`, which mirrors the root of an MSYS2 installation.
 * @param names Package names, without the package prefix, e.g. `gtk4`
 * @returns the names of the unpacked packages
 */
export async function install(names: string[], root: string, options: InstallOptions = {}): Promise<string[]> {
	const { cache = join(root, '.cache'), exclude = [] } = options;
	const { packages, providers } = await repository(cache);
	const needed = new Map<string, Package>();
	const queue = names.map(name => packagePrefix + name);
	const excluded = new Set(exclude.map(name => packagePrefix + name));
	for (let requested = queue.shift(); requested; requested = queue.shift()) {
		const name = packages.has(requested) ? requested : providers.get(requested);
		if (!name) throw new Error('No MSYS2 package provides ' + requested);
		if (needed.has(name) || excluded.has(name)) continue;
		const description = packages.get(name)!;
		needed.set(name, description);
		queue.push(...description.depends);
	}

	for (const { name, file, checksum } of needed.values()) {
		const marker = join(root, '.installed', name);
		if (existsSync(marker) && readFileSync(marker, 'utf8') == checksum) continue;
		const archive = await download(file, cache);
		if (createHash('sha256').update(archive).digest('hex') != checksum)
			throw new Error('Checksum mismatch for ' + file);

		const data = file.endsWith('.zst') ? zstdDecompressSync(archive) : archive;
		for (const entry of untar(data)) {
			if (entry.name.startsWith('.')) continue;
			const path = join(root, entry.name);
			if (entry.type == '5') {
				mkdirSync(path, { recursive: true });
			} else if (entry.type == '0' || entry.type == '7') {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, entry.content);
			} else if (entry.type == '2' && !existsSync(path)) {
				mkdirSync(dirname(path), { recursive: true });
				symlinkSync(posix.normalize(entry.link), path);
			}
		}
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(marker, checksum);
	}

	return [...needed.keys()];
}
