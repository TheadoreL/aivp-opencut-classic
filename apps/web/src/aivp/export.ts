import { EditorCore } from "@/core";
import type {
	ExportFormat,
	ExportQuality,
	ExportStreamChunk,
} from "@/export";
import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import {
	errorText,
	type AivpBridgeError,
	type AivpEditorBridge,
	type AivpExportDetails,
	type AivpExportFile,
	type AivpExportJob,
	type AivpHostInfo,
} from "./bridge";

/** Longest timeline the AIVP export accepts (the audio mix is rendered in memory). */
export const AIVP_EXPORT_MAX_SECONDS = 30 * 60;

/** Sample rate of the rendered timeline mix (media/audio.ts). */
const MIX_SAMPLE_RATE = 44_100;

export interface AivpExportRequest {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio: boolean;
}

/**
 * How the audio of one format is produced on THIS engine:
 * - `encode`: the editor's own encoder (WebCodecs AudioEncoder);
 * - `host-mux`: the editor renders the mix as PCM and the host encodes it to
 *   AAC and muxes it with the editor's H.264 video (platform media framework;
 *   engines without a WebCodecs audio encoder, e.g. older iPad WebKit).
 */
export type AivpAudioPlan =
	| { mode: "encode"; codec: "aac" | "opus" }
	| { mode: "host-mux" };

export interface AivpFormatSupport {
	format: ExportFormat;
	/** The engine can encode this format's video codec at the project size. */
	video: boolean;
	/** null: no way to produce audio for this format here (a silent export still works). */
	audio: AivpAudioPlan | null;
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

async function videoEncodable(format: ExportFormat, width: number, height: number): Promise<boolean> {
	if (typeof VideoEncoder === "undefined") return false;
	try {
		return await canEncodeVideo(format === "webm" ? "vp9" : "avc", { width, height });
	} catch {
		return false;
	}
}

async function audioEncodable(codec: "aac" | "opus"): Promise<boolean> {
	if (typeof AudioEncoder === "undefined") return false;
	try {
		return await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: MIX_SAMPLE_RATE });
	} catch {
		return false;
	}
}

/**
 * What this engine (and host) can actually produce, probed at runtime: the
 * WebCodecs encoders present here, never an assumption about the browser.
 * Chromium (desktop) normally encodes H.264 + AAC and VP9 + Opus itself;
 * WebKit encodes H.264 and, where it lacks an audio encoder, hands the mix to
 * a host that offers a native AAC mux.
 */
export async function probeExportSupport({
	host,
	bridge,
	width,
	height,
}: {
	host: AivpHostInfo;
	bridge: AivpEditorBridge;
	width: number;
	height: number;
}): Promise<AivpFormatSupport[]> {
	const [mp4Video, webmVideo, aac, opus] = await Promise.all([
		videoEncodable("mp4", width, height),
		videoEncodable("webm", width, height),
		audioEncodable("aac"),
		audioEncodable("opus"),
	]);
	const hostMux = host.capabilities.nativeAudioMux && typeof bridge.exports.writeAudio === "function";
	const mp4Audio: AivpAudioPlan | null = aac
		? { mode: "encode", codec: "aac" }
		: hostMux
			? { mode: "host-mux" }
			: opus
				? { mode: "encode", codec: "opus" }
				: null;
	return [
		{ format: "mp4", video: mp4Video, audio: mp4Audio },
		{ format: "webm", video: webmVideo, audio: opus ? { mode: "encode", codec: "opus" } : null },
	];
}

/** Why a request cannot be exported here (null: it can). Unsupported codecs are explicit errors; the project is untouched. */
export function unsupportedReason(request: AivpExportRequest, support: AivpFormatSupport | undefined): string | null {
	if (!support || !support.video) {
		return request.format === "webm"
			? "当前设备的渲染引擎不支持 VP9 视频编码，无法导出 WebM。请改用 MP4。"
			: "当前设备的渲染引擎不支持 H.264 视频编码，无法在本机导出成片。剪辑工程已保存，可在 AIVP 桌面客户端导出。";
	}
	if (request.includeAudio && support.audio === null) {
		return "当前设备不支持该格式的音频编码。可取消“包含音频”导出无声版本，或改用其他格式。";
	}
	return null;
}

