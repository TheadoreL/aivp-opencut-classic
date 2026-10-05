/**
 * AIVP embedded editor build switch (`bun run build:aivp`). Inlined at build
 * time; the regular OpenCut build is unaffected.
 *
 * The AIVP build runs inside the AIVP desktop host with a strict CSP and no
 * network access of its own: features that depend on remote services
 * (Google font CSS, Freesound search, remote sticker/logo CDNs, model
 * downloads for transcription, feedback, telemetry) are hidden or reduced
 * to local behaviour instead of failing at runtime.
 */
export const IS_AIVP_EDITOR = process.env.NEXT_PUBLIC_AIVP_EDITOR === "1";

/**
 * Fonts offered in the AIVP editor: generic and commonly installed system
 * families only (nothing is downloaded). A family missing on a machine
 * falls back to the platform default, as in any desktop application.
 */
export const AIVP_LOCAL_FONTS: readonly string[] = [
	"Arial",
	"Helvetica",
	"Times New Roman",
	"Courier New",
	"Verdana",
	"Georgia",
	"PingFang SC",
	"Hiragino Sans GB",
	"Microsoft YaHei",
	"SimHei",
	"SimSun",
	"Noto Sans CJK SC",
	"Source Han Sans SC",
	"monospace",
	"sans-serif",
	"serif",
];
