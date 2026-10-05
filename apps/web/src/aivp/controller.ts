import { EditorCore } from "@/core";
import type { SaveManagerStatus } from "@/core/managers/save-manager";
import { BatchCommand } from "@/commands";
import { InsertElementCommand } from "@/commands/timeline";
import { loadFontAtlas } from "@/fonts/google-fonts";
import { processMediaAssets } from "@/media/processing";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";
import { storageService } from "@/services/storage/service";
import { buildElementFromMedia, hasMediaId } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import {
	aivpBridge,
	errorText,
	type AivpAccessState,
	type AivpBridgeError,
	type AivpEditorBridge,
	type AivpHostEvent,
	type AivpManifestEntry,
	type AivpSnapshot,
} from "./bridge";
import {
	emptyRecord,
	readSyncRecord,
	withRecoveryCopy,
	writeSyncRecord,
	type LocalSyncRecord,
} from "./local-state";
import {
	buildSnapshot,
	describeMedia,
	parseSnapshot,
	projectHash,
	SNAPSHOT_MAX_BYTES,
} from "./snapshot";
import { aivpState, useAivpStore, type MissingMedia } from "./store";

const UPLOAD_DEBOUNCE_MS = 2_500;
const UPLOAD_RETRY_MIN_MS = 5_000;
const UPLOAD_RETRY_MAX_MS = 60_000;
const HEARTBEAT_MS = 45_000;
const CLOSE_SYNC_TIMEOUT_MS = 8_000;
const MEDIA_IMPORT_CONCURRENCY = 2;

const STOPPING_CODES = new Set<AivpBridgeError["code"]>([
	"revoked",
	"signed_out",
	"session_expired",
	"forbidden",
	"not_found",
]);

function accessFor(error: AivpBridgeError): AivpAccessState | null {
	switch (error.code) {
		case "revoked":
		case "forbidden":
		case "not_found":
			return "revoked";
		case "signed_out":
			return "signed_out";
		case "session_expired":
			return "expired";
		case "offline":
			return "offline";
		default:
			return null;
	}
}

export interface SnapshotSummary {
	sceneCount: number;
	trackCount: number;
	clipCount: number;
	textCount: number;
	mediaCount: number;
}

/** What a snapshot's project contains (counts only; read-only). */
function summarise(project: Record<string, unknown>, mediaCount: number): SnapshotSummary {
	const scenes = Array.isArray(project.scenes) ? (project.scenes as Array<{ tracks?: Record<string, unknown> }>) : [];
	let trackCount = 0;
	let clipCount = 0;
	let textCount = 0;
	for (const scene of scenes) {
		const tracks = scene.tracks ?? {};
		const all = [tracks.main, ...(Array.isArray(tracks.overlay) ? tracks.overlay : []), ...(Array.isArray(tracks.audio) ? tracks.audio : [])];
		for (const track of all) {
			const elements = (track as { elements?: unknown } | undefined)?.elements;
			if (!Array.isArray(elements)) continue;
			trackCount += 1;
			for (const element of elements as Array<{ type?: unknown }>) {
				clipCount += 1;
				if (element.type === "text") textCount += 1;
			}
		}
	}
	return { sceneCount: scenes.length, trackCount, clipCount, textCount, mediaCount };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
	]);
}

/**
 * Drives one AIVP editing session inside the OpenCut editor:
 *
 * - opens the episode's stable edit workspace (OpenCut project id = edit
 *   workspace id) and reconciles local IndexedDB state with the latest
 *   server snapshot without ever silently replacing newer server work with
 *   stale local data or dropping unsynced local work;
 * - mirrors OpenCut's local autosave into versioned server snapshots with
 *   optimistic concurrency (base revision) and idempotent retries;
 * - adds the episode's manifest media to the media bin (stable ids, no
 *   duplicates, existing clips untouched);
 * - answers host close requests after flushing.
 */
export class AivpEditorController {
	private bridge: AivpEditorBridge;
	private token = "";
	private record: LocalSyncRecord | null = null;
	private uploadTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private retryDelay = UPLOAD_RETRY_MIN_MS;
	private uploading: Promise<void> | null = null;
	private lastSavedGeneration = 0;
	private disposers: Array<() => void> = [];
	private closing = false;

	constructor(bridge: AivpEditorBridge) {
		this.bridge = bridge;
	}

	static create(): AivpEditorController | null {
		const bridge = aivpBridge();
		return bridge ? new AivpEditorController(bridge) : null;
	}

	getToken(): string {
		return this.token;
	}

	getBridge(): AivpEditorBridge {
		return this.bridge;
	}

