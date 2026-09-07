import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DevEditor from "./dev/DevEditor";

// Dev routes (PRD §8, Phases 0-1) are served by Vite from the same index.html; the app itself has
// no router, so the path is read once here. Task 1.5 adds /dev/source and 1.8 /dev/outline.
const isDevEditor = window.location.pathname === "/dev/editor";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDevEditor ? <DevEditor /> : <App />}</React.StrictMode>,
);
