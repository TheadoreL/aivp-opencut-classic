/**
 * Touch support for OpenCut's timeline in the AIVP editor (iPad, touch
 * screens).
 *
 * The Classic timeline controllers (clip move/reorder, trim handles,
 * playhead and ruler scrubbing, keyframes) listen to mouse events only, and
 * WebKit turns a touch into mouse events only for a tap, never for a drag.
 * Inside a marked touch surface this bridge turns ONE-finger gestures that
 * start on a timeline control (a button such as a clip, trim handle,
 * keyframe or playhead knob, or an element marked `data-aivp-touch-drag`)
 * into the equivalent mouse sequence: mousedown at the start, mousemove on
 * the element under the finger, mouseup and, for a tap, click. A press held
 * still opens the element's context menu (split, delete, copy, …), which
 * mouse users reach with the right button. Touches elsewhere stay native:
 * one finger on an empty lane scrolls, two fingers scroll/zoom, and
 * controls that handle pointer/touch input themselves (`touch-action: none`,
 * e.g. the audio volume line) are left alone.
 */

const SURFACE = "[data-aivp-touch-surface]";
const DRAGGABLE = "button, [data-aivp-touch-drag]";
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 8;

interface Point {
	clientX: number;
	clientY: number;
	screenX: number;
	screenY: number;
}

interface Gesture {
	identifier: number;
	target: Element;
	start: Point;
	last: Point;
	moved: boolean;
	longPressed: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

function pointOf(touch: Touch): Point {
	return { clientX: touch.clientX, clientY: touch.clientY, screenX: touch.screenX, screenY: touch.screenY };
}

function dispatchMouse(type: string, target: EventTarget, point: Point, button: number, buttons: number): void {
	target.dispatchEvent(
		new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			view: window,
			detail: type === "click" ? 1 : 0,
			clientX: point.clientX,
			clientY: point.clientY,
			screenX: point.screenX,
			screenY: point.screenY,
			button,
			buttons,
		}),
	);
}

/** The control handles touch/pointer input itself (or opted out). */
function handlesTouchItself(element: Element, surface: Element): boolean {
	for (let node: Element | null = element; node !== null && node !== surface; node = node.parentElement) {
		if (node.hasAttribute("data-aivp-touch-native")) return true;
		if (node instanceof HTMLElement && getComputedStyle(node).touchAction === "none") return true;
	}
	return false;
}

function touchById(list: TouchList, identifier: number): Touch | null {
	for (let index = 0; index < list.length; index += 1) {
		const touch = list.item(index);
		if (touch && touch.identifier === identifier) return touch;
	}
	return null;
}

function elementAt(point: Point, fallback: Element): Element {
	return document.elementFromPoint(point.clientX, point.clientY) ?? fallback;
}

/** Installs the bridge on the document; returns its removal. */
export function installTouchMouseBridge(): () => void {
	let gesture: Gesture | null = null;

	const clearTimer = (current: Gesture): void => {
		if (current.timer !== null) clearTimeout(current.timer);
		current.timer = null;
	};

	/** Ends a synthesized drag where it is (second finger, cancel). */
	const abandon = (): void => {
		const current = gesture;
		if (!current) return;
		gesture = null;
		clearTimer(current);
		if (!current.longPressed) dispatchMouse("mouseup", elementAt(current.last, current.target), current.last, 0, 0);
	};

	const longPress = (): void => {
		const current = gesture;
		if (!current || current.moved) return;
		current.timer = null;
		current.longPressed = true;
		// The pending mouse gesture ends in place (no movement: nothing is dragged), then the menu opens.
		dispatchMouse("mouseup", current.target, current.start, 0, 0);
		dispatchMouse("contextmenu", current.target, current.start, 2, 0);
	};

	const onStart = (event: TouchEvent): void => {
		if (event.touches.length !== 1) {
			abandon();
			return;
		}
		const touch = event.changedTouches.item(0);
		const target = event.target instanceof Element ? event.target : null;
		if (!touch || !target) return;
		const surface = target.closest(SURFACE);
		if (!surface) return;
		const control = target.closest(DRAGGABLE);
		if (!control || !surface.contains(control)) return;
		if (control instanceof HTMLButtonElement && control.disabled) return;
		if (handlesTouchItself(target, surface)) return;
		// Owned by the bridge: no native scroll, no compatibility mouse events, no double-tap zoom.
		event.preventDefault();
		const start = pointOf(touch);
		gesture = { identifier: touch.identifier, target, start, last: start, moved: false, longPressed: false, timer: null };
		dispatchMouse("mousedown", target, start, 0, 1);
		gesture.timer = setTimeout(longPress, LONG_PRESS_MS);
	};

	const onMove = (event: TouchEvent): void => {
		const current = gesture;
		if (!current) return;
		const touch = touchById(event.changedTouches, current.identifier);
		if (!touch) return;
		event.preventDefault();
		const point = pointOf(touch);
		current.last = point;
		if (!current.moved && Math.hypot(point.clientX - current.start.clientX, point.clientY - current.start.clientY) > MOVE_TOLERANCE_PX) {
			current.moved = true;
			clearTimer(current);
		}
		if (current.longPressed || !current.moved) return;
		dispatchMouse("mousemove", elementAt(point, current.target), point, 0, 1);
	};

	const onEnd = (event: TouchEvent): void => {
		const current = gesture;
		if (!current) return;
		const touch = touchById(event.changedTouches, current.identifier);
		if (!touch) return;
		event.preventDefault();
		gesture = null;
		clearTimer(current);
		if (current.longPressed) return;
		const point = pointOf(touch);
		dispatchMouse("mouseup", elementAt(point, current.target), point, 0, 0);
		// A tap selects (the controllers act on click); a drag already did its work on mouseup.
		if (!current.moved) dispatchMouse("click", current.target, current.start, 0, 0);
	};

	const onCancel = (event: TouchEvent): void => {
		if (!gesture || !touchById(event.changedTouches, gesture.identifier)) return;
		abandon();
	};

	const options: AddEventListenerOptions = { capture: true, passive: false };
	document.addEventListener("touchstart", onStart, options);
	document.addEventListener("touchmove", onMove, options);
	document.addEventListener("touchend", onEnd, options);
	document.addEventListener("touchcancel", onCancel, options);
	return () => {
		abandon();
		document.removeEventListener("touchstart", onStart, options);
		document.removeEventListener("touchmove", onMove, options);
		document.removeEventListener("touchend", onEnd, options);
		document.removeEventListener("touchcancel", onCancel, options);
	};
}
