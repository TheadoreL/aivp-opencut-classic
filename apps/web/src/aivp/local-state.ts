/**
 * Local synchronisation record of one AIVP edit workspace, stored in this
 * editor origin's IndexedDB. The host gives every account on every server
 * its own storage partition, so records (and the OpenCut project/media
 * stores next to them) never mix across accounts or servers; inside a
 * partition the record is keyed by the edit workspace id.
 *
 * `syncedProjectHash` is the project content the server holds at
 * `baseRevision`. Unsynced local work is detected by hashing the locally
 * stored project and comparing with it, never by trusting a flag that a
 * crash could have left stale.
 */

export interface RecoveryCopy {
	savedAt: number;
	baseRevision: number;
	reason: "server_version_chosen" | "conflict";
	content: string;
}

export interface LocalSyncRecord {
	workspaceId: string;
	baseRevision: number;
	syncedProjectHash: string | null;
	lastSyncedAt: number | null;
	/** Local content kept when the user replaced unsynced work with a newer server version. */
	recoveryCopies: RecoveryCopy[];
}

const DB_NAME = "aivp-editor-sync";
const STORE = "workspaces";
const MAX_RECOVERY_COPIES = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			if (!request.result.objectStoreNames.contains(STORE)) {
				request.result.createObjectStore(STORE, { keyPath: "workspaceId" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			dbPromise = null;
			reject(request.error ?? new Error("Local sync storage is unavailable"));
		};
	});
	return dbPromise;
}

async function run<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
	const db = await open();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction(STORE, mode);
		const request = action(transaction.objectStore(STORE));
		transaction.oncomplete = () => resolve(request?.result);
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("Local sync storage failed"));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("Local sync storage aborted"));
	});
}

export async function readSyncRecord(
	workspaceId: string,
): Promise<LocalSyncRecord | null> {
	const value = await run<LocalSyncRecord | undefined>("readonly", (store) =>
		store.get(workspaceId),
	);
	if (!value || typeof value !== "object") return null;
	return {
		workspaceId,
		baseRevision: Number.isInteger(value.baseRevision) ? value.baseRevision : 0,
		syncedProjectHash:
			typeof value.syncedProjectHash === "string"
				? value.syncedProjectHash
				: null,
		lastSyncedAt:
			typeof value.lastSyncedAt === "number" ? value.lastSyncedAt : null,
		recoveryCopies: Array.isArray(value.recoveryCopies)
			? value.recoveryCopies.slice(0, MAX_RECOVERY_COPIES)
			: [],
	};
}

export async function writeSyncRecord(record: LocalSyncRecord): Promise<void> {
	await run("readwrite", (store) =>
		store.put({
			...record,
			recoveryCopies: record.recoveryCopies.slice(0, MAX_RECOVERY_COPIES),
		}),
	);
}

export function withRecoveryCopy(
	record: LocalSyncRecord,
	copy: RecoveryCopy,
): LocalSyncRecord {
	return {
		...record,
		recoveryCopies: [copy, ...record.recoveryCopies].slice(
			0,
			MAX_RECOVERY_COPIES,
		),
	};
}

export function emptyRecord(workspaceId: string): LocalSyncRecord {
	return {
		workspaceId,
		baseRevision: 0,
		syncedProjectHash: null,
		lastSyncedAt: null,
		recoveryCopies: [],
	};
}
