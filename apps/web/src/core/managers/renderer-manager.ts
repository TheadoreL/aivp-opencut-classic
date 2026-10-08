import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type {
	ExportDetails,
	ExportOptions,
	ExportResult,
	ExportStreamChunk,
} from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { reportExportStage } from "@/services/renderer/export-diagnostics";
import { ExportStageError } from "@/services/renderer/managed-video-encoder";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/media/audio";
import { formatTimecode } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { downloadBlob } from "@/utils/browser";

/** Longest the timeline audio mix (decode + mix of every source) may take before an export fails. */
const MIX_TIMEOUT_MS = 180_000;

/** Waits for the audio mix, polling cancellation; fails with an actionable error when it does not settle in time. */
async function boundedMix(
	work: Promise<AudioBuffer | null>,
	cancelled: () => boolean,
): Promise<AudioBuffer | null | "cancelled"> {
	const started = Date.now();
	const state: { done: boolean; value: AudioBuffer | null; error: unknown } = { done: false, value: null, error: null };
	const finished = work.then(
		(value) => {
			state.done = true;
			state.value = value;
		},
		(error: unknown) => {
			state.done = true;
			state.error = error ?? new Error("音频混合失败");
		},
	);
	while (!state.done) {
		await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 100))]);
		if (state.done) break;
		if (cancelled()) return "cancelled";
		if (Date.now() - started > MIX_TIMEOUT_MS) {
			throw new ExportStageError("mix", 0, "音频解码与混合超时，已停止导出。剪辑工程未受影响，可取消“包含音频”后重试或改用桌面客户端导出。");
		}
	}
	if (state.error !== null) throw state.error;
	return state.value;
}

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		onProgress,
		onCancel,
		writable,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
		/** When given, container bytes are streamed here instead of returned as a buffer. */
		writable?: WritableStream<ExportStreamChunk>;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio, audioCodec, externalAudio, videoPipeline } = options;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				reportExportStage({ phase: "mix", frame: 0, total: 0 });
				// Bounded and cancellable: decoding/mixing every audio source must not hang the export.
				const mixed = await boundedMix(
					createTimelineAudioBuffer({
						tracks,
						mediaAssets,
						duration,
					}),
					() => onCancel?.() === true,
				);
				if (mixed === "cancelled") return { success: false, cancelled: true };
				audioBuffer = mixed;
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				// An external mix is muxed by the host: the container gets video only.
				shouldIncludeAudio: !!includeAudio && !externalAudio,
				audioBuffer: audioBuffer || undefined,
				audioCodec,
				videoPipeline,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const detailsOf = (): ExportDetails | undefined => {
					const encoded = exporter.getEncodedDetails();
					return encoded ? { format, ...encoded } : undefined;
				};

				if (writable) {
					const completed = await exporter.exportToStream({
						rootNode: scene,
						writable,
					});
					clearInterval(cancelInterval);
					if (cancelled || !completed) {
						return { success: false, cancelled: true };
					}
					return {
						success: true,
						streamed: true,
						details: detailsOf(),
						...(externalAudio ? { externalAudio: includeAudio ? audioBuffer : null } : {}),
					};
				}

				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				if (cancelled) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer,
					details: detailsOf(),
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