	private get editor(): EditorCore {
		return EditorCore.getInstance();
	}

	private workspaceId(): string {
		const workspace = aivpState().workspace;
		if (!workspace) throw new Error("No edit workspace");
		return workspace.workspaceId;
	}

	// ---- lifecycle -------------------------------------------------------------------------------

	/** Runs the open flow once per window (repeat calls share it). */
	start(): Promise<void> {
		this.startPromise ??= this.run();
		return this.startPromise;
	}

	private startPromise: Promise<void> | null = null;

	private async run(): Promise<void> {
		const store = useAivpStore.getState();
		store.set({ phase: "booting", failure: null });
		const booted = await this.bridge.bootstrap();
		if (!booted.ok) {
			store.set({ phase: "failed", failure: errorText(booted.error) });
			return;
		}
		this.token = booted.data.session.token;
		store.set({
			workspace: booted.data.workspace,
			access: booted.data.session.access,
			phase: "opening",
		});
		this.disposers.push(this.bridge.onEvent((event) => this.onHostEvent(event)));
		try {
			await this.openProject();
		} catch (error) {
			store.set({
				phase: "failed",
				failure: error instanceof Error ? error.message : "无法打开剪辑工程",
			});
			return;
		}
		this.disposers.push(
			this.editor.save.subscribeStatus((status) => this.onSaveStatus(status)),
		);
		this.onSaveStatus(this.editor.save.getStatus());
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
		useAivpStore.getState().set({ phase: "ready" });
		loadFontAtlas();
		void this.syncMedia();
	}

	dispose(): void {
		for (const dispose of this.disposers) dispose();
		this.disposers = [];
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.uploadTimer = null;
		this.heartbeatTimer = null;
	}

	/**
	 * Reconciles local state with the server:
	 * - no local project: open the latest server snapshot, or start a new
	 *   project bound to the workspace id when the server has none;
	 * - local project equal to what the server held at its base: take a newer
	 *   server snapshot, otherwise keep local;
	 * - unsynced local work on the same base: keep it and upload it;
	 * - unsynced local work while the server moved on: keep local loaded,
	 *   pause server sync and ask the user (conflict).
	 */
	private async openProject(): Promise<void> {
		const editor = this.editor;
		const workspace = aivpState().workspace;
		if (!workspace) throw new Error("No edit workspace");
		const workspaceId = workspace.workspaceId;

		await initializeGpuRenderer();
		editor.renderer.setDegraded(!isGpuAvailable());

		this.record = (await readSyncRecord(workspaceId)) ?? emptyRecord(workspaceId);
		const latest = await this.bridge.snapshots.latest(this.token);
		let server: AivpSnapshot | null = null;
		let serverReachable = true;
		if (latest.ok) {
			server = latest.data;
		} else {
			const access = accessFor(latest.error);
			if (access === "offline") {
				serverReachable = false;
			} else {
				throw new Error(errorText(latest.error));
			}
		}

		const local = await storageService.loadProject({ id: workspaceId });
		if (!local) {
			if (!serverReachable) {
				throw new Error(
					"无法连接服务器，且本机没有这一集的剪辑数据。请恢复网络后重新打开。",
				);
			}
			if (server) {
				await this.importServerSnapshot(server);
			} else {
				await editor.project.createNewProject({
					name: this.projectTitle(),
					id: workspaceId,
				});
				this.record = emptyRecord(workspaceId);
				await writeSyncRecord(this.record);
			}
			await editor.project.loadProject({ id: workspaceId });
			if (server) await this.adoptLoadedAsSynced(server.revisionNumber);
			this.setServer({
				phase: server || !serverReachable ? "synced" : "pending",
				revision: server?.revisionNumber ?? 0,
			});
			if (!server) this.scheduleUpload(UPLOAD_DEBOUNCE_MS);
			return;
		}

		const localSerialized = storageService.serializeProject({
			project: local.project,
		}) as unknown as Record<string, unknown>;
		const localHash = await projectHash(localSerialized);
		const unsynced = localHash !== this.record.syncedProjectHash;

		if (!serverReachable) {
			await editor.project.loadProject({ id: workspaceId });
			this.setServer({
				phase: "offline",
				revision: this.record.baseRevision,
				error: "无法连接服务器，正在使用本机保存的剪辑",
			});
			return;
		}

		if (server === null) {
			// The server holds nothing yet (or lost it): local work becomes the first version.
			if (this.record.baseRevision !== 0) {
				this.record = { ...this.record, baseRevision: 0 };
				await writeSyncRecord(this.record);
			}
			await editor.project.loadProject({ id: workspaceId });
			this.setServer({ phase: "pending", revision: 0 });
			this.scheduleUpload(UPLOAD_DEBOUNCE_MS);
			return;
		}

		if (!unsynced) {
			if (server.revisionNumber !== this.record.baseRevision) {
				await this.importServerSnapshot(server);
				await editor.project.loadProject({ id: workspaceId });
				await this.adoptLoadedAsSynced(server.revisionNumber);
			} else {
				await editor.project.loadProject({ id: workspaceId });
			}
			this.setServer({ phase: "synced", revision: server.revisionNumber });
			return;
		}

		await editor.project.loadProject({ id: workspaceId });
		if (server.revisionNumber === this.record.baseRevision) {
			this.setServer({ phase: "pending", revision: server.revisionNumber });
			this.scheduleUpload(500);
			return;
		}
		// The server already holds exactly this content (e.g. the local record write was lost after an upload).
		let serverHash: string | null = null;
		try {
			serverHash = await projectHash(
				parseSnapshot({ content: server.content, workspaceId }).project,
			);
		} catch {
			serverHash = null;
		}
		if (serverHash === localHash) {
			this.record = {
				...this.record,
				baseRevision: server.revisionNumber,
				syncedProjectHash: localHash,
				lastSyncedAt: Date.now(),
			};
			await writeSyncRecord(this.record);
			this.setServer({ phase: "synced", revision: server.revisionNumber });
			return;
		}
		// Unsynced local work AND a newer server version: never pick one silently.
		useAivpStore.getState().set({
			conflict: {
				server,
				localBaseRevision: this.record.baseRevision,
				origin: "open",
			},
		});
		this.setServer({
			phase: "conflict",
			revision: server.revisionNumber,
			error: null,
		});
	}

