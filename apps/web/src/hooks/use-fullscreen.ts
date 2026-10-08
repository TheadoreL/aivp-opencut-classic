import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Preview fullscreen (AIVP C24). The standard Fullscreen API is tried first
 * (prefixed `webkitRequestFullscreen` for older WebKit); when the element API
 * is missing (iPad WKWebView exposes element fullscreen only on video
 * elements) or the request is denied, the container instead fills the editor
 * surface ("viewport" mode). The editor is a native embedded view, not the
 * whole window, so viewport mode covers the editor surface only. Viewport
 * mode is left with the visible exit control, Escape (window capture, so the
 * editor's own Escape shortcuts do not also run), or unmount. The canvas
 * element stays mounted throughout, so playback position is unaffected.
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
				void target.webkitRequestFullscreen?.();
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

	const apply = useCallback((next: FullscreenMode) => {
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

	// Viewport mode: Escape exits it (native fullscreen handles its own Escape).
	useEffect(() => {
		if (mode !== "viewport") return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			apply("none");
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [mode, apply]);

	// Unmount: leave native fullscreen if it is ours.
	useEffect(
		() => () => {
			const container = containerRef.current;
			if (container !== null && fullscreenElement() === container) exitNative();
		},
		[containerRef],
	);

	const exitFullscreen = useCallback(() => {
		if (modeRef.current === "native") exitNative();
		else if (modeRef.current === "viewport") apply("none");
	}, [apply]);

	const toggleFullscreen = useCallback(() => {
		const container = containerRef.current;
		if (!container || pendingRef.current) return;
		if (modeRef.current !== "none" || fullscreenElement() !== null) {
			if (fullscreenElement() !== null) exitNative();
			apply("none");
			return;
		}
		// Called synchronously inside the user's click/tap so the request keeps its activation.
		pendingRef.current = true;
		requestNative(container)
			.then(() => {
				if (fullscreenElement() === container) apply("native");
			})
			.catch(() => apply("viewport"))
			.finally(() => {
				pendingRef.current = false;
			});
	}, [apply, containerRef]);

	return {
		isFullscreen: mode !== "none",
		fullscreenMode: mode,
		toggleFullscreen,
		exitFullscreen,
	};
}
