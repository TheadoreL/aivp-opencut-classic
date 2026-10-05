"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { EditorLayout } from "@/components/editor/editor-layout";
import { EditorRuntimeBindings } from "@/components/providers/editor-provider";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import { AivpEditorController } from "../controller";
import { useAivpStore, type AivpEditorState } from "../store";
import { AivpConflictDialog } from "./aivp-conflict-dialog";
import { AivpExportDialog } from "./aivp-export-dialog";

/**
 * AIVP embedded OpenCut Classic editor: the upstream four-panel editor
 * (media bin, preview, properties, real timeline) under an AIVP header with
 * breadcrumb, truthful local/server save state, episode media sync,
 * conflict handling and the export/final-cut flow. All host operations go
 * through the scoped editor bridge.
 */
export function AivpEditorApp() {
	const [controller] = useState(() => AivpEditorController.create());
	const phase = useAivpStore((state) => state.phase);
	const failure = useAivpStore((state) => state.failure);
	const setLoadingProject = useKeybindingsStore((state) => state.setLoadingProject);

	useEffect(() => {
		if (!controller) return;
		void controller.start();
		return () => controller.dispose();
	}, [controller]);

	useEffect(() => {
		setLoadingProject(phase !== "ready");
	}, [phase, setLoadingProject]);

	if (!controller) {
		return (
			<Screen>
				<strong>剪辑器需要在 AIVP 桌面客户端中打开</strong>
				<span className="text-muted-foreground">
					请返回 AIVP 创作台，从“剪辑”中选择一集打开。
				</span>
			</Screen>
		);
	}
	if (phase === "failed") {
		return (
			<Screen>
				<strong>无法打开本集剪辑</strong>
				<span className="text-muted-foreground">{failure}</span>
				<Button variant="outline" onClick={() => window.location.reload()}>
					重试
				</Button>
			</Screen>
		);
	}
	if (phase !== "ready") {
		return (
			<Screen>
				<Loader2 className="size-8 animate-spin text-primary" />
				<span className="text-muted-foreground">
					{phase === "booting" ? "正在验证剪辑会话…" : "正在打开本集剪辑工程…"}
				</span>
			</Screen>
		);
	}
	return <AivpEditorShell controller={controller} />;
}

function Screen({ children }: { children: React.ReactNode }) {
	return (
		<div className="aivp-screen" role="status">
			<div>{children}</div>
		</div>
	);
}

function AivpEditorShell({ controller }: { controller: AivpEditorController }) {
	const [exportOpen, setExportOpen] = useState(false);
	const [conflictOpen, setConflictOpen] = useState(true);
	const conflict = useAivpStore((state) => state.conflict);

	useEffect(() => {
		if (conflict) setConflictOpen(true);
	}, [conflict]);

	return (
		<>
			<EditorRuntimeBindings />
			<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
				<AivpHeader controller={controller} onExport={() => setExportOpen(true)} />
				<AivpBanners controller={controller} onShowConflict={() => setConflictOpen(true)} />
				<div className="min-h-0 min-w-0 flex-1 pt-2">
					<EditorLayout />
				</div>
				<MigrationDialog />
			</div>
			<AivpExportDialog
				controller={controller}
				open={exportOpen}
				onOpenChange={setExportOpen}
			/>
			<AivpConflictDialog
				controller={controller}
				open={conflict !== null && conflictOpen}
				onOpenChange={setConflictOpen}
			/>
		</>
	);
}

function localStatus(state: AivpEditorState["localSave"]): { text: string; tone: string } {
	switch (state.phase) {
		case "saving":
			return { text: "本机保存中…", tone: "busy" };
		case "dirty":
			return { text: "有未保存修改", tone: "warn" };
		case "error":
			return { text: "本机保存失败，正在重试", tone: "danger" };
		default:
			return { text: "本机已保存", tone: "ok" };
	}
}

function serverStatus(
	server: AivpEditorState["server"],
	access: AivpEditorState["access"],
): { text: string; tone: string } {
	if (access === "revoked") return { text: "服务器访问已撤销", tone: "danger" };
	if (access === "signed_out") return { text: "账号已退出", tone: "danger" };
	if (access === "expired") return { text: "剪辑会话已过期", tone: "danger" };
	switch (server.phase) {
		case "synced":
			return {
				text: server.revision > 0 ? `已同步 · 第 ${server.revision} 版` : "已同步",
				tone: "ok",
			};
		case "pending":
			return { text: "待同步到服务器", tone: "warn" };
		case "syncing":
			return { text: "正在同步…", tone: "busy" };
		case "offline":
			return { text: "离线 · 修改保存在本机", tone: "warn" };
		case "conflict":
			return { text: "版本冲突，待处理", tone: "danger" };
		case "error":
			return { text: "同步失败，稍后重试", tone: "danger" };
		case "stopped":
			return { text: "已停止服务器同步", tone: "danger" };
		default:
			return { text: "正在连接…", tone: "busy" };
	}
}

