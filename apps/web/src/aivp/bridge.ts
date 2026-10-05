/**
 * Typed view of the AIVP desktop editor bridge (`window.aivpEditor`), exposed
 * by the host's editor preload to this origin only. Every call carries the
 * short-lived editing-session token the host issued for THIS window and
 * episode; the host re-checks sender window/frame/origin, token, account,
 * license and project access on every call. There is no generic file, HTTP
 * or process API: only these typed episode operations.
 */

export type AivpBridgeErrorCode =
	| "invalid_request"
	| "forbidden"
	| "not_found"
	| "session_expired"
	| "revoked"
	| "signed_out"
	| "offline"
	| "conflict"
	| "too_large"
	| "integrity"
	| "unsupported_media"
	| "quota"
	| "busy"
	| "write_failed"
	| "cancelled"
	| "server_error";

export interface AivpBridgeError {
	code: AivpBridgeErrorCode;
	message: string;
	/** Server-side conflict detail (current snapshot) when `code` is `conflict`. */
	conflict?: AivpSnapshotMeta | null;
}

export type AivpResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: AivpBridgeError };

export type AivpAccessState =
	| "active"
	| "offline"
	| "revoked"
	| "signed_out"
	| "expired";

export interface AivpWorkspaceInfo {
	workspaceId: string;
	projectId: string;
	projectName: string;
	episodeId: string;
	episodeOrdinal: number;
	episodeNumber: number | null;
	episodeTitle: string | null;
	scriptRevisionId: string;
	finalCutResourceId: string;
	snapshotRevision: number;
	permissions: { edit: boolean; uploadFinalCut: boolean };
}

export interface AivpSession {
	token: string;
	expiresAt: number;
	access: AivpAccessState;
}

export interface AivpSnapshotMeta {
	snapshotId: string;
	revisionNumber: number;
	baseRevisionNumber: number;
	contentSha256: string;
	byteLength: number;
	editorVersion: number;
	durationMs: number;
	createdByUserId: string;
	createdByDisplayName: string | null;
	createdAt: string;
}

export interface AivpSnapshot extends AivpSnapshotMeta {
	content: string;
}

export type AivpMediaRole =
	| "shot_video"
	| "shot_keyframe"
	| "shot_audio"
	| "asset_reference";

export interface AivpManifestEntry {
	entryId: string;
	role: AivpMediaRole;
	mediaKind: "video" | "image" | "audio";
	resourceId: string;
	revisionId: string;
	revisionNumber: number;
	shotId: string | null;
	sceneId: string | null;
	assetId: string | null;
	/** Display order inside the episode (scene, then shot); null for entries no longer in the storyboard. */
	order: number | null;
	shotPosition: number | null;
	shotDurationMs: number | null;
	title: string;
	contentType: string;
	byteLength: number;
	sha256: string;
	/** True while this revision is the adopted version of its source slot. */
	current: boolean;
	firstSeenAt: string;
}

export interface AivpManifest {
	workspaceId: string;
	entries: AivpManifestEntry[];
	/** Sources that exist but cannot be offered (e.g. simulated results, unsupported type). */
	skipped: { resourceId: string; reason: string }[];
	generatedAt: string;
}

export interface AivpCachedMedia {
	entryId: string;
	/** Scoped URL on the editor origin, valid for this editing session only. */
	url: string;
	contentType: string;
	byteLength: number;
	sha256: string;
}

export interface AivpExportJob {
	jobId: string;
	maxBytes: number;
	chunkMaxBytes: number;
}

export interface AivpExportFile {
	exportId: string;
	fileName: string;
	byteLength: number;
	sha256: string;
}

export interface AivpExportDetails {
	format: "mp4" | "webm";
	videoCodec: "avc" | "vp9";
	audioCodec: "aac" | "opus" | null;
	width: number;
	height: number;
	fpsNumerator: number;
	fpsDenominator: number;
	durationMs: number;
	frameCount: number;
}

export interface AivpFinalCutUpload {
	resourceId: string;
	revisionId: string;
	revisionNumber: number;
}