/** Positioned little-endian 16-bit PCM WAV of the mix, streamed in bounded chunks (never one huge buffer). */
async function streamWavSidecar({
	bridge,
	token,
	job,
	mix,
}: {
	bridge: AivpEditorBridge;
	token: string;
	job: AivpExportJob;
	mix: AudioBuffer;
}): Promise<void> {
	const writeAudio = bridge.exports.writeAudio;
	if (!writeAudio) throw new Error("此客户端不提供音频封装");
	const channels = Math.max(1, Math.min(2, mix.numberOfChannels));
	const frames = mix.length;
	const blockAlign = channels * 2;
	const dataBytes = frames * blockAlign;
	if (dataBytes + 36 > 0xffff_ffff) throw new Error("音频过长，无法封装");

	const header = new DataView(new ArrayBuffer(44));
	const ascii = (offset: number, text: string): void => {
		for (let index = 0; index < text.length; index += 1) header.setUint8(offset + index, text.charCodeAt(index));
	};
	ascii(0, "RIFF");
	header.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, channels, true);
	header.setUint32(24, mix.sampleRate, true);
	header.setUint32(28, mix.sampleRate * blockAlign, true);
	header.setUint16(32, blockAlign, true);
	header.setUint16(34, 16, true);
	ascii(36, "data");
	header.setUint32(40, dataBytes, true);
	const wroteHeader = await writeAudio(token, job.jobId, 0, new Uint8Array(header.buffer));
	if (!wroteHeader.ok) throw new BridgeWriteError(wroteHeader.error);

	const data = Array.from({ length: channels }, (_, channel) => mix.getChannelData(channel));
	const framesPerChunk = Math.max(1, Math.floor(Math.min(job.chunkMaxBytes, 4 * 1024 * 1024) / blockAlign));
	for (let start = 0; start < frames; start += framesPerChunk) {
		const count = Math.min(framesPerChunk, frames - start);
		const view = new DataView(new ArrayBuffer(count * blockAlign));
		for (let frame = 0; frame < count; frame += 1) {
			for (let channel = 0; channel < channels; channel += 1) {
				const sample = Math.max(-1, Math.min(1, data[channel][start + frame] ?? 0));
				view.setInt16((frame * channels + channel) * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
			}
		}
		const written = await writeAudio(token, job.jobId, 44 + start * blockAlign, new Uint8Array(view.buffer));
		if (!written.ok) throw new BridgeWriteError(written.error);
	}
}

/**
 * Renders the timeline with OpenCut's own encoder (mediabunny/WebCodecs)
 * and streams the container bytes to a host-controlled export file:
 * positioned chunks travel over the editor bridge and are written to disk
 * by the host, so neither side holds the whole movie in memory. The host
 * chooses the file location; nothing here names a path. This is a real
 * MP4/WebM render, never a project JSON dump. With a `host-mux` audio plan
 * the container carries the H.264 video and the mix follows as a PCM WAV
 * sidecar the host encodes to AAC and muxes before verifying the file.
 */
export async function exportToHost({
	bridge,
	token,
	request,
	audio,
	onStage,
}: {
	bridge: AivpEditorBridge;
	token: string;
	request: AivpExportRequest;
	/** Probed plan for the request's format (required when audio is included). */
	audio: AivpAudioPlan | null;
	onStage?: (stage: "encoding" | "audio" | "finishing") => void;
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
	if (request.includeAudio && audio === null) {
		return { status: "failed", message: "当前设备不支持该格式的音频编码" };
	}
	const hostMux = request.includeAudio && audio?.mode === "host-mux";

	const begun = await bridge.exports.begin(token, { format: request.format, externalAudio: hostMux });
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
		onStage?.("encoding");
		const result = await editor.project.export({
			options: {
				format: request.format,
				quality: request.quality,
				fps: request.fps,
				includeAudio: request.includeAudio,
				audioCodec: audio?.mode === "encode" ? audio.codec : undefined,
				externalAudio: hostMux,
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
			if (hostMux && result.externalAudio) {
				onStage?.("audio");
				await streamWavSidecar({ bridge, token, job, mix: result.externalAudio });
			}
			onStage?.("finishing");
			const details: AivpExportDetails = {
				format: result.details.format,
				videoCodec: result.details.videoCodec,
				// A host-muxed track is reported by the host once it exists.
				audioCodec: hostMux ? null : result.details.audioCodec,
				width: result.details.width,
				height: result.details.height,
				fpsNumerator: result.details.fps.numerator,
				fpsDenominator: result.details.fps.denominator,
				durationMs: Math.round(result.details.durationSeconds * 1000),
				frameCount: result.details.frameCount,
			};
			const finished = await bridge.exports.finish(token, job.jobId, details);
			outcome = finished.ok
				? { status: "done", file: finished.data, details: finished.data.details ?? details }
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