	private projectTitle(): string {
		const workspace = aivpState().workspace;
		if (!workspace) return "剪辑工程";
		const number = workspace.episodeNumber ?? workspace.episodeOrdinal;
		return `${workspace.projectName} · 第 ${number} 集${workspace.episodeTitle ? ` ${workspace.episodeTitle}` : ""}`;
	}

	/** Writes a server snapshot into local storage (the caller loads it). */
	private async importServerSnapshot(server: AivpSnapshot): Promise<void> {
		const document = parseSnapshot({
			content: server.content,
			workspaceId: this.workspaceId(),
		});
		await this.editor.project.importSerializedProject({
			serialized: document.project,
		});
	}

	/** After loading a server snapshot: the local project equals the server at `revision`. */
	private async adoptLoadedAsSynced(revision: number): Promise<void> {
		const serialized = this.editor.project.serializeActiveProject();
		if (!serialized || !this.record) return;
		this.record = {
			...this.record,
			baseRevision: revision,
			syncedProjectHash: await projectHash(serialized),
			lastSyncedAt: Date.now(),
		};
		await writeSyncRecord(this.record);
	}

	// ---- local save → server sync ----------------------------------------------------------------

	private onSaveStatus(status: SaveManagerStatus): void {
		useAivpStore.getState().set({
			localSave: {
				phase: status.phase,
				error: status.lastError,
				lastSavedAt: status.lastSavedAt,
			},
		});
		if (status.savedGeneration > this.lastSavedGeneration) {
			this.lastSavedGeneration = status.savedGeneration;
			const server = aivpState().server;
			if (server.phase === "synced") this.setServer({ phase: "pending" });
			this.scheduleUpload(UPLOAD_DEBOUNCE_MS);
		}
	}

	private canSync(): boolean {
		const state = aivpState();
		return (
			state.access === "active" &&
			state.conflict === null &&
			state.workspace?.permissions.edit === true &&
			state.server.phase !== "stopped"
		);
	}

