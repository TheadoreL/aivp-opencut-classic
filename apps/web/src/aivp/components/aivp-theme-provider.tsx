"use client";

import { ThemeProvider } from "next-themes";
import { useAivpStore } from "../store";

/*
 * C56: the embedded editor follows the studio's 晴空 / 星海 appearance. The
 * host forwards only "light" | "dark" (bootstrap `appearance`, then `theme`
 * events); until then, and with older hosts, the editor stays 星海. The
 * theme is forced (no system detection inside the editor: the studio already
 * resolved 跟随系统) and switches without remounting anything.
 */
export function AivpThemeProvider({ children }: { children: React.ReactNode }) {
	const theme = useAivpStore((state) => state.theme);
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
