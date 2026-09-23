import type { JsonValue } from "@haneoka/altair";
const canonical = (locale: string) => {
  try {
    return Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0]!.toLowerCase();
  } catch {
    return locale.toLowerCase();
  }
};
export function readLocalizedText(value: JsonValue | undefined, locale: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const exact = Object.keys(value).find((key) => canonical(key) === canonical(locale));
    const text = exact === undefined ? undefined : value[exact];
    return typeof text === "string" ? text : "";
  }
  return "";
}
export function editLocalizedText(
  value: JsonValue | undefined,
  locale: string,
  defaultLocale: string,
  text: string,
): JsonValue {
  if (Array.isArray(value)) throw new TypeError("Positional translations must be decoded by their format adapter");
  if (value && typeof value === "object") {
    const key = Object.keys(value).find((key) => canonical(key) === canonical(locale)) ?? locale;
    return { ...value, [key]: text };
  }
  return {
    ...(typeof value === "string" ? { [defaultLocale]: value } : {}),
    [locale]: text,
  };
}
