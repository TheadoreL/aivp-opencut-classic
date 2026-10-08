import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	type StreamTargetChunk,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";
import { reportExportStage } from "./export-diagnostics";
import { ExportStageError, ManagedAvcEncoder, resolveAvcConfig } from "./managed-video-encoder";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	/** Explicit audio codec (probed by the caller); otherwise the format default with an AAC → Opus fallback. */
	audioCodec?: "aac" | "opus";
	/** `managed`: MP4/H.264 through the exporter's own WebCodecs encoder (see managed-video-encoder.ts). */
	videoPipeline?: "default" | "managed";
};

/** Longest a single stage (one frame's render or encode, audio, finalize) may take before the export fails. */
const STAGE_TIMEOUT_MS = 60_000;
const CANCELLED = Symbol("cancelled");
const TIMED_OUT = Symbol("timed-out");

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private requestedAudioCodec?: "aac" | "opus";
	private videoPipeline: "default" | "managed";

	private isCancelled = false;
	private resolveCancelled: () => void = () => undefined;
	/** Settles when `cancel()` is called: every bounded wait races it, so cancelling works mid-await. */
	private readonly cancelledSignal = new Promise<void>((resolve) => {
		this.resolveCancelled = resolve;
	});

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		audioCodec,
		videoPipeline,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.requestedAudioCodec = audioCodec;
		this.videoPipeline = videoPipeline ?? "default";
	}

	cancel(): void {
		this.isCancelled = true;
		this.resolveCancelled();
	}

	/**
	 * Waits for one export stage, bounded: resolves its value, `CANCELLED`
	 * when the export was cancelled meanwhile, or throws an actionable
	 * `ExportStageError` when the stage did not settle in time (nothing is
	 * skipped: the export fails and the project is untouched).
	 */
	private async bounded<T>(
		work: Promise<T>,
		stage: ExportStageError["stage"],
		frame: number,
		message: string,
	): Promise<T | typeof CANCELLED> {
		const handle: { timer?: ReturnType<typeof setTimeout> } = {};
		const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
			handle.timer = setTimeout(() => resolve(TIMED_OUT), STAGE_TIMEOUT_MS);
		});
		try {
			const result = await Promise.race([work, timeout, this.cancelledSignal.then(() => CANCELLED)]);
			if (result === TIMED_OUT) throw new ExportStageError(stage, frame, `${message}，已停止导出。剪辑工程未受影响，可重试或改用桌面客户端导出。`);
			return result as T | typeof CANCELLED;
		} finally {
			if (handle.timer !== undefined) clearTimeout(handle.timer);
			// A stage abandoned by timeout or cancel must not surface later as an unhandled rejection.
			work.catch(() => undefined);
		}
	}

	/** Codecs and geometry of the last export (what was actually encoded). */
	getEncodedDetails(): ExportedStreamDetails | null {
		return this.encodedDetails;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const target = new BufferTarget();
		const completed = await this.encode({ rootNode, target });
		if (!completed) return null;

		const buffer = target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}

	/**
	 * Same encoding as {@link export}, but the container bytes are written
	 * as positioned chunks to `writable` (file-backed on the host side)
	 * instead of being collected in one in-memory buffer. MP4 output keeps
	 * the moov atom at the end (no in-memory fast start). Resolves false when
	 * cancelled.
	 */
	async exportToStream({
		rootNode,
		writable,
	}: {
		rootNode: RootNode;
		writable: WritableStream<StreamTargetChunk>;
	}): Promise<boolean> {
		const target = new StreamTarget(writable, {
			chunked: true,
			chunkSize: 4 * 1024 * 1024,
		});
		return this.encode({ rootNode, target, streaming: true });
	}

	private async encode({
		rootNode,
		target,
		streaming = false,
	}: {
		rootNode: RootNode;
		target: BufferTarget | StreamTarget;
		streaming?: boolean;
	}): Promise<boolean> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat(streaming ? { fastStart: false } : {});

		const output = new Output({
			format: outputFormat,
			target,
		});

		// H.264 through the exporter's own WebCodecs encoder where the engine needs it (WebKit), else mediabunny's.
		let videoSource: CanvasSource | null = null;
		let managedEncoder: ManagedAvcEncoder | null = null;
		if (this.videoPipeline === "managed" && this.format === "mp4") {
			const config = await resolveAvcConfig({
				width: this.renderer.width,
				height: this.renderer.height,
				fps: fpsFloat,
				quality: this.quality,
			});
			if (!config) {
				throw new ExportStageError("encode", 0, `当前设备无法以 ${this.renderer.width}×${this.renderer.height} 编码 H.264 视频`);
			}
			managedEncoder = new ManagedAvcEncoder({
				output,
				config,
				frameRate: fpsFloat,
				onFlushForStall: (frame) => reportExportStage({ phase: "encode-flush", frame, total: frameCount }),
			});
		} else {
			videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
				codec: this.format === "webm" ? "vp9" : "avc",
				bitrate: qualityMap[this.quality],
			});
			output.addVideoTrack(videoSource, { frameRate: fpsFloat });
		}

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" =
				this.requestedAudioCodec ?? (this.format === "webm" ? "opus" : "aac");

			if (
				this.requestedAudioCodec === undefined &&
				audioCodec === "aac" &&
				typeof AudioEncoder !== "undefined"
			) {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
			this.encodedAudioCodec = audioCodec;
		} else {
			this.encodedAudioCodec = null;
		}

		const abort = async (): Promise<false> => {
			managedEncoder?.close();
			// Cancelling must not hang either (a stuck encoder may never settle its promises).
			await Promise.race([output.cancel().catch(() => undefined), delay(5_000)]);
			this.emit("cancelled");
			return false;
		};

		try {
			await output.start();

			if (audioSource && this.audioBuffer) {
				reportExportStage({ phase: "audio", frame: 0, total: frameCount });
				const added = await this.bounded(audioSource.add(this.audioBuffer), "encode", 0, "音频编码超时（编码器未返回）");
				if (added === CANCELLED) return await abort();
				audioSource.close();
			}

			const durationUs = Math.round(1_000_000 / fpsFloat);
			let lastPhase = "";
			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) return await abort();

				const timeTicks = i * ticksPerFrame;
				const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
				const report = (phase: string) => {
					// Coarse: on every phase change and every 12th frame.
					if (phase !== lastPhase || i % 12 === 0) reportExportStage({ phase, frame: i, total: frameCount });
					lastPhase = phase;
				};

				report("render");
				const rendered = await this.bounded(
					this.renderer.render({ node: rootNode, time: timeTicks }),
					"render",
					i,
					`第 ${i + 1} 帧画面渲染超时（素材解码未返回）`,
				);
				if (rendered === CANCELLED) return await abort();

				report("encode");
				if (managedEncoder) {
					const encoder = managedEncoder;
					const encoded = await this.bounded(
						encoder.add({
							canvas: this.renderer.getOutputCanvas(),
							frame: i,
							timestampUs: Math.round(timeSeconds * 1_000_000),
							durationUs,
							deadline: Date.now() + STAGE_TIMEOUT_MS,
							cancelled: () => this.isCancelled,
						}),
						"encode",
						i,
						`第 ${i + 1} 帧视频编码超时（编码器未返回）`,
					);
					if (encoded === CANCELLED) return await abort();
				} else if (videoSource) {
					const added = await this.bounded(videoSource.add(timeSeconds, 1 / fpsFloat), "encode", i, `第 ${i + 1} 帧视频编码超时（编码器未返回）`);
					if (added === CANCELLED) return await abort();
				}

				this.emit("progress", i / frameCount);
			}

			if (this.isCancelled) return await abort();

			reportExportStage({ phase: "finalize", frame: frameCount, total: frameCount });
			if (managedEncoder) {
				const encoder = managedEncoder;
				const finished = await this.bounded(
					encoder.finish({ frame: frameCount, deadline: Date.now() + STAGE_TIMEOUT_MS, cancelled: () => this.isCancelled }),
					"finalize",
					frameCount,
					"视频编码收尾超时",
				);
				if (finished === CANCELLED || this.isCancelled) return await abort();
			} else {
				videoSource?.close();
			}
			const finalized = await this.bounded(output.finalize(), "finalize", frameCount, "成片封装超时");
			if (finalized === CANCELLED) return await abort();
			managedEncoder?.close();
			reportExportStage({ phase: "done", frame: frameCount, total: frameCount });
			this.emit("progress", 1);
		} catch (error) {
			reportExportStage({
				phase: error instanceof ExportStageError ? `failed-${error.stage}` : "failed",
				frame: error instanceof ExportStageError ? error.frame : -1,
				total: frameCount,
			});
			managedEncoder?.close();
			await Promise.race([output.cancel().catch(() => undefined), delay(5_000)]);
			throw error;
		}

		this.encodedDetails = {
			videoCodec: this.format === "webm" ? "vp9" : "avc",
			audioCodec: this.encodedAudioCodec,
			width: this.renderer.getOutputCanvas().width,
			height: this.renderer.getOutputCanvas().height,
			fps,
			frameCount,
			durationSeconds: frameCount / fpsFloat,
		};
		return true;
	}

	private encodedAudioCodec: "aac" | "opus" | null = null;
	private encodedDetails: ExportedStreamDetails | null = null;
}

export interface ExportedStreamDetails {
	videoCodec: "avc" | "vp9";
	audioCodec: "aac" | "opus" | null;
	width: number;
	height: number;
	fps: FrameRate;
	frameCount: number;
	durationSeconds: number;
}
