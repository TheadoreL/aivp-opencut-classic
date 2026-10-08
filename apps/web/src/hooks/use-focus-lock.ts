import { useEffect, useRef } from "react";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { hasTouchInput } from "@/aivp/platform";
import { IS_AIVP_EDITOR } from "@/aivp/runtime";

type FocusLockCursor = "text" | "default" | "pointer" | "crosshair";

const DATA_ATTR = "data-focus-locked";

function buildFocusLockCSS({
	cursor,
	allowSelector,
}: {
	cursor: FocusLockCursor;
	allowSelector?: string;
}) {
	const rules = [
		`*, *::before, *::after { pointer-events: none !important; cursor: ${cursor} !important; }`,
		`[${DATA_ATTR}], [${DATA_ATTR}] * { pointer-events: auto !important; cursor: auto !important; }`,
	];

	if (allowSelector) {
		rules.push(
			`${allowSelector} { pointer-events: auto !important; cursor: auto !important; }`,
		);
	}

	return rules.join("\n");
}

export function useFocusLock<T extends HTMLElement = HTMLElement>({
	isActive,
	onDismiss,
	cursor = "default",
	allowSelector,
}: {
	isActive: boolean;
	onDismiss: () => void;
	cursor?: FocusLockCursor;
	allowSelector?: string;
}) {
	const containerRef = useRef<T>(null);
	const onDismissRef = useCommittedRef(onDismiss);

	useEffect(() => {
		if (!isActive) return;
		const container = containerRef.current;
		if (!container) return;

		container.setAttribute(DATA_ATTR, "");

		// AIVP touch (iPad WebKit): a document-wide `pointer-events: none` leaves a finger nothing to hit, so
		// the outside tap that should dismiss the lock never arrives and the whole editor stops responding.
		// On touch the field just keeps focus until it blurs (keyboard dismissal, Enter, or an outside tap).
		const lockPointer = !(IS_AIVP_EDITOR && hasTouchInput());
		const focusLockStyle = document.createElement("style");
		focusLockStyle.textContent = buildFocusLockCSS({ cursor, allowSelector });
		if (lockPointer) document.head.appendChild(focusLockStyle);

		const handleOutsidePointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			const target = event.target;
			if (target instanceof Node && container.contains(target)) return;

			const isAllowedTarget =
				allowSelector &&
				target instanceof Element &&
				target.closest(allowSelector);
			if (isAllowedTarget) return;

			onDismissRef.current();
		};

		document.addEventListener("pointerdown", handleOutsidePointerDown, true);

		return () => {
			document.removeEventListener(
				"pointerdown",
				handleOutsidePointerDown,
				true,
			);
			container.removeAttribute(DATA_ATTR);
			focusLockStyle.remove();
		};
	}, [isActive, cursor, allowSelector, onDismissRef]);

	return { containerRef };
}
