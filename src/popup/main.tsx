import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./popup.css";

const root = document.querySelector("#app");

if (root === null) {
  throw new Error("Popup root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
