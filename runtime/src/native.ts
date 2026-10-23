import { createRequire } from 'node:module';

/** An opaque, type-tagged native value owned by a wrapper. */
export type Handle = object & { readonly __girbindHandle: unique symbol };

export interface Native {
	abi: number;
	/** Address of the native value, unique while the handle is alive. */
	address(handle: Handle): number;
	/** GType names of an object's instance type and its ancestors, most derived first. */
	typeChain(handle: Handle): string[];
	release(handle: Handle): void;
	watchFinalization(handle: Handle): void;
	/** Number of watched objects finalized so far. */
	finalized(): number;
}

const require = createRequire(import.meta.url);

function load(): Native {
	const candidates = [`./girbind.${process.platform}-${process.arch}.node`, './girbind.node'];
	for (const candidate of candidates) {
		try {
			return require(candidate) as Native;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
		}
	}
	throw new Error(
		`girbind: no runtime binary for ${process.platform}-${process.arch}; build it with \`npm run build:native\` in the girbind package`
	);
}

const native = load();
export default native;
