import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import DevEditor from "./dev/DevEditor";
import DevOutline from "./dev/DevOutline";
import DevSource from "./dev/DevSource";

// Dev routes (PRD §8, Phases 0-1) are served by Vite from the same index.html; the app itself has
// no router, so the path is read once here.
const { pathname } = window.location;
const isDevEditor = pathname === "/dev/editor";
const isDevSource = pathname === "/dev/source";
const isDevOutline = pathname === "/dev/outline";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isDevEditor ? (
      <DevEditor />
    ) : isDevSource ? (
      <DevSource />
    ) : isDevOutline ? (
      <DevOutline />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
