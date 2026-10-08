"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useEditor } from "@/editor/use-editor";
import type { ExportFormat, ExportQuality } from "@/export";
import { frameRateToFloat } from "@/fps/utils";
import { mediaTimeToSeconds } from "opencut-wasm";
import { errorText, type AivpExportDetails, type AivpExportFile } from "../bridge";
import type { AivpEditorController } from "../controller";
import {
	AIVP_EXPORT_MAX_SECONDS,
	exportToHost,
	probeExportSupport,
	unsupportedReason,
	usesManagedVideo,
	type AivpFormatSupport,
} from "../export";
import { useAivpStore } from "../store";

const FORMATS: { value: ExportFormat; label: string; video: string }[] = [
	{ value: "mp4", label: "MP4", video: "H.264 视频" },
	{ value: "webm", label: "WebM", video: "VP9 视频" },
];
const QUALITIES: { value: ExportQuality; label: string }[] = [
	{ value: "low", label: "低" },
	{ value: "medium", label: "中" },
	{ value: "high", label: "高" },
	{ value: "very_high", label: "很高" },
];

type Stage =
	| { kind: "setup"; error: string | null }
	| { kind: "exporting"; step: "encoding" | "audio" | "finishing" }
	| {
			kind: "done";
			file: AivpExportFile;
			details: AivpExportDetails;
			snapshotRevision: number | null;
			savedName: string | null;
			upload:
				| { state: "idle" }
				| { state: "uploading"; sent: number; total: number }
				| { state: "done"; revisionNumber: number }
				| { state: "failed"; message: string };
	  };

function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function audioHint(support: AivpFormatSupport | undefined): string {
	if (!support) return "正在检测本机编码能力…";
	if (!support.video) return "本机不支持该视频编码";
	const audio = support.audio;
	if (audio === null) return "本机无法编码音频（可导出无声版本）";
	if (audio.mode === "host-mux") return "AAC 音频（由系统媒体框架编码封装）";
	return audio.codec === "aac" ? "AAC 音频" : "Opus 音频";
}

