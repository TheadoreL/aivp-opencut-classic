"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
	// AIVP: a forced theme (the embedded editor follows the studio host) wins over the stored one.
	const { theme = "system", forcedTheme } = useTheme();

	return (
		<Sonner
			theme={(forcedTheme ?? theme) as ToasterProps["theme"]}
			className="toaster group"
			position="bottom-right"
			offset={20}
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
					description: "group-[.toast]:text-muted-foreground",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
				},
			}}
			expand={false}
			richColors
			{...props}
		/>
	);
};

export { Toaster };
