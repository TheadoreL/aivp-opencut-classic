import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";

/**
 * Server snapshot document of one AIVP edit workspace: the OpenCut project
 * exactly as it is persisted locally (scenes, tracks, trims, settings,
 * timeline view state) plus a description of the media bin. Media bytes are
 * never part of a snapshot; manifest media are re-imported from the
 * verified host cache by their stable entry id (= OpenCut media id), local
 * files are listed so a device without them can report them as missing.
 */
export const SNAPSHOT_FORMAT = "aivp-classic-snapshot";
export const SNAPSHOT_VERSION = 1;
/** Mirrors the server limit (EDIT_SNAPSHOT_MAX_BYTES). */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export type SnapshotMediaBinding =
	| { kind: "manifest"; entryId: string }
	| { kind: "local" };

export interface SnapshotMediaItem {
	id: string;
	name: string;
	type: "image" | "video" | "audio";
	width?: number;
	height?: number;
	duration?: number;
	fps?: number;
	hasAudio?: boolean;
	binding: SnapshotMediaBinding;
}

export interface SnapshotDocument {
	format: typeof SNAPSHOT_FORMAT;
	version: typeof SNAPSHOT_VERSION;
	workspaceId: string;
	classicProjectVersion: number;
	project: Record<string, unknown>;
	media: SnapshotMediaItem[];
}

