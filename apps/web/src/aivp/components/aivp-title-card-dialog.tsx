"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { TracksSnapshotCommand } from "@/commands/timeline";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";
import { useAivpStore } from "../store";
import {
	planTitleCardInsertion,
	TITLE_CARD_DEFAULT_SECONDS,
	TITLE_CARD_DURATION_MAX_SECONDS,
	TITLE_CARD_DURATION_MIN_SECONDS,
	TITLE_CARD_TEXT_MAX,
	titleCardBoundaryKey,
	titleCardBoundaryOptions,
	titleCardFontFamily,
	titleCardInputProblem,
} from "../title-card";

/**
 * 插入字幕卡: white centred title on a full black frame, inserted at an
 * explicit boundary of the main track. Later elements on every track move
 * by the same interval; the insertion is one undo step and goes through the
 * normal local/server saves. Nothing happens until “插入”.
 */
export function AivpTitleCardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const editor = useEditor();
	const tracks = useEditor((core) => core.scenes.getActiveSceneOrNull()?.tracks ?? null);
	const selected = useEditor((core) => core.selection.getSelectedElements());
	const ids = { text: useId(), seconds: useId(), boundary: useId(), error: useId() };
	const [text, setText] = useState("");
	const [secondsInput, setSecondsInput] = useState(String(TITLE_CARD_DEFAULT_SECONDS));
	const [boundaryKey, setBoundaryKey] = useState("end");
	const [error, setError] = useState<string | null>(null);

	const options = useMemo(() => (tracks === null ? [] : titleCardBoundaryOptions({ tracks })), [tracks]);

	// On open: default to the boundary before the selected main-track clip (else the end); keep the typed text.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only re-evaluated when the dialog opens
	useEffect(() => {
		if (!open || tracks === null) return;
		const selectedMain = selected.find((ref) => ref.trackId === tracks.main.id && tracks.main.elements.some((element) => element.id === ref.elementId));
		setBoundaryKey(selectedMain ? titleCardBoundaryKey({ kind: "before", elementId: selectedMain.elementId }) : "end");
		setSecondsInput(String(TITLE_CARD_DEFAULT_SECONDS));
		setError(null);
	}, [open]);

	const seconds = Number(secondsInput.trim());
	const inputProblem = titleCardInputProblem({ text, seconds: secondsInput.trim() === "" ? Number.NaN : seconds });
	const option = options.find((entry) => entry.key === boundaryKey) ?? null;

	const insert = () => {
		setError(null);
		// Re-read the CURRENT scene at submit time: a stale or vanished boundary is refused, never guessed.
		const scene = editor.scenes.getActiveSceneOrNull();
		const project = editor.project.getActiveOrNull();
		const current = scene === null ? [] : titleCardBoundaryOptions({ tracks: scene.tracks });
		const chosen = current.find((entry) => entry.key === boundaryKey);
		if (scene === null || project === null || chosen === undefined) {
			setError("所选插入位置已不存在（时间线已变化），请重新选择");
			return;
		}
		const plan = planTitleCardInsertion({
			tracks: scene.tracks,
			boundary: chosen.boundary,
			text,
			seconds,
			canvasSize: project.settings.canvasSize,
			fontFamily: titleCardFontFamily(),
		});
		if (!plan.ok) {
			setError(plan.reason);
			return;
		}
		editor.command.execute({ command: new TracksSnapshotCommand({ before: scene.tracks, after: plan.after }) });
		useAivpStore.getState().set({ notice: `已在${chosen.boundary.kind === "end" ? "时间线末尾" : "所选片段之前"}插入 ${seconds} 秒字幕卡，后续片段与音频已同步后移，可撤销` });
		setText("");
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>插入字幕卡</DialogTitle>
					<DialogDescription>
						在主轨所选位置插入黑底白字的字幕卡；该位置之后所有轨道上的片段（含音频）同步后移相同时长。可撤销。
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4 text-sm">
					<div className="space-y-1.5">
						<Label htmlFor={ids.text}>字幕卡文字</Label>
						<Textarea
							id={ids.text}
							value={text}
							rows={2}
							maxLength={TITLE_CARD_TEXT_MAX + 10}
							placeholder="例如：三天后"
							aria-describedby={error !== null || inputProblem !== null ? ids.error : undefined}
							onChange={(event) => setText(event.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							最多 {TITLE_CARD_TEXT_MAX} 字、3 行；白色粗体居中，使用本机中文字体。
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={ids.seconds}>时长（秒）</Label>
						<Input
							id={ids.seconds}
							type="number"
							inputMode="decimal"
							min={TITLE_CARD_DURATION_MIN_SECONDS}
							max={TITLE_CARD_DURATION_MAX_SECONDS}
							step={0.5}
							value={secondsInput}
							onChange={(event) => setSecondsInput(event.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={ids.boundary}>插入位置</Label>
						<select
							id={ids.boundary}
							className="border-border bg-input h-9 w-full rounded-md border px-3 text-sm"
							value={boundaryKey}
							onChange={(event) => setBoundaryKey(event.target.value)}
						>
							{options.map((entry) => (
								<option key={entry.key} value={entry.key}>
									{entry.label}
								</option>
							))}
						</select>
						{options.length === 1 && <p className="text-muted-foreground text-xs">主轨还没有画面片段，只能插入在时间线末尾。</p>}
					</div>
					{(error ?? (text.trim() === "" ? null : inputProblem)) !== null && (
						<p id={ids.error} className="text-destructive text-sm" role="alert">
							{error ?? inputProblem}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						取消
					</Button>
					<Button disabled={inputProblem !== null || option === null || tracks === null} onClick={insert}>
						插入
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
