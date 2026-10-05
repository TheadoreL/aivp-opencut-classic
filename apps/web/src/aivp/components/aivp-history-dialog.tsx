"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { errorText, type AivpSnapshotMeta } from "../bridge";
import type { AivpEditorController, SnapshotSummary } from "../controller";
import { useAivpStore } from "../store";

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 剪辑版本历史: every immutable server version of this episode's edit,
 * newest first. A version can be inspected and, after explicit
 * confirmation, recovered as a NEW version on top of the current one; no
 * version is ever overwritten or deleted.
 */
export function AivpHistoryDialog({
	controller,
	open,
	onOpenChange,
}: {
	controller: AivpEditorController;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const access = useAivpStore((state) => state.access);
	const canEdit = useAivpStore((state) => state.workspace?.permissions.edit === true);
	const hasConflict = useAivpStore((state) => state.conflict !== null);
	const [items, setItems] = useState<AivpSnapshotMeta[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(1);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<AivpSnapshotMeta | null>(null);
	const [summary, setSummary] = useState<SnapshotSummary | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(
		async (nextPage: number) => {
			setLoading(true);
			setError(null);
			const result = await controller.listHistory(nextPage);
			setLoading(false);
			if (!result.ok) {
				setError(errorText(result.error));
				return;
			}
			setItems((current) => (nextPage === 1 ? result.data.items : [...current, ...result.data.items]));
			setTotal(result.data.total);
			setPage(nextPage);
		},
		[controller],
	);

	useEffect(() => {
		if (!open) return;
		setSelected(null);
		setSummary(null);
		setConfirming(false);
		setMessage(null);
		void load(1);
	}, [open, load]);

	const inspect = async (meta: AivpSnapshotMeta) => {
		setSelected(meta);
		setSummary(null);
		setConfirming(false);
		setMessage(null);
		const result = await controller.inspectSnapshot(meta.snapshotId);
		if (result.ok) setSummary(result.summary);
		else setMessage(result.message);
	};

	const recover = async () => {
		if (selected === null) return;
		setBusy(true);
		setMessage(null);
		const result = await controller.recoverSnapshot(selected.snapshotId);
		setBusy(false);
		setConfirming(false);
		if (result.ok) {
			setMessage(`已恢复为新的第 ${result.revision} 版`);
			void load(1);
		} else {
			setMessage(result.message);
		}
	};

	const latestRevision = items[0]?.revisionNumber ?? 0;
	const recoverDisabled =
		busy || selected === null || access !== "active" || !canEdit || hasConflict || selected.revisionNumber === latestRevision;

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>剪辑版本历史</DialogTitle>
					<DialogDescription>
						每次同步到服务器都会形成一个不可修改的版本。可以查看任意版本，并把它恢复为新的版本；已有版本始终保留。
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="grid grid-cols-[minmax(0,1fr)_280px] gap-4 text-sm">
					<div className="aivp-media-list" role="listbox" aria-label="剪辑版本">
						{error && <p className="text-destructive">{error}</p>}
						{items.length === 0 && !loading && !error && (
							<p className="text-muted-foreground">还没有服务器版本。编辑后会自动同步并形成第一个版本。</p>
						)}
						{items.map((item) => (
							<button
								key={item.snapshotId}
								type="button"
								role="option"
								aria-selected={selected?.snapshotId === item.snapshotId}
								className={`aivp-media-row text-left ${selected?.snapshotId === item.snapshotId ? "border-primary" : ""}`}
								onClick={() => void inspect(item)}
							>
								<div>
									第 {item.revisionNumber} 版{item.revisionNumber === latestRevision ? " · 当前" : ""}
									<small>
										{item.createdByDisplayName ?? "成员"} · {new Date(item.createdAt).toLocaleString("zh-CN")} · 基于第{" "}
										{item.baseRevisionNumber} 版
									</small>
								</div>
								<span className="text-muted-foreground">{formatDuration(item.durationMs)}</span>
							</button>
						))}
						{items.length < total && (
							<Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(page + 1)}>
								{loading ? "读取中…" : "加载更早的版本"}
							</Button>
						)}
					</div>
					<aside className="space-y-3">
						{selected === null ? (
							<p className="text-muted-foreground">选择一个版本查看内容。</p>
						) : (
							<>
								<p>
									<strong>第 {selected.revisionNumber} 版</strong>
									<br />
									<span className="text-muted-foreground">
										{selected.createdByDisplayName ?? "成员"} · {new Date(selected.createdAt).toLocaleString("zh-CN")}
									</span>
								</p>
								{summary ? (
									<ul className="text-muted-foreground space-y-1">
										<li>时长 {formatDuration(selected.durationMs)}</li>
										<li>
											{summary.sceneCount} 个场景 · {summary.trackCount} 条轨道
										</li>
										<li>
											{summary.clipCount} 个片段（其中文字 {summary.textCount} 个）
										</li>
										<li>素材清单 {summary.mediaCount} 项</li>
									</ul>
								) : (
									!message && <p className="text-muted-foreground">正在读取…</p>
								)}
								{confirming && (
									<p className="text-caution" role="alert">
										将把第 {selected.revisionNumber} 版的剪辑恢复为新的第 {latestRevision + 1} 版。第 {latestRevision} 版及更早版本仍保留；本机尚未同步的修改会先另存为本机恢复副本。
									</p>
								)}
							</>
						)}
						{message && <p role="status">{message}</p>}
					</aside>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
						关闭
					</Button>
					{confirming ? (
						<Button disabled={recoverDisabled} onClick={() => void recover()}>
							{busy ? "正在恢复…" : "确认恢复为新版本"}
						</Button>
					) : (
						<Button
							variant="outline"
							disabled={recoverDisabled || summary === null}
							title={selected?.revisionNumber === latestRevision ? "这已是当前版本" : undefined}
							onClick={() => setConfirming(true)}
						>
							恢复为新版本…
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
