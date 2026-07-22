"use client";

import React, { createContext, useContext, useState } from "react";

export interface ThemeColors {
  themeText: string;
  themeBg: string;
  themeBorder: string;
  themeShadow: string;
  themeHover: string;
  glowColor: string;
  accent: string; // raw hex color e.g. "#00f0ff"
}

export const defaultTheme: ThemeColors = {
  themeText: "text-neon-blue",
  themeBg: "bg-neon-blue",
  themeBorder: "border-neon-blue",
  themeShadow: "shadow-[0_0_10px_#00f0ff]",
  themeHover: "hover:bg-neon-blue hover:text-black hover:shadow-[0_0_15px_#00f0ff] hover:border-transparent",
  glowColor: "bg-neon-blue/10",
  accent: "#00f0ff",
};

interface ThemeContextValue {
  theme: ThemeColors;
  setTheme: (t: ThemeColors) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: defaultTheme,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeColors>(defaultTheme);

  React.useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--theme-accent", theme.accent);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  return useContext(ThemeContext);
}
