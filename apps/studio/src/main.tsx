import { createRoot } from "react-dom/client";
import { Component, type ReactNode } from "react";
import { EditorApp } from "./editor/App";
import { tr } from "./editor/i18n";
class EditorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="home">
        <section className="surface">
          <h1>{tr("Editor could not be loaded")}</h1>
          <button className="primary-button" onClick={() => window.location.reload()}>
            {tr("Reload editor")}
          </button>
        </section>
      </main>
    ) : (
      this.props.children
    );
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Editor root is unavailable");
createRoot(root).render(
  <EditorBoundary>
    <EditorApp />
  </EditorBoundary>,
);
