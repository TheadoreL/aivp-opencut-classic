import {
	EncodedPacket,
	EncodedVideoPacketSource,
	type Output,
} from "mediabunny";

/**
 * H.264 encoding driven directly through WebCodecs, with the encoded chunks
 * handed to mediabunny's muxer as packets (`EncodedVideoPacketSource`).
 * Used by the iPad (WebKit) host.
 *
 * Observed on the iPadOS Simulator: a configuration `isConfigSupported()`
 * accepted took input frames (the queue drained for the first frames) but
 * never emitted an encoded chunk, and `flush()` never settled — with
 * canvas-backed and with CPU-owned I420 frames alike. The cause is not
 * established. Configurations are therefore accepted only after a bounded
 * FUNCTIONAL probe (encode real frames at the export geometry, flush, and
 * require every chunk plus a decoder configuration), trying several
 * profiles, levels, latency modes and acceleration preferences; proven and
 * failed results are cached so a later export does not pay the probe again.
 * If nothing produces output the export fails fast with a platform message.
 *
 * Frames are CPU-owned I420 buffers copied from the rendered output (a
 * plain buffer with no tie to the compositor canvas, context or GPU memory)
 * — a conservative input format, not a proven fix. Every rendered frame is
 * encoded exactly once with its exact timestamp; nothing is skipped.
 */