	private scheduleUpload(delay: number): void {
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			void this.uploadNow();
		}, delay);
	}

	/**
	 * Uploads the locally persisted project as a new server snapshot based on
	 * the last synced revision (or `overrideBase` after an explicit conflict
	 * decision). The content is captured first and local autosave is flushed
	 * afterwards, so the server never holds anything newer than local storage.
	 */
	uploadNow({ overrideBase }: { overrideBase?: number } = {}): Promise<void> {
		if (this.uploading) return this.uploading;
		if (overrideBase === undefined && !this.canSync()) return Promise.resolve();
		const run = this.performUpload(overrideBase).finally(() => {
			this.uploading = null;
		});
		this.uploading = run;
		return run;
	}

	private async performUpload(overrideBase?: number): Promise<void> {
		const record = this.record;
		const workspace = aivpState().workspace;
		if (!record || !workspace) return;
		const serialized = this.editor.project.serializeActiveProject();
		if (!serialized) return;
		const manifestIds = new Set(
			(aivpState().manifest?.entries ?? []).map((entry) => entry.entryId),
		);
		const snapshot = await buildSnapshot({
			workspaceId: workspace.workspaceId,
			serialized,
			media: describeMedia({
				assets: this.editor.media.getAssets(),
				manifestEntryIds: manifestIds,
				serialized,
			}),
		});
		if (overrideBase === undefined && snapshot.projectHash === record.syncedProjectHash) {
			this.setServer({ phase: "synced", error: null });
			return;
		}
		try {
			await this.editor.save.flush();
		} catch (error) {
			this.setServer({
				phase: "error",
				error: `本机保存失败，暂不上传：${error instanceof Error ? error.message : "未知错误"}`,
			});
			this.scheduleRetry();
			return;
		}
		if (new TextEncoder().encode(snapshot.content).byteLength > SNAPSHOT_MAX_BYTES) {
			this.setServer({
				phase: "error",
				error: "剪辑工程数据超过服务器版本大小上限，已保存在本机",
			});
			return;
		}
		const base = overrideBase ?? record.baseRevision;
		this.setServer({ phase: "syncing", error: null });
		const result = await this.bridge.snapshots.save(this.token, {
			baseRevision: base,
			idempotencyKey: `snap-${base}-${snapshot.contentSha256.slice(0, 48)}`,
			content: snapshot.content,
			contentSha256: snapshot.contentSha256,
			editorVersion: snapshot.editorVersion,
			mediaEntryIds: snapshot.mediaEntryIds,
			durationMs: snapshot.durationMs,
		});
		if (result.ok) {
			this.record = {
				...record,
				baseRevision: result.data.revisionNumber,
				syncedProjectHash: snapshot.projectHash,
				lastSyncedAt: Date.now(),
			};
			try {
				await writeSyncRecord(this.record);
			} catch {
				// The server has the version; a stale local record only causes a later no-op/conflict check.
			}
			this.retryDelay = UPLOAD_RETRY_MIN_MS;
			useAivpStore.getState().set({ conflict: null });
			this.setServer({
				phase: "synced",
				revision: result.data.revisionNumber,
				lastSyncedAt: Date.now(),
				error: null,
			});
			// Edits saved while uploading are sent next.
			const latest = this.editor.project.serializeActiveProject();
			if (latest && (await projectHash(latest)) !== snapshot.projectHash) {
				this.setServer({ phase: "pending" });
				this.scheduleUpload(UPLOAD_DEBOUNCE_MS);
			}
			return;
		}
		const error = result.error;
		if (error.code === "conflict" && error.conflict) {
			useAivpStore.getState().set({
				conflict: { server: error.conflict, localBaseRevision: base, origin: "upload" },
			});
			this.setServer({ phase: "conflict", revision: error.conflict.revisionNumber });
			return;
		}
		const access = accessFor(error);
		if (access !== null && access !== "offline") {
			this.setAccess(access, errorText(error));
			return;
		}
		this.setServer({
			phase: access === "offline" ? "offline" : "error",
			error: errorText(error),
		});
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		const delay = this.retryDelay;
		this.retryDelay = Math.min(UPLOAD_RETRY_MAX_MS, this.retryDelay * 2);
		this.scheduleUpload(delay);
	}

	/**
	 * Explicit conflict decision.
	 * - `server`: load the newer server version; unsynced local content is
	 *   kept as a local recovery copy (never discarded).
	 * - `local`: upload the local project as a NEW server version on top of
	 *   the current one (the newer server version stays in history).
	 */
	async resolveConflict(choice: "server" | "local"): Promise<void> {
		const conflict = aivpState().conflict;
		if (!conflict || !this.record) return;
		if (choice === "local") {
			useAivpStore.getState().set({ conflict: null });
			await this.uploadNow({ overrideBase: conflict.server.revisionNumber });
			return;
		}
		const latest = await this.bridge.snapshots.latest(this.token);
		if (!latest.ok || latest.data === null) {
			this.setServer({
				phase: "error",
				error: latest.ok ? "服务器没有可加载的版本" : errorText(latest.error),
			});
			return;
		}
		const localContent = this.editor.project.serializeActiveProject();
		if (localContent) {
			this.record = withRecoveryCopy(this.record, {
				savedAt: Date.now(),
				baseRevision: this.record.baseRevision,
				reason: "server_version_chosen",
				content: JSON.stringify(localContent),
			});
			await writeSyncRecord(this.record);
		}
		try {
			await this.editor.save.flush();
		} catch {
			// The recovery copy above already holds the local content.
		}
		await this.importServerSnapshot(latest.data);
		await this.editor.project.loadProject({ id: this.workspaceId() });
		await this.adoptLoadedAsSynced(latest.data.revisionNumber);
		useAivpStore.getState().set({
			conflict: null,
			notice: "已加载服务器版本；本机未同步的内容已保存为恢复副本",
		});
		this.setServer({ phase: "synced", revision: latest.data.revisionNumber, error: null });
		void this.syncMedia();
	}

	/** Restores the most recent recovery copy as the working project (it then syncs as a new version). */
	async restoreRecoveryCopy(): Promise<void> {
		const record = this.record;
		const copy = record?.recoveryCopies[0];
		if (!record || !copy) return;
		const serialized = JSON.parse(copy.content) as Record<string, unknown>;
		await this.editor.project.importSerializedProject({ serialized });
		await this.editor.project.loadProject({ id: this.workspaceId() });
		this.record = { ...record, recoveryCopies: record.recoveryCopies.slice(1) };
		await writeSyncRecord(this.record);
		useAivpStore.getState().set({ notice: "已恢复本机副本，将作为新版本同步" });
		this.editor.save.markDirty({ force: true });
	}

	// ---- version history -------------------------------------------------------------------------

	/** Server versions of this episode's edit, newest first (read-only). */
	async listHistory(page = 1) {
		const result = await this.bridge.snapshots.list(this.token, page);
		if (!result.ok) {
			const access = accessFor(result.error);
			if (access !== null && access !== "offline") this.setAccess(access, errorText(result.error));
		}
		return result;
	}

	/** Loads one version and summarises what it contains (nothing is changed). */
	async inspectSnapshot(snapshotId: string): Promise<
		| { ok: true; snapshot: AivpSnapshot; summary: SnapshotSummary }
		| { ok: false; message: string }
	> {
		const result = await this.bridge.snapshots.get(this.token, snapshotId);
		if (!result.ok) return { ok: false, message: errorText(result.error) };
		try {
			const document = parseSnapshot({ content: result.data.content, workspaceId: this.workspaceId() });
			return { ok: true, snapshot: result.data, summary: summarise(document.project, document.media.length) };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : "无法读取该版本" };
		}
	}

	/**
	 * Explicitly recovers an earlier server version as a NEW version on top of
	 * the current one: the old content is loaded into the editor and uploaded
	 * with the current server revision as its base. Nothing is overwritten:
	 * every server version stays in history, unsynced local work is kept as a
	 * local recovery copy first, and a concurrent newer save is a conflict.
	 */
	async recoverSnapshot(snapshotId: string): Promise<{ ok: true; revision: number } | { ok: false; message: string }> {
		const state = aivpState();
		if (state.access !== "active") return { ok: false, message: state.accessMessage ?? "当前无法连接服务器，不能恢复历史版本" };
		if (state.workspace?.permissions.edit !== true) return { ok: false, message: "没有剪辑编辑权限" };
		if (state.conflict !== null) return { ok: false, message: "请先处理当前的版本冲突" };
		if (!this.record) return { ok: false, message: "剪辑工程尚未打开" };
		const inspected = await this.inspectSnapshot(snapshotId);
		if (!inspected.ok) return inspected;
		if (this.uploadTimer) clearTimeout(this.uploadTimer);
		this.uploadTimer = null;
		if (this.uploading) await this.uploading.catch(() => undefined);
		const latest = await this.listHistory(1);
		if (!latest.ok) return { ok: false, message: errorText(latest.error) };
		const currentRevision = latest.data.items[0]?.revisionNumber ?? 0;
		try {
			await this.editor.save.flush();
		} catch {
			return { ok: false, message: "本机保存失败，未恢复历史版本（当前修改仍保留在编辑器中）" };
		}
		const serialized = this.editor.project.serializeActiveProject();
		if (serialized && (await projectHash(serialized)) !== this.record.syncedProjectHash) {
			this.record = withRecoveryCopy(this.record, {
				savedAt: Date.now(),
				baseRevision: this.record.baseRevision,
				reason: "conflict",
				content: JSON.stringify(serialized),
			});
			await writeSyncRecord(this.record);
		}
		await this.importServerSnapshot(inspected.snapshot);
		await this.editor.project.loadProject({ id: this.workspaceId() });
		this.record = { ...this.record, baseRevision: currentRevision };
		await writeSyncRecord(this.record);
		await this.uploadNow({ overrideBase: currentRevision });
		void this.syncMedia();
		const server = aivpState().server;
		if (server.phase !== "synced") {
			return { ok: false, message: server.error ?? "历史版本已载入本机，但尚未保存为服务器新版本；稍后会继续同步" };
		}
		useAivpStore.getState().set({ notice: `已将第 ${inspected.snapshot.revisionNumber} 版恢复为新的第 ${server.revision} 版` });
		return { ok: true, revision: server.revision };
	}

	recoveryCopyCount(): number {
		return this.record?.recoveryCopies.length ?? 0;
	}

	// ---- media bin sync --------------------------------------------------------------------------

	/**
	 * Adds manifest media to the media bin. Entry id = OpenCut media id, so
	 * re-syncing never duplicates; newly adopted versions arrive as new media
	 * while clips keep the version they reference. Tracks are never touched.
	 * Older versions are imported only when the timeline references them
	 * (missing-media recovery). One failure never removes earlier imports.
	 */
	async syncMedia({ only }: { only?: readonly string[] } = {}): Promise<void> {
		const store = useAivpStore.getState();
		if (store.mediaSyncing) return;
		if (store.access !== "active") {
			this.computeMissing();
			return;
		}
		store.set({ mediaSyncing: true, manifestError: null });
		try {
			const manifest = await this.bridge.manifest.sync(this.token);
			if (!manifest.ok) {
				useAivpStore.getState().set({ manifestError: errorText(manifest.error) });
				const access = accessFor(manifest.error);
				if (access !== null && access !== "offline") this.setAccess(access, errorText(manifest.error));
				return;
			}
			useAivpStore.getState().set({ manifest: manifest.data });
			const present = new Set(this.editor.media.getAssets().map((asset) => asset.id));
			const referenced = this.referencedMediaIds();
			const timelineEmpty = this.isTimelineEmpty();
			const candidates = manifest.data.entries.filter((entry) =>
				only ? only.includes(entry.entryId) : entry.current || referenced.has(entry.entryId),
			);
			for (const entry of manifest.data.entries) {
				if (present.has(entry.entryId)) {
					aivpState().setMediaState(entry.entryId, { status: "imported" });
				} else if (!candidates.includes(entry)) {
					aivpState().setMediaState(entry.entryId, { status: "not_imported" });
				}
			}
			const queue = candidates.filter((entry) => !present.has(entry.entryId));
			for (const entry of queue) aivpState().setMediaState(entry.entryId, { status: "queued" });
			const workers = Array.from({ length: Math.min(MEDIA_IMPORT_CONCURRENCY, queue.length) }, async () => {
				for (;;) {
					const entry = queue.shift();
					if (!entry) return;
					await this.importEntry(entry, { ratchetFps: timelineEmpty });
				}
			});
			await Promise.all(workers);
		} finally {
			useAivpStore.getState().set({ mediaSyncing: false });
			this.computeMissing();
		}
	}

	private async importEntry(
		entry: AivpManifestEntry,
		{ ratchetFps }: { ratchetFps: boolean },
	): Promise<boolean> {
		const fail = (message: string): false => {
			aivpState().setMediaState(entry.entryId, { status: "failed", message });
			return false;
		};
		aivpState().setMediaState(entry.entryId, {
			status: "downloading",
			receivedBytes: 0,
			totalBytes: entry.byteLength,
		});
		const cached = await this.bridge.media.ensure(this.token, entry.entryId);
		if (!cached.ok) return fail(errorText(cached.error));
		let blob: Blob;
		try {
			const response = await fetch(cached.data.url);
			if (!response.ok) return fail("本机缓存读取失败");
			blob = await response.blob();
		} catch {
			return fail("本机缓存读取失败");
		}
		if (blob.size !== cached.data.byteLength) return fail("缓存文件大小与清单不一致");
		const file = new File([blob], entry.title, { type: cached.data.contentType });
		const processed = await processMediaAssets({ files: [file] });
		const asset = processed[0];
		if (!asset) return fail("编辑器无法识别该媒体（类型或编码不受支持）");
		let storageError: unknown = null;
		const added = await this.editor.media.addMediaAsset({
			projectId: this.workspaceId(),
			asset: { ...asset, name: entry.title },
			id: entry.entryId,
			ratchetFps,
			onError: (error) => {
				storageError = error;
			},
		});
		if (!added) {
			return fail(
				storageError instanceof Error ? `写入编辑器存储失败：${storageError.message}` : "写入编辑器存储失败",
			);
		}
		aivpState().setMediaState(entry.entryId, { status: "imported" });
		return true;
	}

	private referencedMediaIds(): Set<string> {
		const ids = new Set<string>();
		for (const scene of this.editor.scenes.getScenes()) {
			const tracks = scene.tracks;
			for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
				for (const element of track.elements) {
					if (hasMediaId(element)) ids.add(element.mediaId);
				}
			}
		}
		return ids;
	}

	isTimelineEmpty(): boolean {
		const scene = this.editor.scenes.getActiveSceneOrNull();
		if (!scene) return true;
		const tracks = scene.tracks;
		return (
			tracks.main.elements.length === 0 &&
			tracks.overlay.every((track) => track.elements.length === 0) &&
			tracks.audio.every((track) => track.elements.length === 0)
		);
	}

	/** Clips whose media is not in the bin (cache or local file lost). The project itself is never altered. */
	computeMissing(): MissingMedia[] {
		const present = new Set(this.editor.media.getAssets().map((asset) => asset.id));
		const manifest = new Set((aivpState().manifest?.entries ?? []).map((entry) => entry.entryId));
		const missing = new Map<string, MissingMedia>();
		for (const scene of this.editor.scenes.getScenes()) {
			const tracks = scene.tracks;
			for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
				for (const element of track.elements) {
					if (!hasMediaId(element) || present.has(element.mediaId)) continue;
					if (!missing.has(element.mediaId)) {
						missing.set(element.mediaId, {
							mediaId: element.mediaId,
							name: element.name,
							recoverable: manifest.has(element.mediaId),
						});
					}
				}
			}
		}
		const list = [...missing.values()];
		useAivpStore.getState().set({ missing: list });
		return list;
	}

	/** Controlled re-download of missing manifest media (the edit project is untouched). */
	async recoverMissing(): Promise<void> {
		const ids = this.computeMissing().filter((item) => item.recoverable).map((item) => item.mediaId);
		if (ids.length > 0) await this.syncMedia({ only: ids });
	}

	/**
	 * Explicit user action on an EMPTY timeline only: lays the current shot
	 * media out in shot order (video, or the keyframe for the shot duration
	 * when there is no video) with each shot's audio aligned below. One undo
	 * step. Never runs as part of syncing.
	 */
	async populateTimeline(): Promise<void> {
		if (!this.isTimelineEmpty()) {
			useAivpStore.getState().set({ notice: "时间线已有内容，未做任何修改" });
			return;
		}
		const manifest = aivpState().manifest;
		if (!manifest) return;
		const ordered = manifest.entries
			.filter((entry) => entry.current && entry.order !== null && entry.shotId !== null)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		const shots = new Map<string, { visual: AivpManifestEntry | null; audio: AivpManifestEntry | null; durationMs: number | null; order: number }>();
		for (const entry of ordered) {
			const key = entry.shotId as string;
			const current = shots.get(key) ?? { visual: null, audio: null, durationMs: entry.shotDurationMs, order: entry.order ?? 0 };
			if (entry.role === "shot_video") current.visual = entry;
			else if (entry.role === "shot_keyframe" && current.visual?.role !== "shot_video") current.visual = entry;
			else if (entry.role === "shot_audio") current.audio = entry;
			shots.set(key, current);
		}
		const needed = [...shots.values()].flatMap((shot) => [shot.visual, shot.audio]).filter((entry): entry is AivpManifestEntry => entry !== null);
		const present = new Set(this.editor.media.getAssets().map((asset) => asset.id));
		const missing = needed.filter((entry) => !present.has(entry.entryId)).map((entry) => entry.entryId);
		if (missing.length > 0) await this.syncMedia({ only: missing });
		if (!this.isTimelineEmpty()) {
			useAivpStore.getState().set({ notice: "时间线已有内容，未做任何修改" });
			return;
		}
		const assets = new Map(this.editor.media.getAssets().map((asset) => [asset.id, asset]));
		const scene = this.editor.scenes.getActiveScene();
		const commands: InsertElementCommand[] = [];
		let cursorSeconds = 0;
		let placed = 0;
		for (const shot of [...shots.values()].sort((a, b) => a.order - b.order)) {
			const visual = shot.visual ? assets.get(shot.visual.entryId) : undefined;
			const fallbackSeconds = (shot.durationMs ?? 3_000) / 1000;
			const seconds = visual?.type === "video" && visual.duration ? visual.duration : fallbackSeconds;
			const startTime = mediaTimeFromSeconds({ seconds: cursorSeconds });
			const duration = mediaTimeFromSeconds({ seconds });
			if (visual) {
				commands.push(
					new InsertElementCommand({
						element: buildElementFromMedia({ mediaId: visual.id, mediaType: visual.type, name: visual.name, duration, startTime }),
						placement: { mode: "explicit", trackId: scene.tracks.main.id },
					}),
				);
				placed += 1;
			}
			const audio = shot.audio ? assets.get(shot.audio.entryId) : undefined;
			if (audio) {
				const audioSeconds = audio.duration ? Math.min(audio.duration, seconds) : seconds;
				commands.push(
					new InsertElementCommand({
						element: buildElementFromMedia({
							mediaId: audio.id,
							mediaType: "audio",
							name: audio.name,
							duration: mediaTimeFromSeconds({ seconds: audioSeconds }),
							startTime,
							buffer: new AudioBuffer({ length: 1, sampleRate: 44_100 }),
						}),
						placement: { mode: "auto", trackType: "audio" },
					}),
				);
			}
			if (visual || audio) cursorSeconds += seconds;
		}
		if (commands.length === 0) {
			useAivpStore.getState().set({ notice: "本集还没有已采用的镜头素材可铺入" });
			return;
		}
		this.editor.command.execute({ command: new BatchCommand(commands) });
		useAivpStore.getState().set({ notice: `已按镜头顺序铺入 ${placed} 个画面片段，可撤销` });
	}

	// ---- host events, heartbeat and close --------------------------------------------------------

	private setServer(partial: Partial<ReturnType<typeof aivpState>["server"]>): void {
		const state = aivpState();
		state.set({ server: { ...state.server, ...partial } });
	}

	private setAccess(access: AivpAccessState, message: string | null): void {
		const state = aivpState();
		state.set({ access, accessMessage: message });
		if (access === "active") {
			// Server-confirmed again (reconnected, re-verified after sleep, same account signed back in).
			if (state.server.phase === "offline" || state.server.phase === "error" || state.server.phase === "stopped") {
				this.setServer({ phase: "pending", error: null });
				this.scheduleUpload(500);
			}
			return;
		}
		if (access !== "offline") {
			if (this.uploadTimer) clearTimeout(this.uploadTimer);
			this.uploadTimer = null;
			this.setServer({ phase: "stopped", error: message });
		} else {
			this.setServer({ phase: "offline", error: message });
		}
	}

	private onHostEvent(event: AivpHostEvent): void {
		switch (event.type) {
			case "access":
				this.setAccess(event.access, event.message);
				break;
			case "close-requested":
				void this.handleCloseRequest();
				break;
			case "media-progress":
				aivpState().setMediaState(event.entryId, {
					status: "downloading",
					receivedBytes: event.receivedBytes,
					totalBytes: event.totalBytes,
				});
				break;
			default:
				break;
		}
	}

	private async heartbeat(): Promise<void> {
		const result = await this.bridge.heartbeat(this.token);
		if (result.ok) {
			this.setAccess(result.data.access, result.data.access === "active" ? null : aivpState().accessMessage);
			return;
		}
		const access = accessFor(result.error);
		if (access !== null) this.setAccess(access, errorText(result.error));
	}

	/**
	 * Host asked to close: persist locally, try to sync within a bounded
	 * time, then let the host close. A failed local save asks first.
	 */
	async handleCloseRequest(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		// Freeze editing while closing: the overlay blocks input and keyboard shortcuts.
		useAivpStore.getState().set({ closing: true });
		try {
			let localSaved = false;
			for (let attempt = 0; attempt < 3 && !localSaved; attempt++) {
				try {
					await this.editor.save.flush();
				} catch {
					break;
				}
				// Saved means the save manager is clean NOW, not merely that one flush resolved.
				localSaved = !this.editor.save.getIsDirty();
			}
			if (
				!localSaved &&
				!window.confirm("本机保存失败或仍有未保存的修改，关闭后最近的修改可能丢失。仍要关闭剪辑器吗？")
			) {
				useAivpStore.getState().set({ closing: false });
				return;
			}
			let serverSynced = aivpState().server.phase === "synced";
			if (localSaved && !serverSynced && this.canSync()) {
				await withTimeout(this.uploadNow(), CLOSE_SYNC_TIMEOUT_MS);
				serverSynced = aivpState().server.phase === "synced";
			}
			this.dispose();
			await this.bridge.closeWindow(this.token, { localSaved, serverSynced });
		} finally {
			this.closing = false;
		}
	}

	isStoppedError(error: AivpBridgeError): boolean {
		return STOPPING_CODES.has(error.code);
	}
}
