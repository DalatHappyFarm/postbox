// Runs before first paint so a stored light/dark choice does not flash; no choice means follow the system.
try { const t = localStorage.getItem("postbox_theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
