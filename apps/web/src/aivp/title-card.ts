import { registerDefaultGraphics } from "@/graphics";
import {
	buildGraphicElement,
	calculateTotalDuration,
	type GraphicElement,
	type GraphicTrack,
	type OverlayTrack,
	type SceneTracks,
	type TextElement,
	type TextTrack,
	type TimelineElement,
	type TimelineTrack,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";

/*
 * AIVP Classic "插入字幕卡" (title card): a pure plan over the active scene's
 * tracks, applied by the caller as ONE TracksSnapshotCommand (one undo step,
 * normal local/server saves). It opens a gap of exactly the chosen duration
 * at a boundary, shifting every element at or after the boundary on every
 * track by the same interval (sync preserved; media references, trims,
 * params, keyframes and audio settings are untouched), and fills the gap
 * with a full-frame black rectangle (independent of the project background)
 * under a centred white title. An element crossing the boundary refuses the
 * whole insertion: nothing is split, overlapped or moved.
 */

export const TITLE_CARD_TEXT_MAX = 80;
export const TITLE_CARD_LINES_MAX = 3;
export const TITLE_CARD_DURATION_MIN_SECONDS = 0.5;
export const TITLE_CARD_DURATION_MAX_SECONDS = 60;
export const TITLE_CARD_DEFAULT_SECONDS = 3;

export type TitleCardBoundary = { kind: "before"; elementId: string } | { kind: "end" };

export interface TitleCardBoundaryOption {
	key: string;
	label: string;
	boundary: TitleCardBoundary;
	time: MediaTime;
}

export type TitleCardPlan =
	| { ok: true; after: SceneTracks; boundaryTime: MediaTime; duration: MediaTime; textElementId: string; textTrackId: string }
	| { ok: false; reason: string };

const keyOf = (boundary: TitleCardBoundary): string => (boundary.kind === "end" ? "end" : `before:${boundary.elementId}`);

function formatClock(time: MediaTime): string {
	const total = Math.max(0, mediaTimeToSeconds({ time }));
	const minutes = Math.floor(total / 60);
	const seconds = total - minutes * 60;
	return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Boundaries offered to the user: before each main-track visual clip (timeline order), or at the end. */
export function titleCardBoundaryOptions({ tracks }: { tracks: SceneTracks }): TitleCardBoundaryOption[] {
	const clips = [...tracks.main.elements].sort((a, b) => (a.startTime !== b.startTime ? a.startTime - b.startTime : a.id.localeCompare(b.id)));
	const options: TitleCardBoundaryOption[] = clips.map((clip, index) => {
		const boundary: TitleCardBoundary = { kind: "before", elementId: clip.id };
		return { key: keyOf(boundary), boundary, time: clip.startTime, label: `第 ${index + 1} 段「${clip.name}」之前（${formatClock(clip.startTime)}）` };
	});
	const end = calculateTotalDuration({ tracks });
	options.push({ key: "end", boundary: { kind: "end" }, time: end, label: `时间线末尾（${formatClock(end)}）` });
	return options;
}

export function titleCardBoundaryKey(boundary: TitleCardBoundary): string {
	return keyOf(boundary);
}

/** Boundary time against the CURRENT tracks (null when the chosen clip no longer exists on the main track). */
export function resolveTitleCardBoundary({ tracks, boundary }: { tracks: SceneTracks; boundary: TitleCardBoundary }): MediaTime | null {
	if (boundary.kind === "end") return calculateTotalDuration({ tracks });
	return tracks.main.elements.find((element) => element.id === boundary.elementId)?.startTime ?? null;
}

/** User input problems (null = valid). Text is trimmed; duration must be finite and bounded. */
export function titleCardInputProblem({ text, seconds }: { text: string; seconds: number }): string | null {
	const trimmed = text.trim();
	if (trimmed === "") return "请输入字幕卡文字";
	if ([...trimmed].length > TITLE_CARD_TEXT_MAX) return `字幕卡文字最多 ${TITLE_CARD_TEXT_MAX} 个字`;
	if (trimmed.split("\n").length > TITLE_CARD_LINES_MAX) return `字幕卡最多 ${TITLE_CARD_LINES_MAX} 行`;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(trimmed)) return "字幕卡文字包含不可见的控制字符";
	if (!Number.isFinite(seconds) || seconds < TITLE_CARD_DURATION_MIN_SECONDS || seconds > TITLE_CARD_DURATION_MAX_SECONDS) {
		return `时长必须在 ${TITLE_CARD_DURATION_MIN_SECONDS}–${TITLE_CARD_DURATION_MAX_SECONDS} 秒之间`;
	}
	return null;
}

/** A locally installed CJK family per platform; the renderer always appends the generic sans-serif fallback. */
export function titleCardFontFamily(): string {
	const platform = typeof navigator === "undefined" ? "" : navigator.userAgent;
	if (/Mac|iPhone|iPad/i.test(platform)) return "PingFang SC";
	if (/Windows/i.test(platform)) return "Microsoft YaHei";
	return "Noto Sans CJK SC";
}

/**
 * Font size (editor units, scaled by canvas height / FONT_SIZE_SCALE_REFERENCE)
 * that keeps the longest line within ~85% of the canvas width. CJK glyphs
 * are about one em wide, other characters about 0.6 em.
 */
function titleFontSize({ lines, canvasWidth, canvasHeight }: { lines: string[]; canvasWidth: number; canvasHeight: number }): number {
	const preferred = 6;
	const ems = Math.max(1, ...lines.map((line) => [...line].reduce((sum, char) => sum + (/[⺀-￯]/.test(char) ? 1 : 0.6), 0)));
	const pxPerUnit = canvasHeight / FONT_SIZE_SCALE_REFERENCE;
	const fitting = (canvasWidth * 0.85) / ems / pxPerUnit;
	return Math.max(2, Math.min(preferred, Math.floor(fitting * 10) / 10));
}

function shiftElements<TElement extends TimelineElement>(elements: TElement[], boundary: MediaTime, duration: MediaTime): TElement[] {
	return elements.map((element) => (element.startTime >= boundary ? { ...element, startTime: addMediaTime({ a: element.startTime, b: duration }) } : element));
}

function shiftTrack<TTrack extends TimelineTrack>(track: TTrack, boundary: MediaTime, duration: MediaTime): TTrack {
	return { ...track, elements: shiftElements(track.elements as TimelineElement[], boundary, duration) } as TTrack;
}

export function planTitleCardInsertion({
	tracks,
	boundary,
	text,
	seconds,
	canvasSize,
	fontFamily,
}: {
	tracks: SceneTracks;
	boundary: TitleCardBoundary;
	text: string;
	seconds: number;
	canvasSize: { width: number; height: number };
	fontFamily: string;
}): TitleCardPlan {
	const problem = titleCardInputProblem({ text, seconds });
	if (problem !== null) return { ok: false, reason: problem };
	const boundaryTime = resolveTitleCardBoundary({ tracks, boundary });
	if (boundaryTime === null) return { ok: false, reason: "所选插入位置的片段已不在主轨上（时间线已变化），请重新选择" };
	const duration = mediaTimeFromSeconds({ seconds });
	if (duration <= 0) return { ok: false, reason: "时长无效" };

	const allTracks: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
	const crossing = allTracks.flatMap((track) => track.elements.filter((element) => element.startTime < boundaryTime && element.startTime + element.duration > boundaryTime));
	if (crossing.length > 0) {
		const names = crossing.slice(0, 3).map((element) => `「${element.name}」`).join("、");
		return { ok: false, reason: `${names}${crossing.length > 3 ? ` 等 ${crossing.length} 个片段` : ""}跨越所选插入位置；为避免拆分或错位，未做任何修改。请先调整这些片段或选择其他位置` };
	}

	const shiftedOverlay: OverlayTrack[] = tracks.overlay.map((track) => shiftTrack(track, boundaryTime, duration));
	const main = shiftTrack(tracks.main, boundaryTime, duration);
	const audio = tracks.audio.map((track) => shiftTrack(track, boundaryTime, duration));

	// After the shift [boundary, boundary + duration) is empty on every track (nothing crossed it).
	// Overlay index 0 renders on top: the title must sit above the black frame.
	let graphicIndex = shiftedOverlay.findIndex((track) => track.type === "graphic" && !track.hidden);
	if (graphicIndex < 0) {
		shiftedOverlay.push(buildEmptyTrack({ id: generateUUID(), type: "graphic", name: "字幕卡底色" }));
		graphicIndex = shiftedOverlay.length - 1;
	}
	let textIndex = shiftedOverlay.findIndex((track, index) => index < graphicIndex && track.type === "text" && !track.hidden);
	if (textIndex < 0) {
		shiftedOverlay.unshift(buildEmptyTrack({ id: generateUUID(), type: "text", name: "字幕卡文字" }));
		textIndex = 0;
		graphicIndex += 1;
	}

	// Full-frame black: the 512² graphic is contained to min(W,H), so scale each axis to cover (1% overscan).
	registerDefaultGraphics();
	const side = Math.min(canvasSize.width, canvasSize.height);
	const background: GraphicElement = {
		...buildGraphicElement({
			definitionId: "rectangle",
			name: "字幕卡底色",
			startTime: boundaryTime,
			params: {
				fill: "#000000",
				strokeWidth: 0,
				cornerRadius: 0,
				"transform.scaleX": (canvasSize.width / side) * 1.01,
				"transform.scaleY": (canvasSize.height / side) * 1.01,
				"transform.positionX": 0,
				"transform.positionY": 0,
				opacity: 1,
			},
		}),
		id: generateUUID(),
		duration,
	};

	const content = text.trim();
	const lines = content.split("\n");
	const textElementId = generateUUID();
	const title: TextElement = {
		...DEFAULTS.text.element,
		id: textElementId,
		name: `字幕卡：${[...content.replaceAll("\n", " ")].slice(0, 20).join("")}`,
		startTime: boundaryTime,
		duration,
		params: {
			...DEFAULTS.text.element.params,
			content,
			fontFamily,
			fontSize: titleFontSize({ lines, canvasWidth: canvasSize.width, canvasHeight: canvasSize.height }),
			color: "#ffffff",
			textAlign: "center",
			fontWeight: "bold",
			"background.enabled": false,
			"transform.positionX": 0,
			"transform.positionY": 0,
		},
	};

	const graphicTrack = shiftedOverlay[graphicIndex] as GraphicTrack;
	shiftedOverlay[graphicIndex] = { ...graphicTrack, elements: [...graphicTrack.elements, background] };
	const textTrack = shiftedOverlay[textIndex] as TextTrack;
	shiftedOverlay[textIndex] = { ...textTrack, elements: [...textTrack.elements, title] };

	return { ok: true, after: { overlay: shiftedOverlay, main, audio }, boundaryTime, duration, textElementId, textTrackId: textTrack.id };
}
