/*
 * Layout-shift diagnostics: shows WHICH element moved, by how much and when.
 *
 * Inert by default. Activated only with `lsdiag=1` in the URL (query string or Telegram start param), so normal
 * users never load or run it. Open the Mini App with it, walk to the screen that "shakes", and read the panel:
 * every layout shift is listed with its size, time and the class names of the elements that moved.
 *
 *   ?lsdiag=1
 *   tgWebAppStartParam=lsdiag1
 *
 * `window.__lsDiagReport()` returns the same data as JSON; every entry is also logged with an `lsdiag:` prefix.
 */
(function () {
  const source = `${window.location.search || ""}&${window.location.hash || ""}`;
  if (!/[?&#]lsdiag=1\b/.test(source) && !/[?&#]tgWebAppStartParam=lsdiag1\b/.test(source)) return;
  if (typeof PerformanceObserver !== "function") return;
  const entries = [];
  const name = (node) => {
    if (!node) return "?";
    const id = node.id ? `#${node.id}` : "";
    const cls = typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    return `${node.nodeName.toLowerCase()}${id}${cls}`;
  };
  let panel = null;
  const render = () => {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement("div");
      panel.style.cssText = "position:fixed;left:6px;right:6px;top:6px;z-index:2147483647;max-height:38vh;overflow:auto;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.82);color:#9ef0c0;font:11px/1.35 ui-monospace,Menlo,monospace;pointer-events:auto";
      panel.addEventListener("click", () => { panel.style.maxHeight = panel.style.maxHeight === "22px" ? "38vh" : "22px"; });
      document.body.appendChild(panel);
    }
    const total = entries.reduce((sum, item) => sum + item.value, 0);
    panel.textContent = "";
    const head = document.createElement("div");
    head.style.cssText = "color:#fff;font-weight:700;margin-bottom:4px";
    head.textContent = `lsdiag: ${entries.length} shifts, total ${total.toFixed(4)} (tap = collapse)`;
    panel.appendChild(head);
    entries.slice(-12).reverse().forEach((item) => {
      const row = document.createElement("div");
      row.textContent = `${(item.t / 1000).toFixed(2)}s  ${item.value.toFixed(4)}  ${item.sources.join(" | ")}`;
      panel.appendChild(row);
    });
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      const item = {
        t: Math.round(entry.startTime),
        value: Number(entry.value || 0),
        sources: (entry.sources || []).map((s) => {
          const prev = s.previousRect;
          const cur = s.currentRect;
          const dy = Math.round((cur.top - prev.top) * 10) / 10;
          const dx = Math.round((cur.left - prev.left) * 10) / 10;
          const dh = Math.round((cur.height - prev.height) * 10) / 10;
          return `${name(s.node)} dy=${dy} dx=${dx} dh=${dh}`;
        }),
      };
      entries.push(item);
      console.info("lsdiag:", JSON.stringify(item));
    }
    render();
  }).observe({ type: "layout-shift", buffered: true });
  window.__lsDiagReport = () => JSON.parse(JSON.stringify(entries));
  document.addEventListener("DOMContentLoaded", render);
})();
