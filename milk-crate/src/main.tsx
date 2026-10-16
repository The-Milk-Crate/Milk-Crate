import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Brand fonts, bundled with the app (no network needed).
import "@fontsource-variable/archivo";
import "@fontsource/archivo-black";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";

import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