export type AivpHostEvent =
	| { type: "access"; access: AivpAccessState; message: string | null }
	| { type: "close-requested" }
	| {
			type: "upload-progress";
			exportId: string;
			sentBytes: number;
			totalBytes: number;
	  }
	| { type: "media-progress"; entryId: string; receivedBytes: number; totalBytes: number };

export interface AivpEditorBridge {
	bootstrap(): Promise<
		AivpResult<{ session: AivpSession; workspace: AivpWorkspaceInfo }>
	>;
	heartbeat(token: string): Promise<AivpResult<AivpSession>>;
	snapshots: {
		latest(token: string): Promise<AivpResult<AivpSnapshot | null>>;
		save(
			token: string,
			input: {
				baseRevision: number;
				idempotencyKey: string;
				content: string;
				contentSha256: string;
				editorVersion: number;
				mediaEntryIds: string[];
				durationMs: number;
			},
		): Promise<AivpResult<AivpSnapshotMeta>>;
	};
	manifest: {
		sync(token: string): Promise<AivpResult<AivpManifest>>;
	};
	media: {
		ensure(token: string, entryId: string): Promise<AivpResult<AivpCachedMedia>>;
	};
	exports: {
		begin(
			token: string,
			input: { format: "mp4" | "webm" },
		): Promise<AivpResult<AivpExportJob>>;
		write(
			token: string,
			jobId: string,
			position: number,
			data: Uint8Array,
		): Promise<AivpResult<{ written: number }>>;
		finish(
			token: string,
			jobId: string,
			details: AivpExportDetails,
		): Promise<AivpResult<AivpExportFile>>;
		cancel(token: string, jobId: string): Promise<AivpResult<{ cancelled: true }>>;
		saveAs(
			token: string,
			exportId: string,
		): Promise<AivpResult<{ status: "saved" | "cancelled"; fileName: string | null }>>;
		upload(
			token: string,
			exportId: string,
			input: { snapshotRevision: number },
		): Promise<AivpResult<AivpFinalCutUpload>>;
	};
	/** Answer to a host close request: the host closes the window after this. */
	closeWindow(
		token: string,
		state: { localSaved: boolean; serverSynced: boolean },
	): Promise<AivpResult<{ closing: true }>>;
	/** Returns to the AIVP studio window (the editor stays open). */
	focusStudio(token: string): Promise<AivpResult<{ focused: true }>>;
	onEvent(listener: (event: AivpHostEvent) => void): () => void;
}

declare global {
	interface Window {
		readonly aivpEditor?: AivpEditorBridge;
	}
}

/** The host bridge, or null outside the AIVP desktop host. */
export function aivpBridge(): AivpEditorBridge | null {
	if (typeof window === "undefined") return null;
	const bridge = window.aivpEditor;
	return bridge !== undefined && typeof bridge.bootstrap === "function"
		? bridge
		: null;
}

export const ERROR_MESSAGES: Record<AivpBridgeErrorCode, string> = {
	invalid_request: "请求无效",
	forbidden: "没有执行该操作的权限",
	not_found: "内容不存在或已无权访问",
	session_expired: "剪辑会话已过期，请从工作台重新打开",
	revoked: "许可证或项目权限已撤销，已停止服务器操作；本机修改仍保留",
	signed_out: "账号已退出，已停止服务器操作；本机修改仍保留",
	offline: "无法连接服务器，修改已保存在本机，恢复连接后会继续同步",
	conflict: "服务器上有更新的剪辑版本",
	too_large: "内容超过允许的大小",
	integrity: "文件校验失败（大小或哈希不一致）",
	unsupported_media: "不支持的媒体类型",
	quota: "本机磁盘空间或缓存配额不足",
	busy: "上一个操作仍在进行",
	write_failed: "写入本机文件失败",
	cancelled: "已取消",
	server_error: "服务器暂时无法处理",
};

export function errorText(error: AivpBridgeError): string {
	return error.message !== "" ? error.message : ERROR_MESSAGES[error.code];
}
