/**
 * Coarse export progress facts for diagnostics: a phase name, frame indices
 * and numeric encoder counters only (never media, names, paths or project
 * data). Dispatched as a window event; nothing listens unless a host debug
 * probe is installed (the iPad shell's DEBUG builds forward it to the native
 * log).
 */
export interface ExportStageCounts {
	submitted?: number;
	outputs?: number;
	muxed?: number;
	queue?: number;
	flushes?: number;
	flushesDone?: number;
}

export function reportExportStage({
	phase,
	frame,
	total,
	counts,
}: {
	phase: string;
	frame: number;
	total: number;
	counts?: ExportStageCounts;
}): void {
	if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
	window.dispatchEvent(new CustomEvent("aivp-export-stage", { detail: { phase, frame, total, ...counts } }));
}
