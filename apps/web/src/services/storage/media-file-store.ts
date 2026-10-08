import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import type { StorageAdapter } from "./types";

interface StoredMediaFile {
	blob: Blob;
	name: string;
	type: string;
	lastModified: number;
}

/**
 * True when OPFS files can be written from the page itself
 * (`FileSystemFileHandle.createWritable`). Chromium has it; older WebKit
 * (iPadOS before Safari 26) only offers worker sync handles.
 */
export function canWriteOpfsFiles(): boolean {
	return (
		OPFSAdapter.isSupported() &&
		typeof FileSystemFileHandle !== "undefined" &&
		typeof (FileSystemFileHandle.prototype as { createWritable?: unknown })
			.createWritable === "function"
	);
}

/**
 * Media bytes of one project. Written to OPFS where the page can write OPFS
 * files, otherwise to an IndexedDB blob store under the same keys. Reads and
 * removals consult both, so media written by either path keeps resolving
 * after an engine update (no silent loss when the write path changes).
 */
export class MediaFileStore implements StorageAdapter<File> {
	private readonly opfs: OPFSAdapter | null;
	private readonly blobs: IndexedDBAdapter<StoredMediaFile>;

	constructor({ projectId }: { projectId: string }) {
		this.opfs = OPFSAdapter.isSupported()
			? new OPFSAdapter(`media-files-${projectId}`)
			: null;
		this.blobs = new IndexedDBAdapter<StoredMediaFile>({
			dbName: `video-editor-media-files-${projectId}`,
			storeName: "media-files",
			version: 1,
		});
	}

	async get(key: string): Promise<File | null> {
		if (this.opfs) {
			try {
				const file = await this.opfs.get(key);
				if (file) return file;
			} catch {
				// Not readable through OPFS here: the blob store may hold it.
			}
		}
		const stored = await this.blobs.get(key);
		if (!stored) return null;
		return new File([stored.blob], stored.name, {
			type: stored.type,
			lastModified: stored.lastModified,
		});
	}

	async set({ key, value }: { key: string; value: File }): Promise<void> {
		if (this.opfs && canWriteOpfsFiles()) {
			await this.opfs.set({ key, value });
			return;
		}
		await this.blobs.set({
			key,
			value: {
				blob: value,
				name: value.name,
				type: value.type,
				lastModified: value.lastModified,
			},
		});
	}

	async remove(key: string): Promise<void> {
		if (this.opfs) {
			try {
				await this.opfs.remove(key);
			} catch {
				// Nothing removable through OPFS here.
			}
		}
		await this.blobs.remove(key);
	}

	async list(): Promise<string[]> {
		const keys = new Set<string>(await this.blobs.list());
		if (this.opfs) {
			try {
				for (const key of await this.opfs.list()) keys.add(key);
			} catch {
				// OPFS directory not listable here.
			}
		}
		return [...keys];
	}

	async clear(): Promise<void> {
		if (this.opfs) {
			try {
				await this.opfs.clear();
			} catch {
				// Nothing to clear through OPFS here.
			}
		}
		await this.blobs.clear();
	}
}
