import { registerDefaultGraphics } from "@/graphics";
import {
	type AudioTrack,
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
	type VideoTrack,
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
	if ([...trimmed].some((char) => isControlCharacter({ char }))) return "字幕卡文字包含不可见的控制字符";
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

/** C0 controls except the line feed, and DEL (checked by code point; no control-character regex). */
function isControlCharacter({ char }: { char: string }): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (code < 0x20 && code !== 0x0a) || code === 0x7f;
}

/** Wide (CJK / full-width / East Asian) code points, estimated at one em. */
function isWideCharacter({ char }: { char: string }): boolean {
	const code = char.codePointAt(0) ?? 0;
	return (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000;
}

/** Preferred title size in editor font units (scaled by canvas height / FONT_SIZE_SCALE_REFERENCE). */
const TITLE_PREFERRED_FONT_SIZE = 6;
/** Smallest title glyph we accept, as a fraction of the shorter canvas side (≈32 px at 1080). */
const TITLE_MIN_GLYPH_FRACTION = 0.03;
/** Usable width for the longest line. */
const TITLE_WIDTH_FRACTION = 0.85;

/**
 * Bold title size that keeps the longest line within 85% of the canvas
 * width, using a conservative width estimate (wide glyphs 1.05 em, others
 * 0.7 em). Returns null when even the smallest readable size cannot fit:
 * the text is then refused instead of being clipped or shrunk unreadably.
 */
function titleFontSize({ lines, canvasSize }: { lines: string[]; canvasSize: { width: number; height: number } }): number | null {
	const ems = Math.max(1, ...lines.map((line) => [...line].reduce((sum, char) => sum + (isWideCharacter({ char }) ? 1.05 : 0.7), 0)));
	const pxPerUnit = canvasSize.height / FONT_SIZE_SCALE_REFERENCE;
	const fitting = Math.floor(((canvasSize.width * TITLE_WIDTH_FRACTION) / ems / pxPerUnit) * 10) / 10;
	const minimum = (Math.min(canvasSize.width, canvasSize.height) * TITLE_MIN_GLYPH_FRACTION) / pxPerUnit;
	if (!Number.isFinite(fitting) || fitting < minimum) return null;
	return Math.min(TITLE_PREFERRED_FONT_SIZE, fitting);
}

/** Null when the text can be shown readably on this canvas; otherwise why not (no claim of fit when impossible). */
export function titleCardFitProblem({ text, canvasSize }: { text: string; canvasSize: { width: number; height: number } }): string | null {
	if (!(canvasSize.width > 0 && canvasSize.height > 0)) return "画布尺寸无效";
	const content = text.trim();
	if (content === "") return null;
	return titleFontSize({ lines: content.split("\n"), canvasSize }) === null ? "单行文字过长，在当前画布宽度内无法以可读字号完整显示；请换行或缩短" : null;
}

function shiftElements<TElement extends TimelineElement>({ elements, boundary, duration }: { elements: TElement[]; boundary: MediaTime; duration: MediaTime }): TElement[] {
	return elements.map((element) => (element.startTime >= boundary ? { ...element, startTime: addMediaTime({ a: element.startTime, b: duration }) } : element));
}

/** The same interval shift on every track type (narrowed by the track discriminant, no assertions). */
function shiftOverlayTrack({ track, boundary, duration }: { track: OverlayTrack; boundary: MediaTime; duration: MediaTime }): OverlayTrack {
	switch (track.type) {
		case "video":
			return { ...track, elements: shiftElements({ elements: track.elements, boundary, duration }) };
		case "text":
			return { ...track, elements: shiftElements({ elements: track.elements, boundary, duration }) };
		case "graphic":
			return { ...track, elements: shiftElements({ elements: track.elements, boundary, duration }) };
		case "effect":
			return { ...track, elements: shiftElements({ elements: track.elements, boundary, duration }) };
	}
}

const isVisibleGraphicTrack = (track: OverlayTrack): track is GraphicTrack => track.type === "graphic" && !track.hidden;
const isVisibleTextTrack = (track: OverlayTrack): track is TextTrack => track.type === "text" && !track.hidden;

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
	const problem = titleCardInputProblem({ text, seconds }) ?? titleCardFitProblem({ text, canvasSize });
	if (problem !== null) return { ok: false, reason: problem };
	const content = text.trim();
	const fontSize = titleFontSize({ lines: content.split("\n"), canvasSize });
	if (fontSize === null) return { ok: false, reason: "单行文字过长，在当前画布宽度内无法以可读字号完整显示；请换行或缩短" };
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

	const shift = { boundary: boundaryTime, duration };
	const shiftedOverlay: OverlayTrack[] = tracks.overlay.map((track) => shiftOverlayTrack({ track, ...shift }));
	const main: VideoTrack = { ...tracks.main, elements: shiftElements({ elements: tracks.main.elements, ...shift }) };
	const audio: AudioTrack[] = tracks.audio.map((track) => ({ ...track, elements: shiftElements({ elements: track.elements, ...shift }) }));

	// After the shift [boundary, boundary + duration) is empty on every track (nothing crossed it).
	// Overlay index 0 renders on top: the title track must come before the black frame's track.
	const existingGraphic = shiftedOverlay.find(isVisibleGraphicTrack) ?? null;
	const graphicTrack: GraphicTrack = existingGraphic ?? buildEmptyTrack({ id: generateUUID(), type: "graphic", name: "字幕卡底色" });
	const withGraphic: OverlayTrack[] = existingGraphic === null ? [...shiftedOverlay, graphicTrack] : shiftedOverlay;
	const existingText = withGraphic.slice(0, withGraphic.indexOf(graphicTrack)).find(isVisibleTextTrack) ?? null;
	const textTrack: TextTrack = existingText ?? buildEmptyTrack({ id: generateUUID(), type: "text", name: "字幕卡文字" });
	const ordered: OverlayTrack[] = existingText === null ? [textTrack, ...withGraphic] : withGraphic;

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
			fontSize,
			color: "#ffffff",
			textAlign: "center",
			fontWeight: "bold",
			"background.enabled": false,
			"transform.positionX": 0,
			"transform.positionY": 0,
		},
	};

	const overlay = ordered.map((track): OverlayTrack => {
		if (track === graphicTrack) return { ...graphicTrack, elements: [...graphicTrack.elements, background] };
		if (track === textTrack) return { ...textTrack, elements: [...textTrack.elements, title] };
		return track;
	});

	return { ok: true, after: { overlay, main, audio }, boundaryTime, duration, textElementId, textTrackId: textTrack.id };
}
