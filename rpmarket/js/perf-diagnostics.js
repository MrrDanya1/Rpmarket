/*
 * Mini App performance diagnostics.
 *
 * Inert by default. Activated only when the URL contains `perf=1`
 * (query string or Telegram start param), so normal users never load or run it.
 *
 * Usage:
 *   ?perf=1                        Mode A: app exactly as-is + measurements
 *   ?perf=1&perfoff=blur,anim      disable visual effect groups
 *   ?perf=1&perfoff=preload,bg     disable background work groups
 *   ?perf=1&perfoff=all            Mode B: market only, everything heavy off
 *   tgWebAppStartParam=perf1-b2    Mode B2: hard-isolated market experiment
 *
 * Groups understood by `perfoff`:
 *   blur     backdrop-filter / filter on every element
 *   anim     CSS animations and transitions
 *   preload  eager capture map/business image preloading
 *   bg       background startup requests (tasks, notifications, profile hydration)
 *   img      offscreen <img> sources on pages other than the market
 *
 * Results:
 *   - live overlay in the top-left corner (tap to collapse)
 *   - `window.__perfDiagReport()` returns the full JSON report
 *   - every sample is also written to console with a `perfdiag:` prefix
 */
(function () {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const parameterSource = [
    search.startsWith("?") ? search.slice(1) : search,
    hash.replace(/^#\??/, ""),
  ].filter(Boolean).join("&");
  const params = new URLSearchParams(parameterSource);
  const startParam = String(
    params.get("tgWebAppStartParam") ||
    window.Telegram?.WebApp?.initDataUnsafe?.start_param ||
    "",
  );
  const enabled =
    params.get("perf") === "1" ||
    hash.includes("perf=1") ||
    startParam.includes("perf1");
  if (!enabled) return;

  const offRaw = String(params.get("perfoff") || (startParam.includes("modeb") ? "all" : ""));
  const hardMarketIsolation = startParam.includes("b2") || params.get("perfhard") === "market";
  const offSet = new Set(
    offRaw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  const isOff = (group) => offSet.has("all") || offSet.has(group);

  const flags = {
    enabled: true,
    mode: hardMarketIsolation ? "B2" : (offSet.size ? "B" : "A"),
    disabled: offSet.size ? Array.from(offSet) : [],
    skipBlur: isOff("blur"),
    skipAnimations: isOff("anim"),
    skipImagePreload: isOff("preload"),
    skipBackgroundStartup: isOff("bg"),
    skipOffscreenImages: isOff("img"),
    hardMarketIsolation,
  };
  if (hardMarketIsolation) {
    flags.skipBlur = true;
    flags.skipAnimations = true;
    flags.skipImagePreload = true;
    flags.skipBackgroundStartup = true;
    flags.skipOffscreenImages = true;
  }
  window.__PERF_DIAG__ = flags;

  const report = {
    mode: flags.mode,
    disabled: flags.disabled,
    device: {
      ua: navigator.userAgent,
      platform: window.Telegram?.WebApp?.platform || "unknown",
      tgVersion: window.Telegram?.WebApp?.version || "unknown",
      deviceMemoryGb: navigator.deviceMemory || null,
      cores: navigator.hardwareConcurrency || null,
      dpr: window.devicePixelRatio,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      connection: navigator.connection
        ? {
            type: navigator.connection.effectiveType,
            downlinkMbps: navigator.connection.downlink,
            rttMs: navigator.connection.rtt,
          }
        : null,
    },
    marks: {},
    longTasks: { count: 0, totalMs: 0, maxMs: 0, over100ms: 0, samples: [] },
    frames: { samples: [], worstFps: null, longestGapMs: 0 },
    input: { count: 0, maxDelayMs: 0, totalDelayMs: 0 },
    dom: {},
    network: {},
    market: {},
    images: { estimate_note: "RGBA estimate from intrinsic dimensions; not measured process RAM" },
    isolation: {
      enabled: hardMarketIsolation,
      detachedPages: 0,
      detachedModals: 0,
      detachedNodes: 0,
      blockedRequests: [],
    },
  };

  const now = () => (performance && performance.now ? performance.now() : Date.now());
  const round = (value) => Math.round(Number(value) || 0);

  function log(label, payload) {
    try {
      console.info(`perfdiag: ${label}`, payload);
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- *
   * Mode B suppression: pure CSS, applied before first paint.
   * ---------------------------------------------------------------- */
  if (flags.skipBlur || flags.skipAnimations) {
    const rules = [];
    if (flags.skipBlur) {
      rules.push(
        "*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; filter: none !important; }",
      );
    }
    if (flags.skipAnimations) {
      rules.push(
        "*, *::before, *::after { animation: none !important; transition: none !important; }",
      );
    }
    const style = document.createElement("style");
    style.id = "perf-diag-suppression";
    style.textContent = rules.join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  /* ---------------------------------------------------------------- *
   * Mode B: strip offscreen <img> sources while the parser builds them.
   *
   * Chrome's preload scanner may still issue the request, but dropping the
   * src before layout prevents the decode and the retained bitmap, which is
   * the part that costs Android memory and raster time.
   * ---------------------------------------------------------------- */
  let strippedImages = 0;
  if (flags.skipOffscreenImages) {
    const keepPrefixes = ["assets/logo/", "assets/category-covers/"];
    const stripImage = (img) => {
      const src = String(img.getAttribute("src") || "");
      if (!src || src.startsWith("data:")) return;
      if (keepPrefixes.some((prefix) => src.includes(prefix))) return;
      const page = img.closest ? img.closest(".page") : null;
      if (page && page.classList.contains("page-market")) return;
      img.dataset.perfDiagStrippedSrc = src;
      img.removeAttribute("src");
      strippedImages += 1;
    };
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === "IMG") stripImage(node);
          else if (node.querySelectorAll) node.querySelectorAll("img").forEach(stripImage);
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!hardMarketIsolation) {
      document.addEventListener("DOMContentLoaded", () => observer.disconnect(), { once: true });
    }
  }

  /* ---------------------------------------------------------------- *
   * Mode B2: a deliberately destructive-to-this-session experiment.
   *
   * app-combined.js first captures references to every legacy element. The
   * index loader then calls this hook before app.js starts. Detached pages can
   * therefore no longer participate in style/layout/paint, while normal URLs
   * and the application source remain untouched.
   * ---------------------------------------------------------------- */
  if (hardMarketIsolation) {
    const nativeFetch = window.fetch.bind(window);
    const allowedApiRequest = (url) => {
      if (url.pathname === "/api/listings") return true;
      if (url.pathname === "/api/servers") return true;
      if (url.pathname === "/api/avatar" || url.pathname === "/api/user-avatar") return true;
      if (url.pathname === "/api/me" && url.searchParams.get("bootstrap") === "1") return true;
      return false;
    };
    window.fetch = function perfDiagIsolatedFetch(input, init) {
      let url = null;
      try {
        url = new URL(typeof input === "string" ? input : input?.url, window.location.href);
      } catch (_) {
        return nativeFetch(input, init);
      }
      if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
        return nativeFetch(input, init);
      }
      if (allowedApiRequest(url)) return nativeFetch(input, init);
      const label = `${url.pathname}${url.search}`.slice(0, 120);
      if (report.isolation.blockedRequests.length < 80) {
        report.isolation.blockedRequests.push(label);
      }
      return Promise.resolve(new Response(
        JSON.stringify({ error: "perf_diag_hard_isolation" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ));
    };

    window.__perfDiagPrepareHardMarketIsolation = () => {
      const disposable = [
        ...document.querySelectorAll(".page:not(.page-market)"),
        ...document.querySelectorAll(".modal"),
        ...document.querySelectorAll(".bg-orbs"),
      ];
      const unique = Array.from(new Set(disposable));
      let detachedNodes = 0;
      unique.forEach((node) => {
        detachedNodes += node.querySelectorAll("*").length + 1;
        if (node.matches(".page")) report.isolation.detachedPages += 1;
        if (node.matches(".modal")) report.isolation.detachedModals += 1;
        node.remove();
      });
      report.isolation.detachedNodes = detachedNodes;
      document.documentElement.classList.add("perf-hard-market-isolation");
      log("HARD MARKET ISOLATION", report.isolation);
      return report.isolation;
    };
  }

  /* ---------------------------------------------------------------- *
   * Long tasks: main-thread blocking.
   * ---------------------------------------------------------------- */
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const duration = entry.duration;
        report.longTasks.count += 1;
        report.longTasks.totalMs += duration;
        report.longTasks.maxMs = Math.max(report.longTasks.maxMs, duration);
        if (duration >= 100) report.longTasks.over100ms += 1;
        if (report.longTasks.samples.length < 60) {
          report.longTasks.samples.push({ at: round(entry.startTime), ms: round(duration) });
        }
        if (duration >= 200) log("LONG TASK", { at: round(entry.startTime), ms: round(duration) });
      });
    });
    longTaskObserver.observe({ type: "longtask", buffered: true });
  } catch (_) {
    report.longTasks.unsupported = true;
  }

  /* ---------------------------------------------------------------- *
   * Paint / LCP.
   * ---------------------------------------------------------------- */
  try {
    const paintObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        report.marks[entry.name] = round(entry.startTime);
      });
    });
    paintObserver.observe({ type: "paint", buffered: true });
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) report.marks["largest-contentful-paint"] = round(last.startTime);
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch (_) {}

  /* ---------------------------------------------------------------- *
   * Input responsiveness.
   * ---------------------------------------------------------------- */
  try {
    const eventObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        const delay = entry.processingStart - entry.startTime;
        report.input.count += 1;
        report.input.totalDelayMs += delay;
        report.input.maxDelayMs = Math.max(report.input.maxDelayMs, delay);
      });
    });
    eventObserver.observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch (_) {}

  /* ---------------------------------------------------------------- *
   * Frame pacing: rolling one-second FPS windows.
   * ---------------------------------------------------------------- */
  let frameCount = 0;
  let windowStart = now();
  let lastFrame = now();
  function tick() {
    // Schedule the next sample first so a diagnostic overlay failure can never
    // stop frame collection for the rest of the session.
    requestAnimationFrame(tick);
    const current = now();
    const gap = current - lastFrame;
    if (gap > report.frames.longestGapMs) report.frames.longestGapMs = gap;
    lastFrame = current;
    frameCount += 1;
    const elapsed = current - windowStart;
    if (elapsed >= 1000) {
      const fps = (frameCount * 1000) / elapsed;
      if (report.frames.samples.length < 120) {
        report.frames.samples.push({ at: round(current), fps: Math.round(fps) });
      }
      if (report.frames.worstFps === null || fps < report.frames.worstFps) {
        report.frames.worstFps = Math.round(fps);
      }
      frameCount = 0;
      windowStart = current;
      try {
        renderOverlay();
      } catch (error) {
        log("OVERLAY ERROR", String(error?.message || error));
      }
    }
  }
  requestAnimationFrame(tick);

  /* ---------------------------------------------------------------- *
   * Market render timing: measures the DOM work, not the request.
   * ---------------------------------------------------------------- */
  function watchMarketList() {
    const list = document.getElementById("marketList");
    if (!list) return false;
    let batchStart = 0;
    let batchTimer = null;
    const listObserver = new MutationObserver((records) => {
      const added = records.reduce((sum, record) => sum + record.addedNodes.length, 0);
      if (!added) return;
      if (!batchStart) batchStart = now();
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        const cards = list.querySelectorAll(".market-card").length;
        const buildMs = round(now() - batchStart);
        // Forced synchronous layout so the measurement includes style + layout,
        // which is what actually hurts on Android.
        const layoutStart = now();
        void list.offsetHeight;
        const layoutMs = round(now() - layoutStart);
        report.market = {
          cards,
          domBuildMs: buildMs,
          forcedLayoutMs: layoutMs,
          at: round(now()),
        };
        log("MARKET RENDER", report.market);
        batchStart = 0;
      }, 60);
    });
    listObserver.observe(list, { childList: true });
    return true;
  }
  if (!watchMarketList()) {
    document.addEventListener("DOMContentLoaded", watchMarketList, { once: true });
  }

  /* ---------------------------------------------------------------- *
   * Snapshot of DOM / network / image cost.
   * ---------------------------------------------------------------- */
  function collectSnapshot() {
    report.dom = {
      nodes: document.getElementsByTagName("*").length,
      imgTags: document.querySelectorAll("img").length,
      strippedImages,
      cssSheets: document.styleSheets.length,
      cssRules: (() => {
        let total = 0;
        for (const sheet of document.styleSheets) {
          try {
            total += sheet.cssRules.length;
          } catch (_) {}
        }
        return total;
      })(),
      htmlClasses: document.documentElement.className,
    };

    const resources = performance.getEntriesByType("resource");
    const byType = {};
    let totalBytes = 0;
    resources.forEach((entry) => {
      const bytes = entry.decodedBodySize || 0;
      byType[entry.initiatorType] = (byType[entry.initiatorType] || 0) + bytes;
      totalBytes += bytes;
    });
    const slowest = resources
      .slice()
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 12)
      .map((entry) => ({
        name: entry.name.split("/").slice(-1)[0].slice(0, 48),
        type: entry.initiatorType,
        startMs: round(entry.startTime),
        durMs: round(entry.duration),
        kb: round(bytesToKb(entry.decodedBodySize)),
      }));
    report.network = {
      requests: resources.length,
      totalMb: Number((totalBytes / 1048576).toFixed(2)),
      byTypeMb: Object.fromEntries(
        Object.entries(byType).map(([key, value]) => [key, Number((value / 1048576).toFixed(2))]),
      ),
      previewRequests: resources.filter((entry) => entry.name.includes("/preview")).length,
      slowest,
    };

    let decodedBitmapMb = 0;
    let offscreen = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (!img.naturalWidth) return;
      decodedBitmapMb += (img.naturalWidth * img.naturalHeight * 4) / 1048576;
      const rect = img.getBoundingClientRect();
      if (!rect.width || !rect.height) offscreen += 1;
    });
    report.images = {
      decodedBitmapMb: Number(decodedBitmapMb.toFixed(1)),
      loadedOffscreenImages: offscreen,
      estimate_note: "RGBA estimate from intrinsic dimensions; not measured process RAM",
    };

    const navigation = performance.getEntriesByType("navigation")[0];
    if (navigation) {
      report.marks.domContentLoaded = round(navigation.domContentLoadedEventEnd);
      report.marks.loadEvent = round(navigation.loadEventEnd);
      report.marks.responseEnd = round(navigation.responseEnd);
    }
    return report;
  }

  function bytesToKb(bytes) {
    return (Number(bytes) || 0) / 1024;
  }

  window.__perfDiagReport = () => {
    collectSnapshot();
    log("REPORT", report);
    return report;
  };

  window.__perfDiagCopy = async () => {
    const text = JSON.stringify(window.__perfDiagReport(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    return text;
  };

  /* ---------------------------------------------------------------- *
   * Overlay.
   * ---------------------------------------------------------------- */
  let overlay = null;
  let overlayText = null;
  let copyButton = null;
  let collapseButton = null;
  let collapsed = false;
  function ensureOverlay() {
    if (overlay || !document.body) return overlay;
    overlay = document.createElement("div");
    overlay.id = "perf-diag-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "z-index:2147483647",
      "background:rgba(0,0,0,0.82)",
      "color:#7CFF9B",
      "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
      "padding:6px 8px",
      "max-width:62vw",
      "pointer-events:auto",
      "border-bottom-right-radius:8px",
    ].join(";");
    overlayText = document.createElement("pre");
    overlayText.style.cssText = "margin:0;white-space:pre;font:inherit";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;margin-top:5px";
    copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "Скопировать отчёт";
    copyButton.style.cssText = "font:11px sans-serif;padding:4px 6px";
    copyButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await window.__perfDiagCopy();
        copyButton.textContent = "Скопировано";
      } catch (_) {
        copyButton.textContent = "Ошибка копирования";
      }
      setTimeout(() => {
        if (copyButton) copyButton.textContent = "Скопировать отчёт";
      }, 1800);
    });
    collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.textContent = "Свернуть";
    collapseButton.style.cssText = "font:11px sans-serif;padding:4px 6px";
    collapseButton.addEventListener("click", (event) => {
      event.stopPropagation();
      collapsed = !collapsed;
      renderOverlay();
    });
    actions.append(copyButton, collapseButton);
    overlay.append(overlayText, actions);
    document.body.appendChild(overlay);
    return overlay;
  }

  function renderOverlay() {
    if (!ensureOverlay()) return;
    if (collapsed) {
      overlayText.textContent = `perf ${flags.mode}`;
      if (copyButton) copyButton.hidden = true;
      if (collapseButton) collapseButton.textContent = "Развернуть";
      return;
    }
    if (copyButton) copyButton.hidden = false;
    if (collapseButton) collapseButton.textContent = "Свернуть";
    const lt = report.longTasks;
    const lines = [
      `MODE ${flags.mode}${flags.disabled.length ? ` off:${flags.disabled.join("+")}` : ""}`,
      `fcp ${report.marks["first-contentful-paint"] ?? "-"}ms  lcp ${report.marks["largest-contentful-paint"] ?? "-"}ms`,
      `longtask n=${lt.count} tot=${round(lt.totalMs)}ms max=${round(lt.maxMs)}ms >100ms=${lt.over100ms}`,
      `fps worst=${report.frames.worstFps ?? "-"} gap=${round(report.frames.longestGapMs)}ms`,
      `input n=${report.input.count} max=${round(report.input.maxDelayMs)}ms`,
      `dom ${report.dom.nodes} nodes  css ${report.dom.cssRules} rules`,
      `net ${report.network.requests ?? "-"} req ${report.network.totalMb ?? "-"}MB (img ${report.network.byTypeMb?.img || 0}MB)`,
      `bitmap~ ${report.images.decodedBitmapMb ?? "-"}MB offscreen=${report.images.loadedOffscreenImages ?? "-"}`,
      `preview req ${report.network.previewRequests}`,
      `market cards=${report.market.cards ?? "-"} build=${report.market.domBuildMs ?? "-"}ms layout=${report.market.forcedLayoutMs ?? "-"}ms`,
      ...(flags.hardMarketIsolation
        ? [`isolated nodes=${report.isolation.detachedNodes} blocked=${report.isolation.blockedRequests.length}`]
        : []),
    ];
    overlayText.textContent = lines.join("\n");
  }

  if (document.body) ensureOverlay();
  else document.addEventListener("DOMContentLoaded", ensureOverlay, { once: true });

  // Full DOM/resource snapshots are deliberately sparse. Running them every
  // animation frame (or every second) would distort the Android result.
  setTimeout(() => {
    window.__perfDiagReport();
    renderOverlay();
  }, 5000);
  setTimeout(() => {
    window.__perfDiagReport();
    renderOverlay();
  }, 12000);
  log("ACTIVE", flags);
})();
