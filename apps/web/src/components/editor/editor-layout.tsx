"use client";

import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { PreviewPanel } from "@/preview/components";
import { usePanelStore } from "@/editor/panel-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { useMemo, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";

/*
 * The editor's four-panel layout (assets, preview, properties, timeline),
 * shared by the OpenCut editor route and the AIVP embedded editor entry.
 */

export function DegradedRendererBanner() {
	const isDegraded = useEditor((e) => e.renderer.isDegraded);
	const [dismissed, setDismissed] = useState(false);
	if (!isDegraded || dismissed) return null;

	return (
		<div className="bg-accent border-b h-9 flex items-center justify-center gap-2 text-xs text-muted-foreground">
			<span>For the best experience, open OpenCut in Chrome.</span>
			<Button
				variant="text"
				size="icon"
				className="p-0 w-auto [&_svg]:size-3.5"
				onClick={() => setDismissed(true)}
				aria-label="Dismiss"
			>
				<HugeiconsIcon icon={Cancel01Icon} />
			</Button>
		</div>
	);
}

/**
 * - `full`: assets | preview | properties above the timeline (default);
 * - `split`: one side pane switching between assets and properties beside
 *   the preview (narrower windows, iPad portrait or wide Split View);
 * - `stack`: one pane switching between preview, assets and properties above
 *   the timeline (narrow Split View / Slide Over).
 * Every variant keeps the same panels and the real timeline.
 */
export type EditorLayoutVariant = "full" | "split" | "stack";

function PaneTabs<T extends string>({
	tabs,
	value,
	onChange,
	label,
}: {
	tabs: { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	label: string;
}) {
	return (
		<div className="aivp-pane-tabs" role="tablist" aria-label={label}>
			{tabs.map((tab) => (
				<button
					key={tab.value}
					type="button"
					role="tab"
					aria-selected={value === tab.value}
					onClick={() => onChange(tab.value)}
				>
					{tab.label}
				</button>
			))}
		</div>
	);
}

export function EditorLayout({ variant = "full" }: { variant?: EditorLayoutVariant } = {}) {
	usePasteMedia();
	const [sidePane, setSidePane] = useState<"assets" | "properties">("assets");
	const [stackPane, setStackPane] = useState<"preview" | "assets" | "properties">("preview");
	const { panels, setPanel } = usePanelStore();
	const activeScene = useEditor((editor) =>
		editor.scenes.getActiveSceneOrNull(),
	);
	const currentTime = useEditor((editor) => editor.playback.getCurrentTime());
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);
	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					activeScene
						? getBookmarkPreviewOverlaySource({
								bookmarks: activeScene.bookmarks,
								time: currentTime,
								isVisible: showBookmarkNotes,
							})
						: {
								definitions: [bookmarkNotesPreviewOverlay],
								instances: [],
							},
				],
			}),
		[activeGuide, activeScene, currentTime, showBookmarkNotes],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	const preview = (
		<PreviewPanel
			overlayControls={overlayControls}
			overlayInstances={overlaySource.instances}
			onOverlayVisibilityChange={setOverlayVisibility}
		/>
	);

	if (variant !== "full") {
		const top =
			variant === "split" ? (
				<ResizablePanelGroup direction="horizontal" className="size-full gap-[0.19rem] px-2">
					<ResizablePanel defaultSize={40} minSize={28} maxSize={60} className="min-w-0 flex flex-col">
						<PaneTabs
							label="侧栏"
							tabs={[
								{ value: "assets", label: "素材" },
								{ value: "properties", label: "属性" },
							]}
							value={sidePane}
							onChange={setSidePane}
						/>
						<div className="min-h-0 flex-1">{sidePane === "assets" ? <AssetsPanel /> : <PropertiesPanel />}</div>
					</ResizablePanel>
					<ResizableHandle withHandle />
					<ResizablePanel defaultSize={60} minSize={35} className="min-h-0 min-w-0 flex-1">
						{preview}
					</ResizablePanel>
				</ResizablePanelGroup>
			) : (
				<div className="flex size-full flex-col px-2">
					<PaneTabs
						label="面板"
						tabs={[
							{ value: "preview", label: "预览" },
							{ value: "assets", label: "素材" },
							{ value: "properties", label: "属性" },
						]}
						value={stackPane}
						onChange={setStackPane}
					/>
					<div className="min-h-0 flex-1">
						{stackPane === "preview" ? preview : stackPane === "assets" ? <AssetsPanel /> : <PropertiesPanel />}
					</div>
				</div>
			);
		return (
			<ResizablePanelGroup direction="vertical" className="size-full gap-[0.18rem]">
				<ResizablePanel defaultSize={55} minSize={30} maxSize={80} className="min-h-0">
					{top}
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={45} minSize={20} maxSize={70} className="min-h-0 px-2 pb-2">
					<Timeline />
				</ResizablePanel>
			</ResizablePanelGroup>
		);
	}

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={(sizes) => {
				setPanel({
					panel: "mainContent",
					size: sizes[0] ?? panels.mainContent,
				});
				setPanel({
					panel: "timeline",
					size: sizes[1] ?? panels.timeline,
				});
			}}
		>
			<ResizablePanel
				defaultSize={panels.mainContent}
				minSize={30}
				maxSize={85}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className="size-full gap-[0.19rem] px-3"
					onLayout={(sizes) => {
						setPanel({ panel: "tools", size: sizes[0] ?? panels.tools });
						setPanel({ panel: "preview", size: sizes[1] ?? panels.preview });
						setPanel({
							panel: "properties",
							size: sizes[2] ?? panels.properties,
						});
					}}
				>
					<ResizablePanel
						defaultSize={panels.tools}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.preview}
						minSize={30}
						className="min-h-0 min-w-0 flex-1"
					>
						{preview}
					</ResizablePanel>

					<ResizableHandle withHandle />

					<ResizablePanel
						defaultSize={panels.properties}
						minSize={15}
						maxSize={40}
						className="min-w-0"
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={panels.timeline}
				minSize={15}
				maxSize={70}
				className="min-h-0 px-3 pb-3"
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
