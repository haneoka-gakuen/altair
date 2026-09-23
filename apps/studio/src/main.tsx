import { createRoot } from "react-dom/client";
import { EditorApp } from "./editor/App";
const root = document.getElementById("root");
if (!root) throw new Error("Editor root is unavailable");
createRoot(root).render(<EditorApp />);