export class ExportStageError extends Error {
	constructor(
		readonly stage: "mix" | "negotiate" | "render" | "encode" | "mux" | "finalize",
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
/** Frames encoded by one probe (more than the encoder's observed acceptance window). */
const PROBE_FRAMES = 8;
const PROBE_TIMEOUT_MS = 2_500;
const NEGOTIATION_BUDGET_MS = 30_000;
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;
const KEY_FRAME_INTERVAL = 120;

/** Bits per pixel per frame for the export quality presets. */
const QUALITY_BPP: Record<string, number> = {
	low: 0.05,
	medium: 0.08,
	high: 0.12,
	very_high: 0.2,
};

const BT709: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

/** H.264 levels: max frame size (macroblocks), max macroblocks per second, `level_idc`. */
const AVC_LEVELS: { frameMbs: number; mbsPerSecond: number; idc: number }[] = [
	{ frameMbs: 396, mbsPerSecond: 11_880, idc: 0x15 }, // 2.1
	{ frameMbs: 1_620, mbsPerSecond: 40_500, idc: 0x1e }, // 3.0
	{ frameMbs: 3_600, mbsPerSecond: 108_000, idc: 0x1f }, // 3.1
	{ frameMbs: 5_120, mbsPerSecond: 216_000, idc: 0x20 }, // 3.2
	{ frameMbs: 8_192, mbsPerSecond: 245_760, idc: 0x28 }, // 4.0
	{ frameMbs: 8_704, mbsPerSecond: 522_240, idc: 0x2a }, // 4.2
	{ frameMbs: 22_080, mbsPerSecond: 589_824, idc: 0x32 }, // 5.0
	{ frameMbs: 36_864, mbsPerSecond: 983_040, idc: 0x33 }, // 5.1
	{ frameMbs: 36_864, mbsPerSecond: 2_073_600, idc: 0x34 }, // 5.2
];

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function hex(value: number): string {
	return value.toString(16).toUpperCase().padStart(2, "0");
}

/** The lowest level that fits the geometry and rate (null: beyond H.264 5.2). */
function levelFor(width: number, height: number, fps: number): number | null {
	const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
	const level = AVC_LEVELS.find((item) => frameMbs <= item.frameMbs && frameMbs * fps <= item.mbsPerSecond);
	return level?.idc ?? null;
}

function bitrateFor(width: number, height: number, fps: number, quality: string): number {
	return Math.max(200_000, Math.round(width * height * fps * (QUALITY_BPP[quality] ?? QUALITY_BPP.high)));
}

/** Candidate configurations, most broadly compatible encoder settings first. */
export function avcCandidates({ width, height, fps, quality }: { width: number; height: number; fps: number; quality: string }): VideoEncoderConfig[] {
	if (width % 2 !== 0 || height % 2 !== 0) return [];
	const level = levelFor(width, height, fps);
	if (level === null) return [];
	const profiles = [
		`avc1.42E0${hex(level)}`, // Constrained Baseline
		`avc1.4D40${hex(level)}`, // Main
		`avc1.6400${hex(level)}`, // High
	];
	const bitrate = bitrateFor(width, height, fps, quality);
	const candidates: VideoEncoderConfig[] = [];
	for (const latencyMode of ["realtime", "quality"] as const) {
		for (const hardwareAcceleration of ["no-preference", "prefer-software"] as const) {
			for (const codec of profiles) {
				candidates.push({ codec, width, height, bitrate, framerate: fps, latencyMode, hardwareAcceleration, avc: { format: "avc" } });
			}
		}
	}
	return candidates;
}

/** CPU-owned I420 frame of the given size (BT.709 limited range). */
function i420Frame(data: Uint8Array, width: number, height: number, timestampUs: number, durationUs: number): VideoFrame {
	return new VideoFrame(data, {
		format: "I420",
		codedWidth: width,
		codedHeight: height,
		timestamp: timestampUs,
		duration: durationUs,
		colorSpace: BT709,
	});
}

export type ProbeOutcome = "ok" | "rejected" | "error" | "no-output" | "incomplete" | "no-description" | "timeout" | "cancelled";

/**
 * Encodes `PROBE_FRAMES` frames with `config`, flushes, and accepts only when
 * every frame came out (first one a key frame with a decoder configuration).
 * Bounded; the probe encoder is always closed.
 */
async function probeConfig(config: VideoEncoderConfig, fps: number, cancelled: () => boolean): Promise<{ outcome: ProbeOutcome; outputs: number }> {
	let outputs = 0;
	let description = false;
	let failed = false;
	let encoder: VideoEncoder | null = null;
	try {
		try {
			const { supported } = await VideoEncoder.isConfigSupported(config);
			if (!supported) return { outcome: "rejected", outputs };
		} catch {
			return { outcome: "rejected", outputs };
		}
		encoder = new VideoEncoder({
			output: (_chunk, meta) => {
				outputs += 1;
				if (meta?.decoderConfig?.description !== undefined) description = true;
			},
			error: () => {
				failed = true;
			},
		});
		encoder.configure(config);
		const width = config.width;
		const height = config.height;
		const data = new Uint8Array(width * height * 1.5);
		data.fill(16, 0, width * height);
		data.fill(128, width * height);
		const durationUs = Math.round(1_000_000 / fps);
		for (let index = 0; index < PROBE_FRAMES; index += 1) {
			const frame = i420Frame(data, width, height, index * durationUs, durationUs);
			try {
				encoder.encode(frame, { keyFrame: index === 0 });
			} finally {
				frame.close();
			}
		}
		let flushed = false;
		const flushing = encoder.flush().then(
			() => {
				flushed = true;
			},
			() => {
				failed = true;
			},
		);
		const deadline = Date.now() + PROBE_TIMEOUT_MS;
		while (!flushed && !failed) {
			await Promise.race([flushing, delay(50)]);
			if (flushed || failed) break;
			if (cancelled()) return { outcome: "cancelled", outputs };
			if (Date.now() > deadline) return { outcome: outputs === 0 ? "no-output" : "timeout", outputs };
		}
		if (failed) return { outcome: "error", outputs };
		if (outputs === 0) return { outcome: "no-output", outputs };
		if (outputs < PROBE_FRAMES) return { outcome: "incomplete", outputs };
		if (!description) return { outcome: "no-description", outputs };
		return { outcome: "ok", outputs };
	} catch {
		return { outcome: "error", outputs };
	} finally {
		if (encoder !== null && encoder.state !== "closed") {
			try {
				encoder.close();
			} catch {
				// Already closed.
			}
		}
	}
}

const proven = new Map<string, VideoEncoderConfig>();
const failedGeometries = new Map<string, { at: number; tried: number }>();

export type NegotiationResult =
	| { status: "ok"; config: VideoEncoderConfig; cached: boolean }
	| { status: "unsupported"; tried: number; cached: boolean }
	| { status: "cancelled" };

/**
 * A configuration that functionally produced output on this engine, probed
 * within a bounded budget (cached per geometry/fps/quality; failures cached
 * per geometry for a while so retries do not pay the budget again).
 */
export async function negotiateAvcConfig({
	width,
	height,
	fps,
	quality,
	cancelled,
	onAttempt,
}: {
	width: number;
	height: number;
	fps: number;
	quality: string;
	cancelled: () => boolean;
	/** Diagnostics: attempt index, candidate count, outcome, outputs (numeric/coarse only). */
	onAttempt?: (attempt: number, total: number, outcome: ProbeOutcome, outputs: number) => void;
}): Promise<NegotiationResult> {
	if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return { status: "unsupported", tried: 0, cached: false };
	const key = `${width}x${height}@${fps}/${quality}`;
	const geometry = `${width}x${height}`;
	const known = proven.get(key);
	if (known) return { status: "ok", config: known, cached: true };
	const failure = failedGeometries.get(geometry);
	if (failure && Date.now() - failure.at < NEGATIVE_CACHE_MS) return { status: "unsupported", tried: failure.tried, cached: true };

	const candidates = avcCandidates({ width, height, fps, quality });
	const budgetEnds = Date.now() + NEGOTIATION_BUDGET_MS;
	let tried = 0;
	for (const [index, config] of candidates.entries()) {
		if (cancelled()) return { status: "cancelled" };
		if (Date.now() > budgetEnds) break;
		tried += 1;
		const result = await probeConfig(config, fps, cancelled);
		onAttempt?.(index, candidates.length, result.outcome, result.outputs);
		if (result.outcome === "cancelled") return { status: "cancelled" };
		if (result.outcome === "ok") {
			proven.set(key, config);
			return { status: "ok", config, cached: false };
		}
	}
	failedGeometries.set(geometry, { at: Date.now(), tried });
	return { status: "unsupported", tried, cached: false };
}

/** Cheap pre-check for the export dialog: false when this geometry recently failed negotiation or has no candidate. */
export async function avcLikelySupported({ width, height, fps, quality }: { width: number; height: number; fps: number; quality: string }): Promise<boolean> {
	if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
	if (proven.has(`${width}x${height}@${fps}/${quality}`)) return true;
	const failure = failedGeometries.get(`${width}x${height}`);
	if (failure && Date.now() - failure.at < NEGATIVE_CACHE_MS) return false;
	for (const config of avcCandidates({ width, height, fps, quality })) {
		try {
			if ((await VideoEncoder.isConfigSupported(config)).supported) return true;
		} catch {
			// Next.
		}
	}
	return false;
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
		return i420Frame(data, width, height, timestampUs, durationUs);
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

	/** `config` must come from `negotiateAvcConfig` (functionally proven on this engine). */
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
				// Muxing is serialised in output order (decode order; without B-frames it is presentation order).
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
		try {
			this.encoder.configure(config);
		} catch (error) {
			this.close();
			throw error;
		}
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
					// Queued frames produce no output: ask the encoder to complete what it holds.
					this.onStall?.(frame, this.stats);
					await this.flush({ frame, deadline, cancelled });
					stalledSince = Date.now();
				}
				await delay(POLL_MS);
			}
			if (cancelled()) return;
			this.check(frame);
			this.encoder.encode(videoFrame, { keyFrame: frame % KEY_FRAME_INTERVAL === 0 });
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