function AivpHeader({
	controller,
	onExport,
}: {
	controller: AivpEditorController;
	onExport: () => void;
}) {
	const workspace = useAivpStore((state) => state.workspace);
	const localSave = useAivpStore((state) => state.localSave);
	const server = useAivpStore((state) => state.server);
	const access = useAivpStore((state) => state.access);
	const mediaSyncing = useAivpStore((state) => state.mediaSyncing);
	const timelineEmpty = useEditor(() => controller.isTimelineEmpty());
	const local = localStatus(localSave);
	const remote = serverStatus(server, access);
	const episodeLabel = workspace
		? `第 ${workspace.episodeNumber ?? workspace.episodeOrdinal} 集${workspace.episodeTitle ? ` · ${workspace.episodeTitle}` : ""}`
		: "";
	const backToStudio = () => {
		void controller.getBridge().focusStudio(controller.getToken());
	};

	return (
		<header className="aivp-header">
			<span className="aivp-brand">
				中诚建川<small>AIVP</small>
			</span>
			<nav className="aivp-crumbs" aria-label="位置">
				<button type="button" onClick={backToStudio} title="返回创作台">
					{workspace?.projectName ?? "项目"}
				</button>
				<span aria-hidden="true">/</span>
				<button type="button" onClick={backToStudio}>
					分集剪辑
				</button>
				<span aria-hidden="true">/</span>
				<strong title={episodeLabel}>{episodeLabel}</strong>
			</nav>
			<span className={`aivp-status aivp-status--${local.tone}`} role="status" title={localSave.error ?? undefined}>
				{local.text}
			</span>
			<span className={`aivp-status aivp-status--${remote.tone}`} role="status" title={server.error ?? undefined}>
				{remote.text}
			</span>
			<div className="ml-auto flex flex-wrap items-center gap-2">
				<MediaPopover controller={controller} />
				<Button
					variant="outline"
					size="sm"
					disabled={mediaSyncing || access !== "active"}
					onClick={() => void controller.syncMedia()}
				>
					{mediaSyncing ? "同步素材中…" : "同步本集素材"}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!timelineEmpty || mediaSyncing}
					title={timelineEmpty ? "按场、镜顺序把当前采用的镜头铺入空时间线" : "仅在时间线为空时可用；同步素材从不修改已有轨道"}
					onClick={() => void controller.populateTimeline()}
				>
					按镜头顺序铺入
				</Button>
				<Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={onExport}>
					导出成片
				</Button>
				<Button variant="ghost" size="sm" onClick={backToStudio}>
					返回创作台
				</Button>
			</div>
		</header>
	);
}

