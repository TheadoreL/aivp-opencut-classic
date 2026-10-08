import { create } from "zustand";
import type {
	AivpAccessState,
	AivpHostInfo,
	AivpManifest,
	AivpSnapshotMeta,
	AivpWorkspaceInfo,
} from "./bridge";
import { LEGACY_HOST } from "./bridge";

export type ServerSyncPhase =
	| "starting"
	| "synced"
	| "pending"
	| "syncing"
	| "offline"
	| "conflict"
	| "error"
	| "stopped";

export type LocalSavePhase = "idle" | "dirty" | "saving" | "error";

export type MediaEntryState =
	| { status: "imported" }
	| { status: "queued" }
	| { status: "downloading"; receivedBytes: number; totalBytes: number }
	| { status: "failed"; message: string }
	| { status: "not_imported" };

export interface ConflictState {
	server: AivpSnapshotMeta;
	localBaseRevision: number;
	/** Raised on open (unsynced local work vs newer server) or by a rejected upload. */
	origin: "open" | "upload";
}

export interface MissingMedia {
	mediaId: string;
	name: string;
	/** Manifest-bound media can be re-downloaded; local files must be re-imported by the user. */
	recoverable: boolean;
}

export interface AivpEditorState {
	phase: "booting" | "opening" | "ready" | "failed";
	failure: string | null;
	workspace: AivpWorkspaceInfo | null;
	/** The shell hosting this editor (embedded desktop view, iPad view, or the legacy window). */
	host: AivpHostInfo;
	access: AivpAccessState;
	accessMessage: string | null;
	localSave: { phase: LocalSavePhase; error: string | null; lastSavedAt: number | null };
	server: {
		phase: ServerSyncPhase;
		revision: number;
		lastSyncedAt: number | null;
		error: string | null;
	};
	conflict: ConflictState | null;
	manifest: AivpManifest | null;
	manifestError: string | null;
	mediaSyncing: boolean;
	mediaStates: Record<string, MediaEntryState>;
	missing: MissingMedia[];
	notice: string | null;
	/** The host asked to close: editing is frozen while the last changes are saved. */
	closing: boolean;
	/** The open project is being replaced (history/conflict/recovery): editor panels are unmounted. */
	replacing: boolean;
	set: (partial: Partial<AivpEditorState>) => void;
	setMediaState: (entryId: string, state: MediaEntryState) => void;
}

export const useAivpStore = create<AivpEditorState>((set) => ({
	phase: "booting",
	failure: null,
	workspace: null,
	host: LEGACY_HOST,
	access: "active",
	accessMessage: null,
	localSave: { phase: "idle", error: null, lastSavedAt: null },
	server: { phase: "starting", revision: 0, lastSyncedAt: null, error: null },
	conflict: null,
	manifest: null,
	manifestError: null,
	mediaSyncing: false,
	mediaStates: {},
	missing: [],
	notice: null,
	closing: false,
	replacing: false,
	set: (partial) => set(partial),
	setMediaState: (entryId, state) =>
		set((current) => ({
			mediaStates: { ...current.mediaStates, [entryId]: state },
		})),
}));

export function aivpState(): AivpEditorState {
	return useAivpStore.getState();
}
