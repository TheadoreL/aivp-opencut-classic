import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ArrowRightDoubleIcon,
	ClosedCaptionIcon,
	Folder03Icon,
	Happy01Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	TextIcon,
	Settings01Icon,
	SlidersHorizontalIcon,
	ColorsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { IS_AIVP_EDITOR } from "@/aivp/runtime";

export const TAB_KEYS = [
	"media",
	"sounds",
	"text",
	"stickers",
	"effects",
	"transitions",
	"captions",
	"adjustment",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

/**
 * Tabs shown in the tab bar. The AIVP build hides tabs that need remote
 * services (Freesound sounds, remote sticker/logo sources) and the
 * placeholder "coming soon" tabs.
 */
export const VISIBLE_TAB_KEYS: readonly Tab[] = IS_AIVP_EDITOR
	? ["media", "text", "effects", "captions", "settings"]
	: TAB_KEYS;

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

export const tabs = {
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: "Media",
	},
	sounds: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: "Sounds",
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: "Text",
	},
	stickers: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: "Stickers",
	},
	effects: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: "Effects",
	},
	transitions: {
		icon: createHugeiconsIcon({ icon: ArrowRightDoubleIcon }),
		label: "Transitions",
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: "Captions",
	},
	adjustment: {
		icon: createHugeiconsIcon({ icon: SlidersHorizontalIcon }),
		label: "Adjustment",
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: "Settings",
	},
} satisfies Record<
	Tab,
	{ icon: ElementType<{ className?: string }>; label: string }
>;

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (args: { key: MediaSortKey; order: MediaSortOrder }) => void;
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set) => ({
			activeTab: "media",
			setActiveTab: (tab) => set({ activeTab: tab }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: "media", highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
			mediaSortBy: "name",
			mediaSortOrder: "asc",
			setMediaSort: ({ key, order }) =>
				set({ mediaSortBy: key, mediaSortOrder: order }),
		}),
		{
			name: "assets-panel",
			partialize: (state) => ({
				mediaViewMode: state.mediaViewMode,
				mediaSortBy: state.mediaSortBy,
				mediaSortOrder: state.mediaSortOrder,
			}),
		},
	),
);
