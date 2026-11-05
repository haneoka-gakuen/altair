import type { AltairHistory } from "@haneoka/altair-plugin-history";

type History = AltairHistory<string>;
interface Part {
  history: History;
  before: number;
  after: number;
}
interface Entry {
  parts: Part[];
  merge?: History;
}

/** Orders existing document histories without copying project resources. */
export class DocumentHistory {
  private past: Entry[] = [];
  private future: Entry[] = [];
  private revisions = new Map<History, number>();
  private merging?: History;
  private reconcile() {
    const changed = new Set<History>();
    for (const [history, revision] of this.revisions)
      if (history.disposed || history.revision !== revision) changed.add(history);
    if (!changed.size) return;
    const keep = (entry: Entry) => !entry.parts.some((part) => changed.has(part.history));
    this.past = this.past.filter(keep);
    this.future = this.future.filter(keep);
    for (const history of changed) this.revisions.delete(history);
    this.merging = undefined;
  }
  get canUndo() {
    this.reconcile();
    return this.past.length > 0;
  }
  get canRedo() {
    this.reconcile();
    return this.future.length > 0;
  }
  endMerge() {
    this.merging = undefined;
  }
  prepare(history: History, merge = false): { history: History; before: number; merge: boolean; keepMerge?: boolean } {
    this.reconcile();
    const merging = merge && this.merging === history;
    if (!merging) history.endMerge();
    return { history, before: history.undoDepth, merge: merging, keepMerge: merge };
  }
  record(changes: readonly { history: History; before: number; merge: boolean; keepMerge?: boolean }[]) {
    const parts: Part[] = [];
    for (const change of changes) {
      const { history, merge } = change;
      let before = change.before;
      if (!merge && before === history.capacity && history.undoDepth === before) {
        for (const entry of this.past)
          for (const part of entry.parts)
            if (part.history === history) {
              part.before--;
              part.after--;
            }
        this.past = this.past.filter((entry) => entry.parts.every((part) => part.before >= 0));
        before--;
      }
      parts.push({ history, before, after: history.undoDepth });
      this.revisions.set(history, history.revision);
    }
    if (!parts.length) return;
    const only = changes.length === 1 ? changes[0] : undefined;
    const last = this.past.at(-1);
    if (only?.merge && last?.parts.length === 1 && last.parts[0]?.history === only.history)
      last.parts[0].after = only.history.undoDepth;
    else this.past.push({ parts, ...(only ? { merge: only.history } : {}) });
    this.past = this.past.slice(-1000);
    this.future = [];
    this.merging = only?.keepMerge ? only.history : undefined;
  }
  private travel(redo: boolean): Map<History, string> {
    this.reconcile();
    const source = redo ? this.future : this.past;
    const target = redo ? this.past : this.future;
    const entry = source.at(-1);
    if (!entry) return new Map();
    if (entry.parts.some((part) => part.history.undoDepth !== (redo ? part.before : part.after)))
      throw new Error("History changed outside this transaction");
    const values = new Map<History, string>();
    for (const part of redo ? entry.parts : [...entry.parts].reverse()) {
      const depth = redo ? part.after : part.before;
      while (part.history.undoDepth !== depth) {
        if (redo) part.history.redo();
        else part.history.undo();
      }
      values.set(part.history, part.history.value);
      this.revisions.set(part.history, part.history.revision);
    }
    source.pop();
    target.push(entry);
    this.merging = undefined;
    return values;
  }
  undo() {
    return this.travel(false);
  }
  redo() {
    return this.travel(true);
  }
}
