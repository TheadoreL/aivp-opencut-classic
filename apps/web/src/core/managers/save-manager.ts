import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
	/** Upper bound of the automatic retry back-off after a failed save. */
	maxRetryDelayMs?: number;
};

export type SaveManagerPhase = "idle" | "dirty" | "saving" | "error";

/** Upper bound of save rounds one flush performs while edits keep arriving. */
const MAX_FLUSH_ROUNDS = 25;

export interface SaveManagerStatus {
	phase: SaveManagerPhase;
	/** Changes not yet persisted (also true while a save is in flight). */
	isDirty: boolean;
	isSaving: boolean;
	/** Message of the latest failed save; cleared by the next successful one. */
	lastError: string | null;
	/** Consecutive failed saves (drives the bounded retry back-off). */
	failureCount: number;
	/** Wall clock time (ms) of the latest successful save, or null. */
	lastSavedAt: number | null;
	/** Edit generation that is known to be persisted. */
	savedGeneration: number;
	/** Latest edit generation (incremented by every change). */
	dirtyGeneration: number;
}

/**
 * Debounced local autosave.
 *
 * Every change bumps a dirty generation; a save captures the generation it
 * started with and only that generation counts as persisted once the save
 * resolved. A failed save therefore keeps the changes dirty, records the
 * error and schedules ONE retry with a bounded exponential back-off (never a
 * tight retry loop). `flush()` resolves only after everything changed before
 * the call is persisted: it waits for an in-flight save and then saves again
 * when edits arrived meanwhile, and it rejects when persisting fails, so an
 * exit guard never treats unsaved work as saved.
 *
 * Kept free of runtime imports so it can be exercised directly.
 */
export class SaveManager {
	private debounceMs: number;
	private maxRetryDelayMs: number;
	private isPaused = false;
	private dirtyGeneration = 0;
	private savedGeneration = 0;
	private inFlight: Promise<void> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private failureCount = 0;
	private lastError: string | null = null;
	private lastSavedAt: number | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private statusListeners = new Set<(status: SaveManagerStatus) => void>();
	private editor: EditorCore;

	constructor({
		editor,
		debounceMs = 800,
		maxRetryDelayMs = 60_000,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
		this.maxRetryDelayMs = maxRetryDelayMs;
	}

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
		this.clearRetryTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasUnsavedGeneration()) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.dirtyGeneration += 1;
		this.queueSave();
		this.emitStatus();
	}

	/**
	 * Persists every change made before this call. Waits for a save already in
	 * flight (its result never stands in for later edits) and rejects when the
	 * save fails or cannot run (project still loading or migrating).
	 */
	async flush(): Promise<void> {
		if (this.dirtyGeneration === this.savedGeneration) {
			// Upstream semantics: an explicit flush always writes the current state once.
			this.dirtyGeneration += 1;
		}
		// Drains: edits that arrive while this flush waits (or while its own save
		// runs) are persisted before it resolves. Bounded so continuous edits
		// cannot keep an exit waiting forever; that case rejects (still dirty).
		let rounds = 0;
		while (this.savedGeneration < this.dirtyGeneration) {
			if (this.inFlight !== null) {
				try {
					await this.inFlight;
				} catch {
					// That save's failure is recorded; this flush saves again below.
				}
				continue;
			}
			if (rounds >= MAX_FLUSH_ROUNDS) {
				throw new Error("Changes kept arriving while saving; they are not all saved yet");
			}
			rounds += 1;
			const attempted = await this.saveNow({ explicit: true });
			if (!attempted) return;
		}
	}

	getIsDirty(): boolean {
		return this.hasUnsavedGeneration() || this.inFlight !== null;
	}

	getStatus(): SaveManagerStatus {
		const isSaving = this.inFlight !== null;
		const isDirty = this.getIsDirty();
		const phase: SaveManagerPhase = isSaving
			? "saving"
			: this.lastError !== null && this.hasUnsavedGeneration()
				? "error"
				: isDirty
					? "dirty"
					: "idle";
		return {
			phase,
			isDirty,
			isSaving,
			lastError: this.lastError,
			failureCount: this.failureCount,
			lastSavedAt: this.lastSavedAt,
			savedGeneration: this.savedGeneration,
			dirtyGeneration: this.dirtyGeneration,
		};
	}

	subscribeStatus(listener: (status: SaveManagerStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private hasUnsavedGeneration(): boolean {
		return this.savedGeneration < this.dirtyGeneration;
	}

	private queueSave(): void {
		// An in-flight save re-queues itself when it finishes; a pending retry keeps its back-off.
		if (this.inFlight !== null || this.retryTimer !== null) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow({ explicit: false }).catch(() => {
				// Recorded in the status; a bounded retry is already scheduled.
			});
		}, this.debounceMs);
	}

	/**
	 * Runs one save of the current generation. Returns false when nothing
	 * could be attempted because there is no active project. Explicit
	 * (flush) callers get a rejection when the project is loading/migrating
	 * or the save fails; the timer path records the error instead.
	 */
	private async saveNow({ explicit }: { explicit: boolean }): Promise<boolean> {
		if (this.inFlight !== null) {
			await this.inFlight;
			return true;
		}
		if (!this.hasUnsavedGeneration()) return true;
		// Paused (project being loaded/replaced): a timer or retry scheduled earlier must not
		// write the outgoing project over the incoming one. resume() re-queues the save.
		if (this.isPaused && !explicit) return false;

		const activeProject = this.editor.project.getActiveOrNull
			? this.editor.project.getActiveOrNull()
			: this.editor.project.getActive();
		if (!activeProject) return false;
		if (
			this.editor.project.getIsLoading() ||
			this.editor.project.getMigrationState().isMigrating
		) {
			if (explicit) {
				throw new Error("The project is still loading; changes are not saved yet");
			}
			// Saved once loading/migration finished (resume() re-queues).
			return false;
		}

		const generation = this.dirtyGeneration;
		this.clearTimer();
		this.clearRetryTimer();

		const run = this.editor.project.saveCurrentProject();
		this.inFlight = run;
		this.emitStatus();

		try {
			await run;
			if (generation > this.savedGeneration) {
				this.savedGeneration = generation;
			}
			this.failureCount = 0;
			this.lastError = null;
			this.lastSavedAt = Date.now();
		} catch (error) {
			this.failureCount += 1;
			this.lastError =
				error instanceof Error && error.message !== ""
					? error.message
					: "Saving the project failed";
			throw error;
		} finally {
			this.inFlight = null;
			if (this.hasUnsavedGeneration()) {
				if (this.lastError !== null && this.failureCount > 0) {
					this.scheduleRetry();
				} else {
					this.queueSave();
				}
			}
			this.emitStatus();
		}
		return true;
	}

	/** One pending retry with exponential back-off, capped. Cleared by any save attempt or stop(). */
	private scheduleRetry(): void {
		if (this.retryTimer !== null) return;
		const exponent = Math.min(10, Math.max(0, this.failureCount - 1));
		const delay = Math.min(
			this.maxRetryDelayMs,
			Math.max(this.debounceMs, 1_000) * 2 ** exponent,
		);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.saveNow({ explicit: false }).catch(() => {
				// Recorded; the next retry is scheduled in saveNow's finally.
			});
		}, delay);
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}

	private clearRetryTimer(): void {
		if (!this.retryTimer) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	private emitStatus(): void {
		if (this.statusListeners.size === 0) return;
		const status = this.getStatus();
		for (const listener of this.statusListeners) {
			try {
				listener(status);
			} catch {
				// A failing listener never breaks saving.
			}
		}
	}
}
