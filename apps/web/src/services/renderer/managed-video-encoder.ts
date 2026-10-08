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
 * - Input frames are CPU-owned I420 buffers copied from the rendered output
 *   (drawn into a private 2D surface, read back, converted with BT.709
 *   coefficients). A `VideoFrame` made from the shared WebGL compositor
 *   canvas is backed by a GPU surface the compositor keeps redrawing; on the
 *   iPad Simulator the platform encoder accepted such frames but never
 *   produced output or completed `flush()`. A plain I420 buffer has no tie
 *   to the canvas, its context or GPU memory, and is the encoder's native
 *   input layout.
 * - `latencyMode: "realtime"` so the platform encoder emits each frame
 *   without reordering/look-ahead (no B-frames: decode order equals
 *   presentation order, which the MP4 muxer requires of packets).
 * - Backpressure on `encodeQueueSize` with polling (never only on a
 *   `dequeue` event), `flush()` when queued frames produce no output, and
 *   every wait bounded and cancellable; failures name their stage.
 *
 * Every rendered frame is encoded exactly once with its exact timestamp.
 */

export class ExportStageError extends Error {
	constructor(
		readonly stage: "mix" | "render" | "encode" | "mux" | "finalize",
		readonly frame: number,
		message: string,
	) {
		super(message);
		this.name = "ExportStageError";
	}
}

/** Numeric encoder state for diagnostics (no content). */
export interface ManagedEncoderStats {
	submitted: number;
	outputs: number;
	muxed: number;
	queue: number;
	flushes: number;
	flushesDone: number;
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

const BT709: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

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
	if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
	// 4:2:0 H.264 needs even dimensions (the I420 input is built at the output size).
	if (width % 2 !== 0 || height % 2 !== 0) return null;
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

/**
 * Copies the rendered output into a CPU-owned I420 frame (BT.709, limited
 * range). The private 2D surface is reused; the pixel buffers are per frame
 * (the encoder may hold them until it emits).
 */
class I420FrameCopier {
	private readonly surface: OffscreenCanvas;
	private readonly context: OffscreenCanvasRenderingContext2D;

	constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		this.surface = new OffscreenCanvas(width, height);
		const context = this.surface.getContext("2d", { willReadFrequently: true, alpha: false });
		if (!context) throw new Error("无法创建导出画面缓冲");
		this.context = context;
	}

	copy(source: CanvasImageSource, timestampUs: number, durationUs: number): VideoFrame {
		const { width, height, context } = this;
		context.drawImage(source, 0, 0, width, height);
		const rgba = context.getImageData(0, 0, width, height).data;
		const chromaWidth = width >> 1;
		const chromaHeight = height >> 1;
		const lumaSize = width * height;
		const chromaSize = chromaWidth * chromaHeight;
		const data = new Uint8Array(lumaSize + 2 * chromaSize);
		for (let index = 0, pixel = 0; index < lumaSize; index += 1, pixel += 4) {
			const r = rgba[pixel] as number;
			const g = rgba[pixel + 1] as number;
			const b = rgba[pixel + 2] as number;
			data[index] = 16 + ((47 * r + 157 * g + 16 * b + 128) >> 8);
		}
		const uOffset = lumaSize;
		const vOffset = lumaSize + chromaSize;
		for (let y = 0; y < chromaHeight; y += 1) {
			for (let x = 0; x < chromaWidth; x += 1) {
				const top = (2 * y * width + 2 * x) * 4;
				const bottom = top + width * 4;
				const r = ((rgba[top] as number) + (rgba[top + 4] as number) + (rgba[bottom] as number) + (rgba[bottom + 4] as number)) >> 2;
				const g = ((rgba[top + 1] as number) + (rgba[top + 5] as number) + (rgba[bottom + 1] as number) + (rgba[bottom + 5] as number)) >> 2;
				const b = ((rgba[top + 2] as number) + (rgba[top + 6] as number) + (rgba[bottom + 2] as number) + (rgba[bottom + 6] as number)) >> 2;
				const at = y * chromaWidth + x;
				data[uOffset + at] = 128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8);
				data[vOffset + at] = 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
			}
		}
		return new VideoFrame(data, {
			format: "I420",
			codedWidth: width,
			codedHeight: height,
			timestamp: timestampUs,
			duration: durationUs,
			colorSpace: BT709,
		});
	}
}

export class ManagedAvcEncoder {
	private readonly encoder: VideoEncoder;
	private readonly source: EncodedVideoPacketSource;
	private readonly copier: I420FrameCopier;
	private readonly onStall?: (frame: number, stats: ManagedEncoderStats) => void;
	private pending: Promise<void> = Promise.resolve();
	private failure: Error | null = null;
	private outputs = 0;
	private muxed = 0;
	private submitted = 0;
	private flushes = 0;
	private flushesDone = 0;

