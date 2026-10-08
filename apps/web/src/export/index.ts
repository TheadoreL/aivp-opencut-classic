import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
	/** Audio codec chosen by the caller after probing (default: AAC for MP4 with an Opus fallback, Opus for WebM). */
	audioCodec?: "aac" | "opus";
	/**
	 * Encode video only and hand the rendered timeline mix back in
	 * `ExportResult.externalAudio` (a host muxes it; engines without an audio encoder).
	 */
	externalAudio?: boolean;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	/** True when the bytes were written to a host-provided stream instead of `buffer`. */
	streamed?: boolean;
	/** What was actually encoded (codecs, size, frame rate, duration). */
	details?: ExportDetails;
	/** The rendered timeline mix of an `externalAudio` export (null: the timeline is silent). */
	externalAudio?: AudioBuffer | null;
	error?: string;
	cancelled?: boolean;
}

export interface ExportDetails {
	format: ExportFormat;
	videoCodec: "avc" | "vp9";
	audioCodec: "aac" | "opus" | null;
	width: number;
	height: number;
	fps: FrameRate;
	frameCount: number;
	durationSeconds: number;
}

/** Positioned container chunk written by a streaming export. */
export interface ExportStreamChunk {
	type: "write";
	data: Uint8Array;
	position: number;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
