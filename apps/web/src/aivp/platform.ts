/**
 * Facts about the engine the embedded editor runs in, read at runtime. The
 * same build runs in Electron (Chromium) and in the iPad shell (WebKit
 * WKWebView); nothing here assumes one from the other.
 */

/**
 * Facilities the editor cannot open a project without. Codec support is
 * probed separately at export time (a missing encoder must not block editing).
 */
export function missingPlatformFeatures(): string[] {
	if (typeof window === "undefined") return ["window"];
	const missing: string[] = [];
	if (!window.isSecureContext) missing.push("安全上下文");
	if (typeof indexedDB === "undefined") missing.push("IndexedDB 本机存储");
	if (typeof crypto === "undefined" || typeof crypto.subtle?.digest !== "function") missing.push("Web Crypto 摘要");
	if (typeof OffscreenCanvas === "undefined") missing.push("OffscreenCanvas 画面合成");
	if (typeof VideoDecoder === "undefined") missing.push("WebCodecs 视频解码");
	if (typeof AudioContext === "undefined" && typeof (window as { webkitAudioContext?: unknown }).webkitAudioContext === "undefined") {
		missing.push("Web Audio");
	}
	return missing;
}

/** Primary input is touch (no hover, coarse pointer): iPad without a trackpad, touch screens. */
export function isTouchPrimary(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/** Any touch input is available (also an iPad with a trackpad or keyboard case attached). */
export function hasTouchInput(): boolean {
	if (typeof window === "undefined") return false;
	return (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
}
