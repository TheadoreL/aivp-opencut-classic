/**
 * Coarse export progress facts for diagnostics: a phase name and frame
 * indices only (never media, names, paths or project data). Dispatched as a
 * window event; nothing listens unless a host debug probe is installed (the
 * iPad shell's DEBUG builds forward it to the native log).
 */
export function reportExportStage({ phase, frame, total }: { phase: string; frame: number; total: number }): void {
	if (typeof window === "undefined" || typeof CustomEvent !== "function") return;
	window.dispatchEvent(new CustomEvent("aivp-export-stage", { detail: { phase, frame, total } }));
}