export function AivpExportDialog({
	controller,
	open,
	onOpenChange,
}: {
	controller: AivpEditorController;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActiveOrNull());
	const exportState = useEditor((e) => e.project.getExportState());
	const durationSeconds = useEditor((e) => mediaTimeToSeconds({ time: e.timeline.getTotalDuration() }));
	const access = useAivpStore((state) => state.access);
	const permissions = useAivpStore((state) => state.workspace?.permissions);
	const host = useAivpStore((state) => state.host);
	const [format, setFormat] = useState<ExportFormat>("mp4");
	const [quality, setQuality] = useState<ExportQuality>("high");
	const [includeAudio, setIncludeAudio] = useState(true);
	const [stage, setStage] = useState<Stage>({ kind: "setup", error: null });
	const [support, setSupport] = useState<AivpFormatSupport[] | null>(null);
	const width = project?.settings.canvasSize.width ?? 0;
	const height = project?.settings.canvasSize.height ?? 0;

	useEffect(() => {
		if (!open) return;
		return controller.getBridge().onEvent((event) => {
			if (event.type !== "upload-progress") return;
			setStage((current) =>
				current.kind === "done" && current.file.exportId === event.exportId && current.upload.state === "uploading"
					? { ...current, upload: { state: "uploading", sent: event.sentBytes, total: event.totalBytes } }
					: current,
			);
		});
	}, [controller, open]);

	// What THIS engine can encode at the project size (probed each time the dialog opens).
	useEffect(() => {
		if (!open || width <= 0 || height <= 0) return;
		let current = true;
		setSupport(null);
		void probeExportSupport({ host, bridge: controller.getBridge(), width, height }).then((result) => {
			if (!current) return;
			setSupport(result);
			const preferred = result.find((item) => item.format === "mp4" && item.video) ?? result.find((item) => item.video);
			if (preferred) setFormat(preferred.format);
		});
		return () => {
			current = false;
		};
	}, [controller, host, open, width, height]);

	if (!project) return null;
	const fps = frameRateToFloat(project.settings.fps);
	const tooLong = durationSeconds > AIVP_EXPORT_MAX_SECONDS;
	const empty = durationSeconds <= 0;
	const selected = support?.find((item) => item.format === format);
	const blocked = support === null ? null : unsupportedReason({ format, quality, includeAudio }, selected);
	const saveLabel = host.shell === "ipados" ? "存储到“文件”…" : "保存到本机…";
	const canShare = host.capabilities.share && typeof controller.getBridge().exports.share === "function";

	const close = (next: boolean) => {
		if (stage.kind === "exporting") return;
		if (stage.kind === "done" && stage.upload.state === "uploading") return;
		if (!next) setStage({ kind: "setup", error: null });
		onOpenChange(next);
	};

	const start = async () => {
		if (blocked !== null || !selected) return;
		setStage({ kind: "exporting", step: "encoding" });
		// Bind the export to a server edit revision: persist and sync first.
		await controller.uploadNow();
		const server = useAivpStore.getState().server;
		const snapshotRevision = server.phase === "synced" && server.revision > 0 ? server.revision : null;
		const outcome = await exportToHost({
			bridge: controller.getBridge(),
			token: controller.getToken(),
			request: { format, quality, includeAudio, fps: project.settings.fps },
			audio: includeAudio ? selected.audio : null,
			managedVideo: usesManagedVideo(host),
			onStage: (step) => setStage({ kind: "exporting", step }),
		});
		if (outcome.status === "done") {
			setStage({ kind: "done", file: outcome.file, details: outcome.details, snapshotRevision, savedName: null, upload: { state: "idle" } });
		} else {
			setStage({ kind: "setup", error: outcome.status === "cancelled" ? "已取消导出，未生成文件" : outcome.message });
		}
	};

	const saveAs = async () => {
		if (stage.kind !== "done") return;
		const result = await controller.getBridge().exports.saveAs(controller.getToken(), stage.file.exportId);
		if (!result.ok) {
			setStage({ ...stage, upload: stage.upload, savedName: null });
			useAivpStore.getState().set({ notice: `保存失败：${errorText(result.error)}` });
			return;
		}
		if (result.data.status === "saved") setStage({ ...stage, savedName: result.data.fileName });
	};

	const share = async () => {
		const shareExport = controller.getBridge().exports.share;
		if (stage.kind !== "done" || !shareExport) return;
		const result = await shareExport(controller.getToken(), stage.file.exportId);
		if (!result.ok) useAivpStore.getState().set({ notice: `共享失败：${errorText(result.error)}` });
	};

	const upload = async () => {
		if (stage.kind !== "done" || stage.snapshotRevision === null) return;
		setStage({ ...stage, upload: { state: "uploading", sent: 0, total: stage.file.byteLength } });
		const result = await controller
			.getBridge()
			.exports.upload(controller.getToken(), stage.file.exportId, { snapshotRevision: stage.snapshotRevision });
		setStage((current) =>
			current.kind !== "done"
				? current
				: {
						...current,
						upload: result.ok
							? { state: "done", revisionNumber: result.data.revisionNumber }
							: { state: "failed", message: errorText(result.error) },
					},
		);
	};

	const stepText =
		stage.kind !== "exporting"
			? ""
			: stage.step === "audio"
				? "正在写入音频…"
				: stage.step === "finishing"
					? "正在封装、校验并完成文件…"
					: `正在渲染与编码… ${Math.floor(exportState.progress * 100)}%`;

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>导出本集成片</DialogTitle>
					<DialogDescription>
						使用剪辑器的实际渲染编码输出视频文件。文件先写入本机受控的导出目录，再由你选择保存位置或上传为成片候选。
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4 text-sm">
					{stage.kind === "setup" && (
						<>
							<div className="grid grid-cols-2 gap-2 text-muted-foreground">
								<span>画面尺寸：{width} × {height}</span>
								<span>帧率：{Number.isInteger(fps) ? fps : fps.toFixed(3)} fps</span>
								<span>时长：{formatDuration(durationSeconds * 1000)}</span>
								<span>上限：{AIVP_EXPORT_MAX_SECONDS / 60} 分钟</span>
							</div>
							<div className="space-y-2">
								<Label>格式</Label>
								<RadioGroup value={format} onValueChange={(value) => setFormat(value as ExportFormat)}>
									{FORMATS.map((item) => {
										const itemSupport = support?.find((entry) => entry.format === item.value);
										const disabled = support !== null && itemSupport?.video !== true;
										return (
											<div key={item.value} className="flex items-center gap-2">
												<RadioGroupItem value={item.value} id={`aivp-format-${item.value}`} disabled={disabled} />
												<Label htmlFor={`aivp-format-${item.value}`} className={disabled ? "opacity-60" : undefined}>
													{item.label} <span className="text-muted-foreground">· {item.video} + {audioHint(itemSupport)}</span>
												</Label>
											</div>
										);
									})}
								</RadioGroup>
							</div>
							<div className="space-y-2">
								<Label>质量</Label>
								<RadioGroup className="flex flex-wrap gap-4" value={quality} onValueChange={(value) => setQuality(value as ExportQuality)}>
									{QUALITIES.map((item) => (
										<div key={item.value} className="flex items-center gap-2">
											<RadioGroupItem value={item.value} id={`aivp-quality-${item.value}`} />
											<Label htmlFor={`aivp-quality-${item.value}`}>{item.label}</Label>
										</div>
									))}
								</RadioGroup>
							</div>
							<div className="flex items-center gap-2">
								<Checkbox id="aivp-include-audio" checked={includeAudio} onCheckedChange={(value) => setIncludeAudio(value === true)} />
								<Label htmlFor="aivp-include-audio">包含音频</Label>
							</div>
							{support === null && <p className="text-muted-foreground" role="status">正在检测本机支持的编码…</p>}
							{blocked && <p className="text-caution" role="alert">{blocked}</p>}
							{empty && <p className="text-caution">时间线为空，无法导出。</p>}
							{tooLong && <p className="text-caution">时长超过当前导出上限，请分段导出。</p>}
							{stage.error && <p className="text-destructive" role="alert">{stage.error}</p>}
						</>
					)}
					{stage.kind === "exporting" && (
						<div className="space-y-3" role="status">
							<p>{stepText}</p>
							<Progress value={stage.step === "encoding" ? exportState.progress * 100 : 100} />
							<p className="text-muted-foreground">导出期间请勿关闭剪辑器或离开本页。取消后不会保留不完整的文件。</p>
						</div>
					)}
					{stage.kind === "done" && (
						<div className="space-y-3">
							<p className="text-constructive">已导出 {stage.file.fileName}</p>
							<div className="grid grid-cols-2 gap-2 text-muted-foreground">
								<span>编码：{stage.details.videoCodec === "avc" ? "H.264" : "VP9"} / {stage.details.audioCodec === null ? "无音频" : stage.details.audioCodec.toUpperCase()}</span>
								<span>尺寸：{stage.details.width} × {stage.details.height}</span>
								<span>帧率：{(stage.details.fpsNumerator / stage.details.fpsDenominator).toFixed(3).replace(/\.?0+$/, "")} fps · {stage.details.frameCount} 帧</span>
								<span>时长：{formatDuration(stage.details.durationMs)}</span>
								<span>大小：{(stage.file.byteLength / 1048576).toFixed(1)} MB</span>
								<span title={stage.file.sha256}>SHA-256：{stage.file.sha256.slice(0, 12)}…</span>
							</div>
							{stage.savedName && <p>已保存：{stage.savedName}</p>}
							{stage.snapshotRevision === null ? (
								<p className="text-caution">
									导出时剪辑未能同步到服务器，无法登记来源剪辑版本，因此不能上传为成片候选。请恢复同步后重新导出。
								</p>
							) : (
								<p className="text-muted-foreground">来源剪辑版本：第 {stage.snapshotRevision} 版</p>
							)}
							{stage.upload.state === "uploading" && (
								<div className="space-y-2" role="status">
									<p>正在上传… {stage.upload.total > 0 ? Math.floor((stage.upload.sent / stage.upload.total) * 100) : 0}%</p>
									<Progress value={stage.upload.total > 0 ? (stage.upload.sent / stage.upload.total) * 100 : 0} />
								</div>
							)}
							{stage.upload.state === "done" && (
								<p className="text-constructive">
									已上传为第 {stage.upload.revisionNumber} 版成片候选。请在“成片工坊”采用并提交审核。
								</p>
							)}
							{stage.upload.state === "failed" && <p className="text-destructive" role="alert">上传失败：{stage.upload.message}</p>}
						</div>
					)}
				</DialogBody>
				<DialogFooter className="flex-wrap gap-2">
					{stage.kind === "setup" && (
						<>
							<Button variant="ghost" onClick={() => close(false)}>
								关闭
							</Button>
							<Button disabled={empty || tooLong || support === null || blocked !== null} onClick={() => void start()}>
								开始导出
							</Button>
						</>
					)}
					{stage.kind === "exporting" && stage.step === "encoding" && (
						<Button variant="outline" onClick={() => editor.project.cancelExport()}>
							取消导出
						</Button>
					)}
					{stage.kind === "done" && (
						<>
							<Button variant="ghost" disabled={stage.upload.state === "uploading"} onClick={() => close(false)}>
								完成
							</Button>
							<Button variant="outline" onClick={() => void saveAs()}>
								{saveLabel}
							</Button>
							{canShare && (
								<Button variant="outline" onClick={() => void share()}>
									共享…
								</Button>
							)}
							<Button
								disabled={
									stage.snapshotRevision === null ||
									access !== "active" ||
									permissions?.uploadFinalCut !== true ||
									stage.upload.state === "uploading" ||
									stage.upload.state === "done"
								}
								onClick={() => void upload()}
							>
								上传为成片候选
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
