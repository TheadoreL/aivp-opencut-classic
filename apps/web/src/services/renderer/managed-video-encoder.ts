import {
	EncodedPacket,
	EncodedVideoPacketSource,
	type Output,
} from "mediabunny";

/**
 * H.264 encoding driven directly through WebCodecs, with the encoded chunks
 * handed to mediabunny's muxer as packets (`EncodedVideoPacketSource`).
 *
 * Used where the engine's encoder needs explicit handling (WebKit on iPad):
 * - `latencyMode: "realtime"` so the platform encoder emits each frame
 *   without reordering/look-ahead (no B-frames: decode order equals
 *   presentation order, which the MP4 muxer requires of packets);
 * - backpressure on `encodeQueueSize` with polling (never only on a
 *   `dequeue` event an engine might not fire), and if the encoder holds
 *   queued frames without output for a while, `flush()` forces the
 *   platform encoder to complete them (no frame is dropped or skipped);
 * - every wait is bounded and cancellable, and a failure names its stage.
 *
 * Every rendered frame is encoded exactly once with its exact timestamp.
 */

export class ExportStageError extends Error {
	constructor(
		readonly stage: "render" | "encode" | "mux" | "finalize",
		readonly frame: number,
		message: string,
	) {
		super(message);
		this.name = "ExportStageError";
	}
}

const QUEUE_LIMIT = 3;
const STALL_FLUSH_MS = 1_500;
const POLL_MS = 15;

/** Candidate H.264 profiles/levels, most capable first (the engine decides what it supports). */
const AVC_CODECS = [
	"avc1.640033", // High 5.1
	"avc1.64002A", // High 4.2
	"avc1.640028", // High 4.0
	"avc1.4D4033", // Main 5.1
	"avc1.4D4028", // Main 4.0
	"avc1.42E033", // Constrained Baseline 5.1
	"avc1.42E01F", // Constrained Baseline 3.1
];

