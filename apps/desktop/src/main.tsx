import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DevEditor from "./dev/DevEditor";
import DevSource from "./dev/DevSource";

// Dev routes (PRD §8, Phases 0-1) are served by Vite from the same index.html; the app itself has
// no router, so the path is read once here. Task 1.8 adds /dev/outline.
const { pathname } = window.location;
const isDevEditor = pathname === "/dev/editor";
const isDevSource = pathname === "/dev/source";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isDevEditor ? <DevEditor /> : isDevSource ? <DevSource /> : <App />}
  </React.StrictMode>,
);
