"use client";

import { useState } from "react";
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
import type { AivpEditorController } from "../controller";
import { useAivpStore } from "../store";

/**
 * Optimistic-concurrency conflict between this window's local work and a
 * newer server snapshot (another window/device saved first). Nothing is
 * replaced until the user decides; both choices keep the other side
 * recoverable (server history, or a local recovery copy).
 */
export function AivpConflictDialog({
	controller,
	open,
	onOpenChange,
}: {
	controller: AivpEditorController;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const conflict = useAivpStore((state) => state.conflict);
	const [busy, setBusy] = useState(false);
	if (!conflict) return null;

	const decide = async (choice: "server" | "local") => {
		setBusy(true);
		try {
			await controller.resolveConflict(choice);
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>剪辑版本冲突</DialogTitle>
					<DialogDescription>
						{conflict.origin === "open"
							? "本机有尚未同步的修改，而服务器上已有更新的版本。"
							: "上传时发现服务器上已有其他窗口或设备保存的更新版本。"}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-3 text-sm">
					<p>
						服务器最新：第 {conflict.server.revisionNumber} 版，由{" "}
						{conflict.server.createdByDisplayName ?? "其他成员"}于{" "}
						{new Date(conflict.server.createdAt).toLocaleString("zh-CN")} 保存。
					</p>
					<p>本机修改基于第 {conflict.localBaseRevision} 版，目前只保存在本机。</p>
					<ul className="text-muted-foreground list-disc space-y-1 pl-5">
						<li>使用服务器版本：载入第 {conflict.server.revisionNumber} 版；本机内容保留为恢复副本，可随时恢复。</li>
						<li>保留本机版本：把本机内容保存为新的服务器版本；第 {conflict.server.revisionNumber} 版仍保留在历史中。</li>
					</ul>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
						稍后处理
					</Button>
					<Button variant="outline" disabled={busy} onClick={() => void decide("server")}>
						使用服务器版本
					</Button>
					<Button disabled={busy} onClick={() => void decide("local")}>
						保留本机版本
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