/** JSON with sorted object keys (stable hashing regardless of key insertion order). */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value
			.map((item) =>
				item === undefined || typeof item === "function"
					? "null"
					: stableStringify(item),
			)
			.join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(record).sort()) {
		const item = record[key];
		if (item === undefined || typeof item === "function") continue;
		parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
	}
	return `{${parts.join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Project part that defines "changed": volatile metadata (save time,
 * generated thumbnail) is excluded so opening or re-saving an unchanged
 * project never looks like an edit.
 */
export function projectForSnapshot(
	serialized: Record<string, unknown>,
): Record<string, unknown> {
	const metadata = { ...(serialized.metadata as Record<string, unknown>) };
	delete metadata.updatedAt;
	delete metadata.thumbnail;
	return { ...serialized, metadata };
}

export async function projectHash(
	serialized: Record<string, unknown>,
): Promise<string> {
	return sha256Hex(stableStringify(projectForSnapshot(serialized)));
}

/** Platform manifest entry ids (server-issued); local files never use this shape. */
const ENTRY_ID = /^eme_[A-Za-z0-9_-]{1,60}$/;

const bindingOf = (
	id: string,
	manifestEntryIds: ReadonlySet<string>,
): SnapshotMediaBinding =>
	manifestEntryIds.has(id) || ENTRY_ID.test(id)
		? { kind: "manifest", entryId: id }
		: { kind: "local" };

/** Media referenced by timeline elements of the serialized project (id → name/type). */
export function referencedMedia(
	serialized: Record<string, unknown>,
): Map<string, { name: string; type: "image" | "video" | "audio" }> {
	const found = new Map<string, { name: string; type: "image" | "video" | "audio" }>();
	const scenes = Array.isArray(serialized.scenes) ? serialized.scenes : [];
	for (const scene of scenes) {
		const tracks = (scene as { tracks?: Record<string, unknown> }).tracks;
		if (!tracks) continue;
		const all = [
			tracks.main,
			...(Array.isArray(tracks.overlay) ? tracks.overlay : []),
			...(Array.isArray(tracks.audio) ? tracks.audio : []),
		];
		for (const track of all) {
			const elements = (track as { elements?: unknown } | undefined)?.elements;
			if (!Array.isArray(elements)) continue;
			for (const element of elements as Array<Record<string, unknown>>) {
				const type = element.type;
				const mediaId = element.mediaId;
				if (
					typeof mediaId === "string" &&
					(type === "video" || type === "image" || type === "audio") &&
					!found.has(mediaId)
				) {
					found.set(mediaId, {
						name: typeof element.name === "string" ? element.name : mediaId,
						type,
					});
				}
			}
		}
	}
	return found;
}

/**
 * The document's media list: the media bin plus every media a clip still
 * references while it is missing from this device's bin (so a restored
 * project with missing files stays a complete, valid document).
 */
export function describeMedia({
	assets,
	manifestEntryIds,
	serialized,
}: {
	assets: readonly MediaAsset[];
	manifestEntryIds: ReadonlySet<string>;
	serialized: Record<string, unknown>;
}): SnapshotMediaItem[] {
	const items: SnapshotMediaItem[] = assets
		.filter((asset) => asset.ephemeral !== true)
		.map((asset) => ({
			id: asset.id,
			name: asset.name,
			type: asset.type,
			width: asset.width,
			height: asset.height,
			duration: asset.duration,
			fps: asset.fps,
			hasAudio: asset.hasAudio,
			binding: bindingOf(asset.id, manifestEntryIds),
		}));
	const present = new Set(items.map((item) => item.id));
	for (const [id, info] of referencedMedia(serialized)) {
		if (present.has(id)) continue;
		items.push({ id, name: info.name, type: info.type, binding: bindingOf(id, manifestEntryIds) });
		present.add(id);
	}
	return items;
}

export async function buildSnapshot({
	workspaceId,
	serialized,
	media,
}: {
	workspaceId: string;
	serialized: Record<string, unknown>;
	media: SnapshotMediaItem[];
}): Promise<{
	content: string;
	contentSha256: string;
	projectHash: string;
	editorVersion: number;
	mediaEntryIds: string[];
	durationMs: number;
}> {
	const project = projectForSnapshot(serialized);
	const editorVersion =
		typeof serialized.version === "number" ? serialized.version : 0;
	const document: SnapshotDocument = {
		format: SNAPSHOT_FORMAT,
		version: SNAPSHOT_VERSION,
		workspaceId,
		classicProjectVersion: editorVersion,
		project,
		media,
	};
	const content = stableStringify(document);
	const metadata = serialized.metadata as { duration?: unknown } | undefined;
	const durationTicks =
		typeof metadata?.duration === "number" ? metadata.duration : 0;
	return {
		content,
		contentSha256: await sha256Hex(content),
		projectHash: await sha256Hex(stableStringify(project)),
		editorVersion,
		mediaEntryIds: media.flatMap((item) =>
			item.binding.kind === "manifest" ? [item.binding.entryId] : [],
		),
		durationMs: ticksToMs(durationTicks),
	};
}

/** OpenCut media time ticks to milliseconds. */
function ticksToMs(ticks: number): number {
	if (!Number.isFinite(ticks) || ticks <= 0) return 0;
	return Math.round((ticks / TICKS_PER_SECOND) * 1000);
}

/**
 * Parses and checks a server snapshot for this workspace. The returned
 * project record is ready for `importSerializedProject` (volatile metadata
 * restored).
 */
export function parseSnapshot({
	content,
	workspaceId,
}: {
	content: string;
	workspaceId: string;
}): SnapshotDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("服务器剪辑版本无法解析");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("服务器剪辑版本格式无效");
	}
	const document = parsed as Partial<SnapshotDocument>;
	if (
		document.format !== SNAPSHOT_FORMAT ||
		document.version !== SNAPSHOT_VERSION
	) {
		throw new Error("服务器剪辑版本的格式不受此版本支持");
	}
	if (document.workspaceId !== workspaceId) {
		throw new Error("服务器剪辑版本不属于本集剪辑工程");
	}
	const project = document.project as Record<string, unknown> | undefined;
	const metadata = project?.metadata as Record<string, unknown> | undefined;
	if (!project || !metadata || metadata.id !== workspaceId) {
		throw new Error("服务器剪辑版本的工程标识不一致");
	}
	if (!Array.isArray(project.scenes)) {
		throw new Error("服务器剪辑版本缺少场景数据");
	}
	return {
		format: SNAPSHOT_FORMAT,
		version: SNAPSHOT_VERSION,
		workspaceId,
		classicProjectVersion:
			typeof document.classicProjectVersion === "number"
				? document.classicProjectVersion
				: 0,
		project: {
			...project,
			metadata: { ...metadata, updatedAt: new Date().toISOString() },
		},
		media: Array.isArray(document.media) ? document.media : [],
	};
}
