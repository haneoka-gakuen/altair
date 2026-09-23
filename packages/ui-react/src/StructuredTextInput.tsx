import { useState } from "react";
import { parseAuthoredText, serializeAuthoredText, type JsonValue } from "@haneoka/altair";
export function StructuredTextInput({ value, onChange }: { value: JsonValue; onChange: (value: JsonValue) => void }) {
  const serialized = serializeAuthoredText(value),
    [draft, setDraft] = useState<{
      base: string;
      text: string;
    }>(),
    [error, setError] = useState("");
  const text = draft?.base === serialized ? draft.text : serialized;
  return (
    <>
      <textarea
        rows={3}
        value={text}
        onChange={(event) => {
          setDraft({ base: serialized, text: event.target.value });
          try {
            parseAuthoredText(event.target.value);
            setError("");
          } catch (error) {
            setError(error instanceof Error ? error.message : "Incomplete YAML");
          }
        }}
        onBlur={() => {
          if (!draft || draft.base !== serialized) return;
          try {
            onChange(parseAuthoredText(draft.text));
            setError("");
            setDraft(undefined);
          } catch (error) {
            setError(error instanceof Error ? error.message : "Incomplete YAML");
          }
        }}
      />
      {error && <small>{error}</small>}
    </>
  );
}
