import { useState } from "react";
import { Languages } from "lucide-react";
import { availableStudioLanguages, interfaceLanguageChoice, selectInterfaceLanguage, tr, useStudioI18n } from "./i18n";
export function InterfaceLanguage() {
  const { i18n } = useStudioI18n();
  const [choice, setChoice] = useState(interfaceLanguageChoice);
  const label = (code: string) => {
    try {
      return (
        new Intl.DisplayNames([i18n.resolvedLanguage ?? "en"], {
          type: "language",
        }).of(code) ?? code
      );
    } catch {
      return code;
    }
  };
  return (
    <label className="interface-language">
      <Languages size={16} />
      <select
        aria-label={tr("Interface language")}
        value={choice}
        onChange={(event) => {
          const next = event.target.value;
          selectInterfaceLanguage(next);
          setChoice(next);
        }}
      >
        <option value="auto">{tr("Follow device language")}</option>
        {availableStudioLanguages().map((code) => (
          <option key={code} value={code}>
            {label(code)}
          </option>
        ))}
      </select>
    </label>
  );
}
