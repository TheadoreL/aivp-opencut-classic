import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Preview fullscreen (AIVP C24). The standard Fullscreen API is tried first
 * (prefixed `webkitRequestFullscreen` for older WebKit); when the element API
 * is missing (iPad WKWebView exposes element fullscreen only on video
 * elements) or the request is denied, the container instead fills the editor
 * surface ("viewport" mode). The editor is a native embedded view, not the
 * whole window, so viewport mode covers the editor surface only (in the Mac
 * app the shell grants native fullscreen and widens the editor view to the
 * fullscreen window). Viewport mode is left with the visible exit control,
 * Escape (window capture, consumed immediately so the editor's own Escape
 * shortcuts do not also run), or unmount. Every request is owned by a
 * generation: one settling after unmount, exit or another toggle is dropped,
 * and a late grant is undone. The canvas element stays mounted throughout,
 * so playback position is unaffected.
 */
export type FullscreenMode = "none" | "native" | "viewport";

type WebkitDocument = Document & {
	webkitFullscreenElement?: Element | null;
	webkitFullscreenEnabled?: boolean;
	webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & {
	webkitRequestFullscreen?: () => Promise<void> | void;
};

function fullscreenElement(): Element | null {
	const doc = document as WebkitDocument;
	return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function requestNative(element: HTMLElement): Promise<void> {
	const target = element as WebkitElement;
	const doc = document as WebkitDocument;
	if (typeof target.requestFullscreen === "function" && document.fullscreenEnabled) {
		try {
			return Promise.resolve(target.requestFullscreen());
		} catch (reason) {
			return Promise.reject(reason);
		}
	}
	if (typeof target.webkitRequestFullscreen === "function" && doc.webkitFullscreenEnabled === true) {
		// The prefixed call returns nothing: wait for the change (or error) event, bounded.
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				document.removeEventListener("webkitfullscreenchange", finish);
				document.removeEventListener("webkitfullscreenerror", finish);
				window.clearTimeout(timer);
				if (fullscreenElement() === element) resolve();
				else reject(new Error("denied"));
			};
			document.addEventListener("webkitfullscreenchange", finish);
			document.addEventListener("webkitfullscreenerror", finish);
			const timer = window.setTimeout(finish, 1000);
			try {
				// Newer WebKit returns a promise: its rejection settles (and is handled) like the error event.
				const result: unknown = target.webkitRequestFullscreen?.();
				if (result instanceof Promise) {
					result.then(undefined, finish);
				}
			} catch {
				finish();
			}
		});
	}
	return Promise.reject(new Error("unsupported"));
}

function exitNative(): void {
	const doc = document as WebkitDocument;
	if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
		void doc.exitFullscreen().catch(() => undefined);
	} else if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === "function") {
		void Promise.resolve(doc.webkitExitFullscreen()).catch(() => undefined);
	}
}

export function useFullscreen({
	containerRef,
}: {
	containerRef: React.RefObject<HTMLElement | null>;
}) {
	const [mode, setMode] = useState<FullscreenMode>("none");
	const modeRef = useRef<FullscreenMode>("none");
	const pendingRef = useRef(false);
	/** Bumped by unmount, exit and every new request: a stale settlement never applies (a late grant is undone). */
	const generationRef = useRef(0);
	const mountedRef = useRef(true);

	const apply = useCallback((next: FullscreenMode) => {
		if (!mountedRef.current) return;
		modeRef.current = next;
		setMode(next);
	}, []);

	useEffect(() => {
		const handleChange = () => {
			const container = containerRef.current;
			const active = container !== null && fullscreenElement() === container;
			if (active) apply("native");
			else if (modeRef.current === "native") apply("none");
		};
		document.addEventListener("fullscreenchange", handleChange);
		document.addEventListener("webkitfullscreenchange", handleChange);
		return () => {
			document.removeEventListener("fullscreenchange", handleChange);
			document.removeEventListener("webkitfullscreenchange", handleChange);
		};
	}, [apply, containerRef]);

	// Viewport mode: Escape exits it (native fullscreen handles its own Escape). Consumed immediately so no
	// other window listener (editor shortcuts) also acts on it.
	useEffect(() => {
		if (mode !== "viewport") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			generationRef.current += 1;
			apply("none");
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [mode, apply]);

	// Unmount: drop pending requests and leave native fullscreen if it is ours.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			generationRef.current += 1;
			pendingRef.current = false;
			const container = containerRef.current;
			if (container !== null && fullscreenElement() === container) exitNative();
		};
	}, [containerRef]);

	const exitFullscreen = useCallback(() => {
		generationRef.current += 1;
		pendingRef.current = false;
		if (modeRef.current === "native") exitNative();
		else if (modeRef.current === "viewport") apply("none");
	}, [apply]);

	const toggleFullscreen = useCallback(() => {
		const container = containerRef.current;
		if (!container || pendingRef.current) return;
		if (modeRef.current !== "none" || fullscreenElement() !== null) {
			generationRef.current += 1;
			if (fullscreenElement() !== null) exitNative();
			apply("none");
			return;
		}
		// Called synchronously inside the user's click/tap so the request keeps its activation.
		const ticket = ++generationRef.current;
		const owns = () => mountedRef.current && ticket === generationRef.current;
		pendingRef.current = true;
		requestNative(container).then(
			() => {
				if (owns()) pendingRef.current = false;
				if (!owns()) {
					// Departed while the request settled: never keep a fullscreen nobody shows.
					if (fullscreenElement() === container) exitNative();
					return;
				}
				if (fullscreenElement() === container) apply("native");
			},
			() => {
				if (!owns()) return;
				pendingRef.current = false;
				apply("viewport");
			},
		);
	}, [apply, containerRef]);

	return {
		isFullscreen: mode !== "none",
		fullscreenMode: mode,
		toggleFullscreen,
		exitFullscreen,
	};
}
