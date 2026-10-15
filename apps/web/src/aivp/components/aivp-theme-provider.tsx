"use client";

import { ThemeProvider } from "next-themes";
import { useEffect } from "react";
import { useAivpStore } from "../store";

/*
 * C56: the embedded editor follows the studio's 晴空 / 星海 appearance. The
 * host forwards only "light" | "dark" (bootstrap `appearance`, then `theme`
 * events); until then, and with older hosts, the editor stays 星海. The
 * theme is forced (no system detection inside the editor: the studio already
 * resolved 跟随系统) and switches without remounting anything.
 *
 * C58: the studio's independent 高对比度 preference ("standard" | "high",
 * bootstrap `appearance.contrast`, then `contrast` events) is written as
 * `<html data-contrast="high">`; aivp-theme.css maps it onto the editor
 * tokens for either theme. Nothing remounts; the preview canvas and media
 * keep their own pixels.
 */
export function AivpThemeProvider({ children }: { children: React.ReactNode }) {
	const theme = useAivpStore((state) => state.theme);
	const contrast = useAivpStore((state) => state.contrast);
	useEffect(() => {
		const root = document.documentElement;
		if (contrast === "high") root.setAttribute("data-contrast", "high");
		else root.removeAttribute("data-contrast");
	}, [contrast]);
	return (
		<ThemeProvider
			attribute="class"
			forcedTheme={theme}
			defaultTheme="dark"
			enableSystem={false}
			disableTransitionOnChange={true}
		>
			{children}
		</ThemeProvider>
	);
}
