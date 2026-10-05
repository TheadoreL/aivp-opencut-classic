import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

/**
 * AIVP embedded editor build (`bun run build:aivp`): a static export of only
 * the `*.aivp.tsx` app entries (the editor), packaged into the AIVP desktop
 * application and served from its own controlled origin. No BotId, content
 * collections, standalone server, remote images or source maps; nothing
 * needs a Node/Bun server at runtime.
 */
const aivpEditorConfig: NextConfig = {
	// The embedded editor holds one stateful host session per window; no double effects.
	reactStrictMode: false,
	productionBrowserSourceMaps: false,
	output: "export",
	distDir: ".next-aivp",
	pageExtensions: ["aivp.tsx", "aivp.ts"],
	poweredByHeader: false,
	images: { unoptimized: true },
	env: { NEXT_PUBLIC_AIVP_EDITOR: "1" },
	compiler: {
		removeConsole: { exclude: ["error", "warn"] },
	},
	// Type-check program of the editor build: the AIVP entries and everything
	// they import (strict, unchanged options); not the site pages/config wrappers.
	typescript: { tsconfigPath: "tsconfig.aivp.json" },
	// This fork is its own workspace (bun.lock); never infer an outer monorepo root.
	turbopack: { root: resolve(process.cwd(), "../..") },
};

/**
 * The site build keeps its BotId and content-collections wrappers. They are
 * loaded only for that build, so the editor build neither runs nor resolves
 * them (they bind to another copy of `next` in the workspace root).
 */
export default async function config(): Promise<NextConfig> {
	if (process.env.AIVP_EDITOR_BUILD === "1") return aivpEditorConfig;
	const [{ withBotId }, { withContentCollections }] = await Promise.all([
		import("botid/next/config"),
		import("@content-collections/next"),
	]);
	return withContentCollections(withBotId(nextConfig));
}