/** Bits per pixel per frame for the export quality presets. */
const QUALITY_BPP: Record<string, number> = {
	low: 0.05,
	medium: 0.08,
	high: 0.12,
	very_high: 0.2,
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resolveAvcConfig({
	width,
	height,
	fps,
	quality,
}: {
	width: number;
	height: number;
	fps: number;
	quality: string;
}): Promise<VideoEncoderConfig | null> {
	if (typeof VideoEncoder === "undefined") return null;
	const bitrate = Math.max(
		200_000,
		Math.round(width * height * fps * (QUALITY_BPP[quality] ?? QUALITY_BPP.high)),
	);
	for (const codec of AVC_CODECS) {
		const config: VideoEncoderConfig = {
			codec,
			width,
			height,
			bitrate,
			framerate: fps,
			latencyMode: "realtime",
			avc: { format: "avc" },
		};
		try {
			const { supported } = await VideoEncoder.isConfigSupported(config);
			if (supported) return config;
		} catch {
			// Try the next profile.
		}
	}
	return null;
}

export class ManagedAvcEncoder {
	private readonly encoder: VideoEncoder;
	private readonly source: EncodedVideoPacketSource;
	private pending: Promise<void> = Promise.resolve();
	private failure: Error | null = null;
	private lastOutputAt = Date.now();
	private outputs = 0;
	private submitted = 0;

	constructor({
		output,
		config,
		frameRate,
		onFlushForStall,
	}: {
		output: Output;
		config: VideoEncoderConfig;
		frameRate: number;
		/** Diagnostic: a stall was resolved by flushing (frame index of the next frame). */
		onFlushForStall?: (frame: number) => void;
	}) {
		this.onFlushForStall = onFlushForStall;
		this.source = new EncodedVideoPacketSource("avc");
		output.addVideoTrack(this.source, { frameRate });
		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				this.outputs += 1;
				this.lastOutputAt = Date.now();
				const packet = EncodedPacket.fromEncodedChunk(chunk);
				// Muxing is serialised in output order (decode order; realtime H.264 has no reordering).
				this.pending = this.pending.then(() => this.source.add(packet, meta)).catch((error: unknown) => {
					this.failure ??= error instanceof Error ? error : new Error(String(error));
				});
			},
			error: (error) => {
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			},
		});
		this.encoder.configure(config);
	}

	private readonly onFlushForStall?: (frame: number) => void;

	private check(frame: number): void {
		if (this.failure) throw new ExportStageError("encode", frame, `视频编码失败：${this.failure.message}`);
		if (this.encoder.state === "closed") throw new ExportStageError("encode", frame, "视频编码器已关闭");
	}

	/**
	 * Encodes one rendered frame (copied from `canvas` now). Waits, bounded by
	 * `deadline` and `cancelled`, until the encoder can take it.
	 */
	async add({
		canvas,
		frame,
		timestampUs,
		durationUs,
		deadline,
		cancelled,
	}: {
		canvas: CanvasImageSource;
		frame: number;
		timestampUs: number;
		durationUs: number;
		deadline: number;
		cancelled: () => boolean;
	}): Promise<void> {
		this.check(frame);
		let stalledSince = Date.now();
		let lastOutputs = this.outputs;
		while (this.encoder.encodeQueueSize >= QUEUE_LIMIT) {
			if (cancelled()) return;
			this.check(frame);
			if (Date.now() > deadline) {
				throw new ExportStageError("encode", frame, `视频编码在第 ${frame + 1} 帧停滞（编码器未输出数据）`);
			}
			if (this.outputs !== lastOutputs) {
				lastOutputs = this.outputs;
				stalledSince = Date.now();
			} else if (Date.now() - stalledSince > STALL_FLUSH_MS) {
				// The platform encoder holds frames until it sees more input: make it complete what it has.
				this.onFlushForStall?.(frame);
				await this.flush({ frame, deadline, cancelled });
				stalledSince = Date.now();
			}
			await delay(POLL_MS);
		}
		const videoFrame = new VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
		try {
			this.encoder.encode(videoFrame, { keyFrame: frame % 120 === 0 });
			this.submitted += 1;
		} finally {
			videoFrame.close();
		}
	}

	/** Completes every submitted frame and its muxing, bounded by `deadline`. */
	async flush({ frame, deadline, cancelled }: { frame: number; deadline: number; cancelled: () => boolean }): Promise<void> {
		const flushed = this.encoder.flush();
		while (true) {
			const settled = await Promise.race([
				flushed.then(
					() => "done" as const,
					(error: unknown) => {
						this.failure ??= error instanceof Error ? error : new Error(String(error));
						return "done" as const;
					},
				),
				delay(100).then(() => "waiting" as const),
			]);
			if (settled === "done") break;
			if (cancelled()) return;
			if (Date.now() > deadline) {
				throw new ExportStageError("encode", frame, `视频编码在第 ${frame + 1} 帧停滞（编码器未完成刷新）`);
			}
		}
		await this.pending;
		this.check(frame);
	}

	/** All frames submitted: completes encoding and closes the packet source. */
	async finish({ frame, deadline, cancelled }: { frame: number; deadline: number; cancelled: () => boolean }): Promise<void> {
		await this.flush({ frame, deadline, cancelled });
		if (cancelled()) return;
		if (this.outputs < this.submitted) {
			throw new ExportStageError("encode", frame, `视频编码输出不完整（${this.outputs}/${this.submitted} 帧）`);
		}
		this.source.close();
	}

	close(): void {
		if (this.encoder.state !== "closed") {
			try {
				this.encoder.close();
			} catch {
				// Already closed.
			}
		}
	}

	get stats(): { submitted: number; outputs: number; queue: number } {
		return { submitted: this.submitted, outputs: this.outputs, queue: this.encoder.encodeQueueSize };
	}
}