	constructor({
		output,
		config,
		frameRate,
		onStall,
	}: {
		output: Output;
		config: VideoEncoderConfig;
		frameRate: number;
		/** Diagnostic: queued frames produced no output, a flush is being forced (numeric state only). */
		onStall?: (frame: number, stats: ManagedEncoderStats) => void;
	}) {
		this.onStall = onStall;
		this.copier = new I420FrameCopier(config.width, config.height);
		this.source = new EncodedVideoPacketSource("avc");
		output.addVideoTrack(this.source, { frameRate });
		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				this.outputs += 1;
				const packet = EncodedPacket.fromEncodedChunk(chunk);
				// Muxing is serialised in output order (decode order; realtime H.264 has no reordering).
				this.pending = this.pending
					.then(() => this.source.add(packet, meta))
					.then(() => {
						this.muxed += 1;
					})
					.catch((error: unknown) => {
						this.failure ??= error instanceof Error ? error : new Error(String(error));
					});
			},
			error: (error) => {
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			},
		});
		this.encoder.configure(config);
	}

	get stats(): ManagedEncoderStats {
		return {
			submitted: this.submitted,
			outputs: this.outputs,
			muxed: this.muxed,
			queue: this.encoder.state === "closed" ? 0 : this.encoder.encodeQueueSize,
			flushes: this.flushes,
			flushesDone: this.flushesDone,
		};
	}

	private describe(): string {
		const stats = this.stats;
		return `已提交 ${stats.submitted} 帧，编码输出 ${stats.outputs}，已封装 ${stats.muxed}，队列 ${stats.queue}`;
	}

	private check(frame: number): void {
		if (this.failure) throw new ExportStageError("encode", frame, `视频编码失败：${this.failure.message}`);
		if (this.encoder.state === "closed") throw new ExportStageError("encode", frame, "视频编码器已关闭");
	}

	/**
	 * Encodes one rendered frame (copied from `canvas` now, into a CPU-owned
	 * I420 buffer). Waits, bounded by `deadline` and `cancelled`, until the
	 * encoder can take it.
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
		// Copy first: the compositor canvas is only guaranteed to hold this frame now.
		const videoFrame = this.copier.copy(canvas, timestampUs, durationUs);
		try {
			let stalledSince = Date.now();
			let lastOutputs = this.outputs;
			while (this.encoder.encodeQueueSize >= QUEUE_LIMIT) {
				if (cancelled()) return;
				this.check(frame);
				if (Date.now() > deadline) {
					throw new ExportStageError("encode", frame, `视频编码在第 ${frame + 1} 帧停滞（${this.describe()}）`);
				}
				if (this.outputs !== lastOutputs) {
					lastOutputs = this.outputs;
					stalledSince = Date.now();
				} else if (Date.now() - stalledSince > STALL_FLUSH_MS) {
					// The platform encoder holds frames until it sees more input: make it complete what it has.
					this.onStall?.(frame, this.stats);
					await this.flush({ frame, deadline, cancelled });
					stalledSince = Date.now();
				}
				await delay(POLL_MS);
			}
			if (cancelled()) return;
			this.check(frame);
			this.encoder.encode(videoFrame, { keyFrame: frame % 120 === 0 });
			this.submitted += 1;
		} finally {
			// encode() keeps its own reference; ours is released either way.
			videoFrame.close();
		}
	}

	/** Completes every submitted frame and its muxing, bounded by `deadline`. */
	async flush({ frame, deadline, cancelled }: { frame: number; deadline: number; cancelled: () => boolean }): Promise<void> {
		this.flushes += 1;
		let done = false;
		const flushed = this.encoder.flush().then(
			() => {
				done = true;
				this.flushesDone += 1;
			},
			(error: unknown) => {
				done = true;
				this.failure ??= error instanceof Error ? error : new Error(String(error));
			},
		);
		while (!done) {
			await Promise.race([flushed, delay(100)]);
			if (done) break;
			if (cancelled()) return;
			if (Date.now() > deadline) {
				throw new ExportStageError("encode", frame, `视频编码器未完成刷新（${this.describe()}）`);
			}
		}
		const muxedAll = this.pending.then(() => true);
		while (!(await Promise.race([muxedAll, delay(100).then(() => false)]))) {
			if (cancelled()) return;
			if (Date.now() > deadline) {
				throw new ExportStageError("mux", frame, `视频封装未完成（${this.describe()}）`);
			}
		}
		this.check(frame);
	}

	/** All frames submitted: completes encoding and closes the packet source. */
	async finish({ frame, deadline, cancelled }: { frame: number; deadline: number; cancelled: () => boolean }): Promise<void> {
		await this.flush({ frame, deadline, cancelled });
		if (cancelled()) return;
		if (this.outputs < this.submitted || this.muxed < this.outputs) {
			throw new ExportStageError("encode", frame, `视频编码输出不完整（${this.describe()}）`);
		}
		this.source.close();
	}

	/** Releases the encoder (pending flushes reject; nothing more is muxed). Safe to call repeatedly. */
	close(): void {
		if (this.encoder.state !== "closed") {
			try {
				this.encoder.close();
			} catch {
				// Already closed.
			}
		}
	}
}
