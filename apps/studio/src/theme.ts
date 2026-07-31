export const STUDIO_THEME_STORAGE_KEY = "haneoka.altair.theme";

export const STUDIO_THEME_PREFERENCES = ["light", "system", "dark"] as const;

export type StudioThemePreference = (typeof STUDIO_THEME_PREFERENCES)[number];
export type ResolvedStudioTheme = "light" | "dark";

export const parseStudioThemePreference = (
  value: string | null | undefined,
): StudioThemePreference =>
  STUDIO_THEME_PREFERENCES.includes(value as StudioThemePreference)
    ? (value as StudioThemePreference)
    : "light";

export const resolveStudioTheme = (
  preference: StudioThemePreference,
  devicePrefersDark: boolean,
): ResolvedStudioTheme =>
  preference === "system" ? (devicePrefersDark ? "dark" : "light") : preference;
