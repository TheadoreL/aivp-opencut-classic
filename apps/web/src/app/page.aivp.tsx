"use client";

import dynamic from "next/dynamic";

/*
 * AIVP embedded editor entry (static export, served by the AIVP desktop
 * host). The editor core touches browser-only APIs (WebGPU/WebCodecs,
 * IndexedDB/OPFS), so it is only rendered on the client.
 */
const AivpEditorApp = dynamic(
	() =>
		import("@/aivp/components/aivp-editor-app").then(
			(module) => module.AivpEditorApp,
		),
	{
		ssr: false,
		loading: () => (
			<div className="aivp-screen" role="status">
				<div>正在载入剪辑器…</div>
			</div>
		),
	},
);

export default function AivpEditorPage() {
	return <AivpEditorApp />;
}
