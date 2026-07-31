import type { AltairCommandSchemaContribution } from "@haneoka/altair";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StudioIcon } from "./StudioIcon";
import {
  commandSchemaCategories,
  filterCommandSchemas,
} from "./visual-authoring";

export interface CommandInsertDialogProps {
  readonly beforeLabel: string;
  readonly schemas: readonly AltairCommandSchemaContribution[];
  readonly onCancel: () => void;
  readonly onSelect: (schema: AltairCommandSchemaContribution) => void;
}

const categoryLabel = (category: string): string =>
  category
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

export function CommandInsertDialog({
  beforeLabel,
  schemas,
  onCancel,
  onSelect,
}: CommandInsertDialogProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const categories = useMemo(
    () => commandSchemaCategories(schemas),
    [schemas],
  );
  const results = useMemo(
    () => filterCommandSchemas(schemas, query, category),
    [category, query, schemas],
  );

  useEffect(() => {
    const backdrop = backdropRef.current;
    const previousFocus = document.activeElement;
    const siblings = backdrop?.parentElement
      ? Array.from(backdrop.parentElement.children)
          .filter((element) => element !== backdrop)
          .map((element) => {
            const item = element as HTMLElement;
            return [item, item.inert] as const;
          })
      : [];
    for (const [element] of siblings) element.inert = true;
    searchRef.current?.focus();
    return () => {
      for (const [element, inert] of siblings) element.inert = inert;
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected
      ) {
        previousFocus.focus();
      }
    };
  }, []);

  const handleDialogKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
    } else if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="command-picker-backdrop"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
      ref={backdropRef}
    >
      <section
        aria-labelledby="command-picker-heading"
        aria-modal="true"
        className="command-picker"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="command-picker-heading">Insert command</h2>
            <p>{beforeLabel}</p>
          </div>
          <button
            aria-label="Close command picker"
            className="icon-button"
            onClick={onCancel}
            title="Close"
            type="button"
          >
            <StudioIcon name="close" />
          </button>
        </header>
        <div className="command-picker-filters">
          <label>
            <span className="sr-only">Search commands</span>
            <StudioIcon name="search" />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search commands"
              ref={searchRef}
              type="search"
              value={query}
            />
          </label>
          <label>
            <span className="sr-only">Command category</span>
            <select
              aria-label="Command category"
              onChange={(event) => setCategory(event.target.value)}
              value={category}
            >
              <option value="">All categories</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {categoryLabel(item)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ul
          aria-label="Available commands"
          className="command-picker-results"
        >
          {results.length ? (
            results.map((schema) => (
              <li key={schema.id}>
                <button onClick={() => onSelect(schema)} type="button">
                  <span>
                    <b>{schema.name ?? schema.sourceNames?.[0] ?? schema.id}</b>
                    <small>{categoryLabel(schema.category ?? "other")}</small>
                  </span>
                  <StudioIcon name="chevron-right" />
                </button>
              </li>
            ))
          ) : (
            <li className="command-picker-empty">
              No commands match this search.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