function MediaPopover({ controller }: { controller: AivpEditorController }) {
	const manifest = useAivpStore((state) => state.manifest);
	const mediaStates = useAivpStore((state) => state.mediaStates);
	const manifestError = useAivpStore((state) => state.manifestError);
	const entries = useMemo(
		() =>
			[...(manifest?.entries ?? [])].sort((a, b) => {
				if (a.current !== b.current) return a.current ? -1 : 1;
				return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
			}),
		[manifest],
	);
	const imported = entries.filter((entry) => mediaStates[entry.entryId]?.status === "imported").length;
	const failed = entries.filter((entry) => mediaStates[entry.entryId]?.status === "failed");

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm">
					本集素材 {imported}/{entries.length}
					{failed.length > 0 ? ` · ${failed.length} 失败` : ""}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[420px]" align="end">
				<div className="mb-2 flex items-center justify-between text-sm">
					<strong>本集素材清单</strong>
					{failed.length > 0 && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => void controller.syncMedia({ only: failed.map((entry) => entry.entryId) })}
						>
							重试失败项
						</Button>
					)}
				</div>
				{manifestError && <p className="text-destructive mb-2 text-xs">{manifestError}</p>}
				{entries.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						本集还没有已采用的镜头视频、关键帧或配音。镜头采用后点击“同步本集素材”。
					</p>
				) : (
					<div className="aivp-media-list">
						{entries.map((entry) => {
							const state = mediaStates[entry.entryId];
							const label =
								state?.status === "imported"
									? "已在素材库"
									: state?.status === "downloading"
										? `下载中 ${state.totalBytes > 0 ? Math.floor((state.receivedBytes / state.totalBytes) * 100) : 0}%`
										: state?.status === "queued"
											? "排队中"
											: state?.status === "failed"
												? "失败"
												: entry.current
													? "未导入"
													: "旧版本";
							return (
								<div key={entry.entryId} className="aivp-media-row">
									<div>
										{entry.title}
										<small>
											{entry.current ? "当前采用" : "旧版本（已有片段仍引用）"} · 第 {entry.revisionNumber} 版 ·{" "}
											{(entry.byteLength / 1048576).toFixed(1)} MB
										</small>
										{state?.status === "failed" && <small className="text-destructive">{state.message}</small>}
									</div>
									<span className="text-muted-foreground">{label}</span>
								</div>
							);
						})}
					</div>
				)}
				{(manifest?.skipped.length ?? 0) > 0 && (
					<p className="text-muted-foreground mt-2 text-xs">
						{manifest?.skipped.length} 项来源无法作为剪辑素材（例如模拟结果或不支持的类型），未导入。
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}

function AivpBanners({
	controller,
	onShowConflict,
}: {
	controller: AivpEditorController;
	onShowConflict: () => void;
}) {
	const access = useAivpStore((state) => state.access);
	const accessMessage = useAivpStore((state) => state.accessMessage);
	const conflict = useAivpStore((state) => state.conflict);
	const missing = useAivpStore((state) => state.missing);
	const notice = useAivpStore((state) => state.notice);
	const workspace = useAivpStore((state) => state.workspace);
	const mediaSyncing = useAivpStore((state) => state.mediaSyncing);
	const isDegraded = useEditor((editor) => editor.renderer.isDegraded);
	const set = useAivpStore((state) => state.set);
	const [recoveryCount, setRecoveryCount] = useState(0);

	useEffect(() => {
		setRecoveryCount(controller.recoveryCopyCount());
	}, [controller, notice]);

	const recoverable = missing.filter((item) => item.recoverable);
	const localOnly = missing.filter((item) => !item.recoverable);

	return (
		<>
			{access !== "active" && access !== "offline" && (
				<div className="aivp-banner aivp-banner--danger" role="alert">
					{accessMessage ?? "服务器操作已停止。"} 本机的剪辑与素材仍然保留，可在恢复授权后重新打开继续同步。
				</div>
			)}
			{access === "offline" && (
				<div className="aivp-banner aivp-banner--warn" role="status">
					无法连接服务器。修改保存在本机，恢复连接后自动同步。
				</div>
			)}
			{workspace && !workspace.permissions.edit && (
				<div className="aivp-banner aivp-banner--warn" role="status">
					你在该项目中没有剪辑编辑权限，修改只保存在本机，不会上传为服务器版本。
				</div>
			)}
			{conflict && (
				<div className="aivp-banner aivp-banner--danger" role="alert">
					服务器已有第 {conflict.server.revisionNumber} 版（
					{conflict.server.createdByDisplayName ?? "其他成员"} ·{" "}
					{new Date(conflict.server.createdAt).toLocaleString("zh-CN")}），本机修改基于第{" "}
					{conflict.localBaseRevision} 版，服务器同步已暂停。
					<Button size="sm" variant="outline" onClick={onShowConflict}>
						处理冲突
					</Button>
				</div>
			)}
			{missing.length > 0 && (
				<div className="aivp-banner aivp-banner--warn" role="alert">
					{missing.length} 个素材缺失，相关片段暂时无法预览或导出；剪辑工程本身未作改动。
					{recoverable.length > 0 && (
						<Button size="sm" variant="outline" disabled={mediaSyncing} onClick={() => void controller.recoverMissing()}>
							重新下载 {recoverable.length} 个平台素材
						</Button>
					)}
					{localOnly.length > 0 && (
						<span>
							本机导入的文件需要重新导入：{localOnly.slice(0, 3).map((item) => item.name).join("、")}
							{localOnly.length > 3 ? " 等" : ""}
						</span>
					)}
				</div>
			)}
			{recoveryCount > 0 && !conflict && (
				<div className="aivp-banner aivp-banner--info" role="status">
					本机保留了 {recoveryCount} 份被服务器版本替换前的剪辑副本。
					<Button size="sm" variant="outline" onClick={() => void controller.restoreRecoveryCopy()}>
						恢复最近的本机副本
					</Button>
				</div>
			)}
			{isDegraded && (
				<div className="aivp-banner aivp-banner--warn" role="status">
					当前设备无法启用 GPU 渲染，预览与导出会变慢。
				</div>
			)}
			{notice && (
				<div className="aivp-banner aivp-banner--info" role="status">
					{notice}
					<Button size="sm" variant="ghost" onClick={() => set({ notice: null })}>
						知道了
					</Button>
				</div>
			)}
		</>
	);
}
