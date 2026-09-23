import { useState, type InputHTMLAttributes } from "react";

export function NumberInput({
  value,
  onCommit,
  onClear,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange" | "type"> & {
  value: number | undefined;
  onCommit(value: number): void;
  onClear?(): void;
}) {
  const [draft, setDraft] = useState<{ base: number | undefined; text: string }>();
  const text = draft && draft.base === value ? draft.text : String(value ?? "");
  return (
    <input
      {...props}
      type="number"
      value={text}
      onChange={(event) => setDraft({ base: value, text: event.target.value })}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(undefined);
        }
      }}
      onBlur={(event) => {
        const next = text.trim() ? Number(text) : NaN;
        if (!text.trim() && value !== undefined && !event.currentTarget.validity.badInput) onClear?.();
        else if (Number.isFinite(next) && next !== value) onCommit(next);
        setDraft(undefined);
        props.onBlur?.(event);
      }}
    />
  );
}
