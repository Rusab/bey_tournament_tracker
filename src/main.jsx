import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// The bundle ran, so whatever the recovery in index.html was guarding against
// is over. Clear the flag so it can act again if it ever recurs.
try { sessionStorage.removeItem("bx:healed"); } catch (e) { /* private mode */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Makes the app installable to a home screen. Only in production builds —
// a service worker in dev fights with Vite's hot reload.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.error("SW failed", e));
  });
}
