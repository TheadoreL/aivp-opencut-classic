import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import "../aivp/aivp-theme.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";

/*
 * Root layout of the AIVP embedded editor build only (`pageExtensions`
 * `aivp.tsx`, static export). Unlike the OpenCut site layout it loads no
 * bot protection, analytics, react-scan or remote (Google) fonts: the
 * editor runs from packaged files on the AIVP desktop editor origin.
 */
export const metadata: Metadata = {
	title: "剪辑 · 中诚建川 AIVP",
	robots: { index: false, follow: false },
};

/*
 * The editor's viewport is the area the studio reserved (desktop child view
 * or iPad child web view): no page zoom (pinch/double-tap would fight the
 * timeline gestures; the timeline has its own zoom), no automatic text
 * enlargement.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
	userScalable: false,
};

export default function AivpRootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="zh-CN" className="dark aivp-editor" suppressHydrationWarning>
			<body className="font-sans antialiased">
				<ThemeProvider
					attribute="class"
					forcedTheme="dark"
					defaultTheme="dark"
					enableSystem={false}
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<Toaster />
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
