import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "agnes-console-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStoredMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    // Storage can be unavailable; fall back to the system preference.
  }
  return "system";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") {
    return mode;
  }
  if (typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function apply(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(mode));

  useEffect(() => {
    const next = resolve(mode);
    setResolved(next);
    apply(next);
    if (mode !== "system") {
      return;
    }
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      const nextSystem = resolve("system");
      setResolved(nextSystem);
      apply(nextSystem);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures; the in-memory choice still applies.
    }
  };

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
