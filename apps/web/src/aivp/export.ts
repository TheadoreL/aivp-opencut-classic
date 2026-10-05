import { EditorCore } from "@/core";
import type {
	ExportFormat,
	ExportQuality,
	ExportStreamChunk,
} from "@/export";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import {
	errorText,
	type AivpBridgeError,
	type AivpEditorBridge,
	type AivpExportDetails,
	type AivpExportFile,
} from "./bridge";

/** Longest timeline the AIVP export accepts (the audio mix is rendered in memory). */
export const AIVP_EXPORT_MAX_SECONDS = 30 * 60;

export interface AivpExportRequest {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio: boolean;
}

export type AivpExportOutcome =
	| { status: "done"; file: AivpExportFile; details: AivpExportDetails }
	| { status: "cancelled" }
	| { status: "failed"; message: string };

class BridgeWriteError extends Error {
	constructor(readonly bridgeError: AivpBridgeError) {
		super(errorText(bridgeError));
	}
}

/**
 * Renders the timeline with OpenCut's own encoder (mediabunny/WebCodecs)
 * and streams the container bytes to a host-controlled export file:
 * positioned chunks travel over the editor bridge and are written to disk
 * by the host, so neither side holds the whole movie in memory. The host
 * chooses the file location; nothing here names a path. This is a real
 * MP4/WebM render, never a project JSON dump.
 */
export async function exportToHost({
	bridge,
	token,
	request,
}: {
	bridge: AivpEditorBridge;
	token: string;
	request: AivpExportRequest;
}): Promise<AivpExportOutcome> {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project) return { status: "failed", message: "没有打开的剪辑工程" };
	const durationSeconds = mediaTimeToSeconds({
		time: editor.timeline.getTotalDuration(),
	});
	if (durationSeconds <= 0) return { status: "failed", message: "时间线为空，无法导出" };
	if (durationSeconds > AIVP_EXPORT_MAX_SECONDS) {
		return {
			status: "failed",
			message: `时间线时长超过当前导出上限（${AIVP_EXPORT_MAX_SECONDS / 60} 分钟）`,
		};
	}

	const begun = await bridge.exports.begin(token, { format: request.format });
	if (!begun.ok) return { status: "failed", message: errorText(begun.error) };
	const job = begun.data;

	const writable = new WritableStream<ExportStreamChunk>({
		async write(chunk) {
			const data = chunk.data;
			for (let offset = 0; offset < data.byteLength; offset += job.chunkMaxBytes) {
				const part = data.subarray(offset, Math.min(data.byteLength, offset + job.chunkMaxBytes));
				const result = await bridge.exports.write(token, job.jobId, chunk.position + offset, part);
				if (!result.ok) throw new BridgeWriteError(result.error);
			}
		},
	});

	let outcome: AivpExportOutcome;
	try {
		const result = await editor.project.export({
			options: {
				format: request.format,
				quality: request.quality,
				fps: request.fps,
				includeAudio: request.includeAudio,
			},
			writable,
		});
		if (result.cancelled) {
			outcome = { status: "cancelled" };
		} else if (!result.success || !result.streamed || !result.details) {
			outcome = {
				status: "failed",
				message: result.error ? `导出失败：${result.error}` : "导出失败",
			};
		} else {
			const details: AivpExportDetails = {
				format: result.details.format,
				videoCodec: result.details.videoCodec,
				audioCodec: result.details.audioCodec,
				width: result.details.width,
				height: result.details.height,
				fpsNumerator: result.details.fps.numerator,
				fpsDenominator: result.details.fps.denominator,
				durationMs: Math.round(result.details.durationSeconds * 1000),
				frameCount: result.details.frameCount,
			};
			const finished = await bridge.exports.finish(token, job.jobId, details);
			outcome = finished.ok
				? { status: "done", file: finished.data, details }
				: { status: "failed", message: errorText(finished.error) };
			if (finished.ok) return outcome;
		}
	} catch (error) {
		outcome = {
			status: "failed",
			message:
				error instanceof BridgeWriteError
					? `写入导出文件失败：${error.message}`
					: error instanceof Error
						? `导出失败：${error.message}`
						: "导出失败",
		};
	} finally {
		editor.project.clearExportState();
	}
	// Any outcome other than a finished file removes the partial host file.
	await bridge.exports.cancel(token, job.jobId);
	return outcome;
}
