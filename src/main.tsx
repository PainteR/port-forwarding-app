import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const systemAppearance = window.matchMedia("(prefers-color-scheme: dark)");

function applySystemAppearance() {
  document.documentElement.classList.toggle("dark", systemAppearance.matches);
  document.documentElement.style.colorScheme = systemAppearance.matches
    ? "dark"
    : "light";
}

applySystemAppearance();
systemAppearance.addEventListener("change", applySystemAppearance);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    systemAppearance.removeEventListener("change", applySystemAppearance);
  });
}
