/*
 * Profile first-paint trace (diagnostics only).
 *
 * Inert by default. Loaded only when the URL carries `ptrace=1` (query/hash) or
 * the Telegram start parameter contains `ptrace1`, AND the page is served from
 * the STAGING host or localhost. Normal users and PROD never load or run it.
 *
 * Staging link:  https://t.me/<test_bot>?startapp=ptrace1
 *
 * It records, relative to the first time Profile is requested:
 *   - semantic events (route, cached state, Telegram photo, bootstrap, full
 *     /api/me, cosmetics, saved tab, avatar assigned/settled, reveal, backdrop);
 *   - a snapshot on every one of them (avatar src, active tab plate incl. box-shadow,
 *     backdrop-filter, pseudo-elements, running transitions and the ancestor chain
 *     that creates backdrop roots, gradient and navbar computed styles, loading state);
 *   - every real visual change seen frame by frame (requestAnimationFrame diff),
 *     which is what actually reached the screen, including late navbar blur.
 *
 * Output: overlay with a "Скопировать trace" button, `window.__ptraceReport()`,
 * `window.__ptraceCopy()` and `ptrace:` lines in the console.
 * Never logged: tokens, initData, query strings, user ids, raw avatar URLs.
 */
(function () {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const params = new URLSearchParams(
    [search.startsWith("?") ? search.slice(1) : search, hash.replace(/^#\??/, "")].filter(Boolean).join("&"),
  );
  const startParam = String(
    params.get("tgWebAppStartParam") || window.Telegram?.WebApp?.initDataUnsafe?.start_param || "",
  );
  const requested = params.get("ptrace") === "1" || hash.includes("ptrace=1") || startParam.includes("ptrace1");
  const host = String(window.location.hostname || "");
  const allowedHost = host === "test.rpmarket.shop" || host === "localhost" || host === "127.0.0.1";
  if (!requested || !allowedHost) return;
  if (window.__ptrace) return;

  // A/B experiments (diagnostics only, same gating as the trace itself):
  //   startapp=ptrace1-nobd           no backdrop-filter inside Profile
  //   startapp=ptrace1-noanim         no profileFadeIn opacity animation
  //   startapp=ptrace1-nobd-noanim    both
  // (or &ptraceab=nobd,noanim in the URL). They isolate which mechanism produces
  // the one-frame white backdrop; they are not fixes and never run for users.
  const abSource = `${startParam} ${String(params.get("ptraceab") || "")}`.toLowerCase();
  const ab = { nobd: /nobd/.test(abSource), noanim: /noanim/.test(abSource) };
  if (ab.nobd || ab.noanim) {
    const style = document.createElement("style");
    style.id = "profile-trace-ab";
    const rules = [];
    if (ab.nobd) {
      rules.push(
        ".page-profile, .page-profile *, .page-profile *::before, .page-profile *::after {" +
        " backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }",
      );
    }
    if (ab.noanim) {
      rules.push(
        ":root:root body .page-profile.active .profile-content-layer.swipe-enter-left," +
        ":root:root body .page-profile.active .profile-content-layer.swipe-enter-right," +
        ":root:root body .page-profile.active .profile-content-layer {" +
        " animation: none !important; }",
      );
    }
    style.textContent = rules.join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  const MAX_TRACE_MS_AFTER_ENTRY = 30000;
  const MAX_TRACE_MS_WITHOUT_ENTRY = 120000;
  const startedAt = performance.now();
  const events = [];
  let entryAt = null;
  let lastSnapshotKey = "";
  let lastSnapshot = null;

  /* ------------------------------------------------------------------ *
   * Sanitising helpers: nothing identifying leaves the page.
   * ------------------------------------------------------------------ */
  function safeUrl(value) {
    const raw = String(value || "");
    if (!raw || raw === "none") return "";
    const match = raw.match(/url\((['"]?)(.*?)\1\)/);
    const url = match ? match[2] : raw;
    if (/^data:image\//i.test(url)) return `data:${url.slice(5, url.indexOf(";"))}#len=${url.length}`;
    if (/^blob:/i.test(url)) return "blob:#";
    if (/gradient\(/.test(url)) return `gradient#${url.length}`;
    // Absolute URLs are external user content (e.g. Telegram photos): their path
    // identifies a person, so only the kind and host are kept.
    const absolute = url.match(/^https?:\/\/([^/?#]+)/i);
    if (absolute && absolute[1] !== window.location.host) return `external:${absolute[1]}`;
    // Same-origin app paths: keep the path, drop query/hash (tokens / ids).
    const noQuery = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0].split("#")[0];
    const proxied = /\/api\/avatar$/.test(noQuery) ? " (proxied remote photo)" : "";
    return `${noQuery}${proxied}`.slice(0, 120);
  }
  function safePath(path) {
    const raw = String(path || "");
    const [pathname, query = ""] = raw.split("?");
    const qs = new URLSearchParams(query);
    const flags = ["bootstrap", "full"].filter((key) => qs.get(key) === "1");
    return flags.length ? `${pathname}?${flags.join("&")}` : pathname;
  }
  const round = (n) => Math.round(Number(n) * 100) / 100;

  /* ------------------------------------------------------------------ *
   * Snapshot of everything relevant to the four visible symptoms.
   * ------------------------------------------------------------------ */
  function snapshot() {
    const q = (selector) => document.querySelector(selector);
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const section = q('[data-page="profile"]');
    const ss = cs(section);
    const layer = q("[data-profile-content-layer]");
    const ls = cs(layer);
    const gradient = q("[data-profile-viewport-background]");
    const gs = cs(gradient);
    const bar = q("#mainActionBar");
    const bs = cs(bar);
    const group = q("#mainActionBar .nav-group");
    const gps = cs(group);
    const side = q("#mainActionBar .nav-btn--side");
    const sds = cs(side);
    const avatar = q("#profileAvatar");
    const navAvatar = q(".nav-profile-avatar");
    const tabsWrap = q("#profileSectionsTabs");
    const activeTab = q("#profileSectionsTabs .profile-sections-tab.active");
    const activePane = q(".profile-section-pane.active");
    const content = q("#profileSectionsContent");
    const loader = q("[data-root-page-loader]");
    const overlay = q(".ui-loader-overlay");
    const blurOf = (style) => {
      if (!style) return "missing";
      const v = style.backdropFilter && style.backdropFilter !== "none" ? style.backdropFilter : style.webkitBackdropFilter;
      return v && v !== "none" ? v : "none";
    };
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [round(r.x), round(r.y), round(r.width), round(r.height)];
    };
    const pseudo = (el, which) => {
      if (!el) return null;
      const st = getComputedStyle(el, which);
      const content = st.content;
      if (!content || content === "none" || content === "normal") return "none";
      return `content=${content} bg=${st.backgroundColor} img=${String(st.backgroundImage).slice(0, 40)} op=${st.opacity} disp=${st.display}`;
    };
    const anims = (el) => {
      try {
        return el.getAnimations().map((a) => `${a.constructor.name}:${a.transitionProperty || a.animationName || ""}@${Math.round(Number(a.currentTime) || 0)}ms/${a.playState}`).join(",");
      } catch (_) { return ""; }
    };
    const tabDetail = (el) => {
      if (!el) return null;
      const st = getComputedStyle(el);
      let pseudoState = "";
      try { pseudoState = [":active", ":hover", ":focus", ":focus-visible"].filter((m) => el.matches(m)).join(""); } catch (_) { /* ignore */ }
      return {
        cls: el.className,
        bgColor: st.backgroundColor, bgImage: String(st.backgroundImage).slice(0, 60),
        boxShadow: String(st.boxShadow).slice(0, 80), opacity: st.opacity, transform: st.transform,
        backdrop: st.backdropFilter && st.backdropFilter !== "none" ? st.backdropFilter : "none", filter: st.filter,
        transition: String(st.transitionProperty).slice(0, 60), anims: anims(el), pseudoState,
        before: pseudo(el, "::before"), after: pseudo(el, "::after"),
        rect: rect(el),
      };
    };
    // Every ancestor that would make the tab a backdrop-filter child of a new
    // backdrop root (opacity, filter, transform, mask, will-change, isolation...).
    const ancestorChain = (el) => {
      const out = [];
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const st = getComputedStyle(node);
        const flags = [];
        if (Number(st.opacity) < 1) flags.push(`opacity=${round(st.opacity)}`);
        if (st.filter !== "none") flags.push(`filter=${st.filter.slice(0, 20)}`);
        if (st.transform !== "none") flags.push("transform");
        if (st.backdropFilter && st.backdropFilter !== "none") flags.push(`backdrop=${st.backdropFilter}`);
        if (st.mixBlendMode !== "normal") flags.push(`blend=${st.mixBlendMode}`);
        if (st.willChange !== "auto") flags.push(`willChange=${st.willChange.slice(0, 24)}`);
        if (st.isolation === "isolate") flags.push("isolate");
        if (st.animationName !== "none") flags.push(`anim=${st.animationName}`);
        if (flags.length) out.push(`${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}.${String(node.className || "").split(" ")[0]}[${flags.join(";")}]`);
      }
      return out.join(" < ");
    };
    const allTabs = {};
    Array.from(document.querySelectorAll("#profileSectionsTabs .profile-sections-tab")).forEach((btn) => {
      const st = getComputedStyle(btn);
      allTabs[btn.getAttribute("data-profile-section") || "?"] = `${btn.classList.contains("active") ? "ACTIVE" : "idle"} bg=${st.backgroundColor} sh=${String(st.boxShadow).slice(0, 24)} anims=${anims(btn)}`;
    });
    let stateInfo = null;
    try {
      stateInfo = {
        page: state.page,
        bootstrapLoaded: Boolean(stateProfile.bootstrapLoaded),
        appearanceLoaded: Boolean(stateProfile.appearanceLoaded),
        fullLoaded: Boolean(stateProfile.fullLoaded),
        sectionTab: stateProfile.sectionTab,
        profileReady: typeof readyRootPages !== "undefined" ? readyRootPages.has("profile") : null,
      };
    } catch (_) { /* state not defined yet */ }
    return {
      avatar: { hero: safeUrl(cs(avatar)?.backgroundImage), heroText: (avatar?.textContent || "").trim().slice(0, 3), nav: safeUrl(cs(navAvatar)?.backgroundImage), navText: (navAvatar?.textContent || "").trim().slice(0, 3) },
      tabPlate: {
        selector: "#profileSectionsTabs .profile-sections-tab.active",
        allTabs,
        active: tabDetail(activeTab),
        wrap: tabDetail(tabsWrap),
        ancestors: activeTab ? ancestorChain(activeTab) : "",
      },
      tab: {
        active: activeTab?.getAttribute("data-profile-section") || "",
        pane: activePane?.getAttribute("data-profile-section-pane") || "",
        activeBg: cs(activeTab)?.backgroundColor || "",
        activeColor: cs(activeTab)?.color || "",
        wrapBg: cs(tabsWrap)?.backgroundColor || "",
        wrapBorder: cs(tabsWrap)?.borderTopColor || "",
      },
      theme: {
        sectionPc1: ss?.getPropertyValue("--pc1").trim() || "",
        sectionPc2: ss?.getPropertyValue("--pc2").trim() || "",
        bodyPc1: getComputedStyle(document.body).getPropertyValue("--pc1").trim(),
        pattern: q("#profilePatternOverlay")?.getAttribute("data-pattern") || "",
      },
      gradient: {
        visibility: gs?.visibility || "missing", opacity: gs?.opacity || "", rect: rect(gradient),
        image: String(gs?.backgroundImage || "").slice(0, 110),
      },
      navbar: {
        hidden: !bar || bar.classList.contains("hidden") || bs.display === "none" || bs.visibility === "hidden",
        opacity: bs ? round(bs.opacity) : 0,
        groupBlur: blurOf(gps), sideBlur: blurOf(sds),
        groupBg: String(gps?.backgroundImage || "").slice(0, 60),
        groupBorder: gps?.borderTopColor || "",
        classes: bar?.className || "",
      },
      classes: {
        html: document.documentElement.className,
        body: document.body ? document.body.className : "",
        profilePage: section?.className || "",
      },
      profile: {
        pageActive: Boolean(section?.classList.contains("active")),
        display: ss?.display || "", visibility: ss?.visibility || "",
        layerOpacity: ls ? round(ls.opacity) : null, layerVisibility: ls?.visibility || "",
        loaderShown: Boolean(loader && !loader.classList.contains("hidden")), loaderFor: loader?.dataset?.loadingPage || "",
        initOverlayOpacity: overlay ? round(getComputedStyle(overlay).opacity) : 0,
        contentRect: rect(content), layerRect: rect(layer),
      },
      state: stateInfo,
    };
  }

  function flatten(obj, prefix = "", out = {}) {
    Object.keys(obj || {}).forEach((key) => {
      const value = obj[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out);
      else out[path] = JSON.stringify(value);
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Event log.
   * ------------------------------------------------------------------ */
  function record(name, detail, options = {}) {
    let snap = null;
    try { snap = options.noSnapshot ? null : snapshot(); } catch (_) { snap = null; }
    const abs = performance.now() - startedAt;
    const entry = { abs: round(abs), name, detail: detail || null, snap };
    events.push(entry);
    try {
      // eslint-disable-next-line no-console
      console.info(`ptrace: +${round(entryAt === null ? abs : abs - entryAt)}ms ${name}`, detail || "");
    } catch (_) { /* ignore */ }
    renderOverlay(entry);
    return entry;
  }
  function markEntry(source) {
    if (entryAt !== null) return;
    entryAt = performance.now() - startedAt;
    record("ENTRY profile requested", { source });
  }
  window.__ptrace = { record, markEntry };

  /* ------------------------------------------------------------------ *
   * Frame-by-frame visual diff: what actually changed on screen.
   * ------------------------------------------------------------------ */
  const VISUAL_KEYS = [
    "avatar.hero", "avatar.heroText", "avatar.nav", "avatar.navText",
    "tabPlate.allTabs.stats", "tabPlate.allTabs.referrals", "tabPlate.allTabs.promocode",
    "tabPlate.active.bgColor", "tabPlate.active.bgImage", "tabPlate.active.boxShadow", "tabPlate.active.opacity",
    "tabPlate.active.transform", "tabPlate.active.backdrop", "tabPlate.active.filter", "tabPlate.active.anims",
    "tabPlate.active.pseudoState", "tabPlate.active.before", "tabPlate.active.after", "tabPlate.active.rect",
    "tabPlate.wrap.bgColor", "tabPlate.wrap.boxShadow", "tabPlate.wrap.backdrop", "tabPlate.wrap.opacity", "tabPlate.wrap.anims",
    "tabPlate.ancestors",
    "tab.active", "tab.pane", "tab.activeBg", "tab.activeColor", "tab.wrapBg", "tab.wrapBorder",
    "theme.sectionPc1", "theme.sectionPc2", "theme.bodyPc1", "theme.pattern",
    "gradient.visibility", "gradient.opacity", "gradient.rect", "gradient.image",
    "navbar.hidden", "navbar.opacity", "navbar.groupBlur", "navbar.sideBlur", "navbar.groupBg", "navbar.groupBorder",
    "profile.pageActive", "profile.display", "profile.visibility", "profile.layerOpacity", "profile.layerVisibility",
    "profile.loaderShown", "profile.loaderFor", "profile.initOverlayOpacity", "profile.contentRect", "profile.layerRect",
    "classes.html", "classes.body", "classes.profilePage",
  ];
  let frameCount = 0;
  function frameTick() {
    const elapsed = performance.now() - startedAt;
    const sinceEntry = entryAt === null ? 0 : elapsed - entryAt;
    const expired = entryAt === null ? elapsed > MAX_TRACE_MS_WITHOUT_ENTRY : sinceEntry > MAX_TRACE_MS_AFTER_ENTRY;
    if (expired) { record("TRACE finished", { frames: frameCount }, { noSnapshot: true }); return; }
    frameCount += 1;
    try {
      const snap = snapshot();
      const flat = flatten(snap);
      const key = VISUAL_KEYS.map((k) => flat[k]).join("|");
      if (key !== lastSnapshotKey) {
        const prev = lastSnapshot ? flatten(lastSnapshot) : {};
        const changed = {};
        VISUAL_KEYS.forEach((k) => { if (flat[k] !== prev[k]) changed[k] = [prev[k] ?? null, flat[k]]; });
        lastSnapshotKey = key;
        lastSnapshot = snap;
        const abs = round(elapsed);
        events.push({ abs, name: "FRAME visual-change", detail: { frame: frameCount, changed }, snap });
        try { console.info(`ptrace: +${round(entryAt === null ? abs : abs - entryAt)}ms FRAME visual-change`, Object.keys(changed).join(",")); } catch (_) { /* ignore */ }
        renderOverlay(events[events.length - 1]);
      }
    } catch (_) { /* never break the page */ }
    requestAnimationFrame(frameTick);
  }

  /* ------------------------------------------------------------------ *
   * Function wrappers (installed after app-combined.js, before app.js).
   * Top-level function declarations are global bindings, so replacing the
   * property changes what the bundle itself calls.
   * ------------------------------------------------------------------ */
  function wrap(name, make) {
    try {
      const original = window[name];
      if (typeof original !== "function" || original.__ptraceWrapped) return;
      const wrapper = make(original);
      wrapper.__ptraceWrapped = true;
      window[name] = wrapper;
    } catch (_) { /* ignore */ }
  }
  const settleBoth = (result, onOk, onErr) => {
    if (result && typeof result.then === "function") {
      result.then((value) => { onOk(value); return value; }, (error) => { onErr(error); });
    }
    return result;
  };
  const targetName = (el) => (el ? (el.id || String(el.className || "").split(" ")[0] || el.tagName) : "none");

  function installWrappers() {
    if (window.__ptraceWrappersInstalled) return;
    window.__ptraceWrappersInstalled = true;
    const telegramUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
    record("INSTALL wrappers", {
      telegramUserPresent: Boolean(telegramUser),
      telegramPhotoPresent: Boolean(telegramUser && telegramUser.photo_url),
      platform: window.Telegram?.WebApp?.platform || "unknown",
      tgVersion: window.Telegram?.WebApp?.version || "",
      isExpanded: window.Telegram?.WebApp?.isExpanded ?? null,
      colorScheme: window.Telegram?.WebApp?.colorScheme || "",
      viewport: [window.innerWidth, window.innerHeight, window.visualViewport ? round(window.visualViewport.height) : null],
      dpr: window.devicePixelRatio,
      cachedColorsInStorage: (() => { try { return Boolean(localStorage.getItem("mancini_profile_colors")); } catch (_) { return null; } })(),
      cachedPatternInStorage: (() => { try { return Boolean(localStorage.getItem("mancini_profile_pattern")); } catch (_) { return null; } })(),
      savedTabInStorage: (() => { try { return localStorage.getItem("mancini_profile_section_tab"); } catch (_) { return null; } })(),
      assetVersion: window.__APP_ASSET_VERSION__ || "",
      abExperiment: ab,
    });

    wrap("openRootTab", (orig) => function (page, ...rest) {
      if (page === "profile") markEntry("openRootTab");
      record(`route openRootTab(${page})`, { page });
      return orig.call(this, page, ...rest);
    });
    wrap("resetNavTo", (orig) => function (page, options) {
      if (page === "profile") markEntry("resetNavTo");
      record(`route resetNavTo(${page})`, { page, options: options ? Object.keys(options) : [] });
      return orig.call(this, page, options);
    });
    wrap("setActivePage", (orig) => function (page, options) {
      if (page === "profile") markEntry("setActivePage");
      const result = orig.call(this, page, options);
      if (page === "profile") record("route setActivePage(profile) done", { rootGate: Boolean(options && options.rootGate), animate: options ? options.animate !== false : true });
      return result;
    });

    // Cached (stale-able) state applied before any server answer.
    wrap("loadProfileColors", (orig) => function () {
      const result = orig.apply(this, arguments);
      record("CACHED loadProfileColors()", null);
      return result;
    });
    wrap("loadProfilePattern", (orig) => function () {
      const result = orig.apply(this, arguments);
      record("CACHED loadProfilePattern()", null);
      return result;
    });
    wrap("applyProfileColors", (orig) => function (c1, c2) {
      record("COSMETICS applyProfileColors", { c1, c2 }, { noSnapshot: true });
      const result = orig.call(this, c1, c2);
      record("COSMETICS applyProfileColors done", { c1, c2 });
      return result;
    });
    wrap("applyProfilePattern", (orig) => function (id) {
      const result = orig.call(this, id);
      record("COSMETICS applyProfilePattern", { pattern: id || "" });
      return result;
    });
    wrap("applyCosmeticsToDisplay", (orig) => function () {
      const result = orig.apply(this, arguments);
      record("COSMETICS applyCosmeticsToDisplay", null);
      return result;
    });
    wrap("applyHeroThemeFromCosmetics", (orig) => function () {
      const result = orig.apply(this, arguments);
      record("COSMETICS applyHeroThemeFromCosmetics", null);
      return result;
    });
    wrap("setProfileSectionTab", (orig) => function (tab, options) {
      const result = orig.call(this, tab, options);
      record("TAB setProfileSectionTab", { tab, persist: options?.persist, force: options?.force, triggerLoad: options?.triggerLoad });
      return result;
    });

    // Profile data.
    wrap("loadBootstrapProfile", (orig) => function () {
      record("DATA bootstrap /api/me start", null, { noSnapshot: true });
      const result = orig.apply(this, arguments);
      return settleBoth(result,
        (data) => record("DATA bootstrap /api/me resolved", { hasAvatarData: Boolean(data?.avatar_data), hasAvatarUrl: Boolean(data?.avatar_url), hasCosmetics: Boolean(data?.cosmetics), telegramPhotoPresent: Boolean(window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url) }),
        (error) => record("DATA bootstrap /api/me failed", { status: error?.status || 0 }));
    });
    wrap("loadProfile", (orig) => function (options) {
      record("DATA loadProfile start", { full: Boolean(options?.full), force: Boolean(options?.force), page: (() => { try { return state.page; } catch (_) { return ""; } })() }, { noSnapshot: true });
      const result = orig.apply(this, arguments);
      return settleBoth(result,
        (data) => record("DATA loadProfile resolved", { full: Boolean(data?.profile_full), hasAvatarData: Boolean(data?.avatar_data), hasAvatarUrl: Boolean(data?.avatar_url), cosmeticsColors: Boolean(data?.cosmetics?.profile_color_1), cosmeticsPattern: Boolean(data?.cosmetics?.profile_pattern) }),
        (error) => record("DATA loadProfile failed", { status: error?.status || 0 }));
    });
    wrap("apiRequest", (orig) => function (path) {
      const raw = String(path || "");
      const interesting = /\/api\/(me|my_listings|referrals|user-avatar|avatar)\b/.test(raw);
      if (!interesting) return orig.apply(this, arguments);
      const label = safePath(raw);
      const started = performance.now();
      record(`NET start ${label}`, null, { noSnapshot: true });
      const result = orig.apply(this, arguments);
      return settleBoth(result,
        () => record(`NET end ${label}`, { ms: Math.round(performance.now() - started) }, { noSnapshot: true }),
        (error) => record(`NET failed ${label}`, { ms: Math.round(performance.now() - started), status: error?.status || 0, code: String(error?.payload?.error || error?.name || "").slice(0, 40) }, { noSnapshot: true }));
    });

    // Avatar.
    wrap("setAvatarPreview", (orig) => function (target, dataUrl, fallbackText) {
      let isTelegramPhoto = false;
      try { isTelegramPhoto = Boolean(dataUrl) && dataUrl === getTelegramUserPhoto(); } catch (_) { /* ignore */ }
      const result = orig.call(this, target, dataUrl, fallbackText);
      record("AVATAR assigned", { target: targetName(target), url: safeUrl(dataUrl), isTelegramPhoto });
      try {
        if (typeof whenAvatarSettled === "function") {
          whenAvatarSettled(target).then(() => record("AVATAR settled", { target: targetName(target) }));
        }
      } catch (_) { /* ignore */ }
      return result;
    });

    // Reveal / backdrop / gate.
    wrap("setRootPageLoading", (orig) => function (page, loading, failed) {
      const result = orig.call(this, page, loading, failed);
      if (page === "profile") record(`REVEAL setRootPageLoading(profile, loading=${Boolean(loading)})`, { loading: Boolean(loading), failed: Boolean(failed) });
      return result;
    });
    wrap("runPageSwipeAnimation", (orig) => function (page, direction) {
      const result = orig.call(this, page, direction);
      if (page === "profile") record("REVEAL swipe animation started", { direction });
      return result;
    });
    wrap("syncProfileBackdrop", (orig) => function () {
      const result = orig.apply(this, arguments);
      record("BACKDROP syncProfileBackdrop", { profileBgActive: document.body.classList.contains("profile-bg-active") });
      return result;
    });
    wrap("gateProfileEntryFirstPaint", (orig) => function () {
      markEntry("gateProfileEntryFirstPaint");
      record("GATE ungated entry start", null);
      return settleBoth(orig.apply(this, arguments), () => record("GATE ungated entry end", null), () => record("GATE ungated entry failed", null));
    });
    wrap("prepareRootPage", (orig) => function (page) {
      if (page !== "profile") return orig.apply(this, arguments);
      record("GATE prepareRootPage(profile) start", null, { noSnapshot: true });
      return settleBoth(orig.apply(this, arguments), (ok) => record("GATE prepareRootPage(profile) end", { ok }), () => record("GATE prepareRootPage(profile) failed", null));
    });
    wrap("settleProfileFirstPaintAssets", (orig) => function () {
      record("GATE avatar assets wait start", null, { noSnapshot: true });
      return settleBoth(orig.apply(this, arguments), () => record("GATE avatar assets wait end", null));
    });
  }

  /* ------------------------------------------------------------------ *
   * Report, copy, overlay.
   * ------------------------------------------------------------------ */
  function buildReport() {
    const base = entryAt === null ? 0 : entryAt;
    return {
      kind: "profile-first-paint-trace",
      note: "t = ms relative to the first Profile request (negative = before it). abs = ms since script start.",
      device: {
        ua: navigator.userAgent,
        platform: window.Telegram?.WebApp?.platform || "unknown",
        tgVersion: window.Telegram?.WebApp?.version || "",
        viewport: [window.innerWidth, window.innerHeight],
        assetVersion: window.__APP_ASSET_VERSION__ || "",
        abExperiment: ab,
      },
      entryAbs: entryAt === null ? null : round(entryAt),
      paint: (performance.getEntriesByType("paint") || []).map((e) => ({ name: e.name, t: round(e.startTime - startedAt - base) })),
      events: events.map((e) => ({ t: round(e.abs - base), abs: e.abs, name: e.name, detail: e.detail, snap: e.snap })),
    };
  }
  window.__ptraceReport = buildReport;
  window.__ptraceCopy = async () => {
    const text = JSON.stringify(buildReport(), null, 1);
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

  let overlay = null;
  let overlayLine = null;
  let collapsed = false;
  function ensureOverlay() {
    if (overlay || !document.body) return overlay;
    overlay = document.createElement("div");
    overlay.id = "profile-trace-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;background:rgba(0,0,0,.82);color:#ffd27c;font:11px/1.35 ui-monospace,Menlo,monospace;padding:6px 8px;max-width:70vw;border-bottom-right-radius:8px;pointer-events:auto";
    overlayLine = document.createElement("div");
    overlayLine.style.cssText = "white-space:pre-wrap;word-break:break-all";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:5px;margin-top:5px";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Скопировать trace";
    copy.style.cssText = "font:11px sans-serif;padding:4px 6px";
    copy.addEventListener("click", async (event) => {
      event.stopPropagation();
      try { await window.__ptraceCopy(); copy.textContent = "Скопировано"; } catch (_) { copy.textContent = "Ошибка копирования"; }
      setTimeout(() => { copy.textContent = "Скопировать trace"; }, 1800);
    });
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.textContent = "Свернуть";
    collapse.style.cssText = "font:11px sans-serif;padding:4px 6px";
    collapse.addEventListener("click", (event) => {
      event.stopPropagation();
      collapsed = !collapsed;
      overlayLine.style.display = collapsed ? "none" : "block";
      collapse.textContent = collapsed ? "Развернуть" : "Свернуть";
    });
    actions.append(copy, collapse);
    overlay.append(overlayLine, actions);
    document.body.appendChild(overlay);
    return overlay;
  }
  function renderOverlay(entry) {
    if (!ensureOverlay() || !overlayLine) return;
    const mode = ab.nobd || ab.noanim ? ` [A/B${ab.nobd ? " nobd" : ""}${ab.noanim ? " noanim" : ""}]` : "";
    overlayLine.textContent = `ptrace${mode} ${events.length} ev | ${entry ? entry.name : ""}`.slice(0, 160);
  }

  // Who flips the plate: log every class change on the tabs / profile layer with
  // the old and new value and the semantic event that ran just before it.
  function observeTabMutations() {
    const targets = [
      ...document.querySelectorAll("#profileSectionsTabs .profile-sections-tab"),
      document.getElementById("profileSectionsTabs"),
      document.querySelector("[data-profile-content-layer]"),
      document.querySelector('[data-page="profile"]'),
    ].filter(Boolean);
    if (!targets.length || observeTabMutations.done) return;
    observeTabMutations.done = true;
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        const el = m.target;
        const label = el.getAttribute?.("data-profile-section") || el.id || String(el.className || "").split(" ")[0];
        const lastSemantic = [...events].reverse().find((e) => !e.name.startsWith("FRAME"));
        record(`MUTATION ${m.attributeName} on ${label}`, {
          old: String(m.oldValue || "").slice(0, 120),
          now: String(el.getAttribute(m.attributeName) || "").slice(0, 120),
          after: lastSemantic ? lastSemantic.name : "",
        });
      });
    });
    targets.forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ["class", "hidden", "aria-selected"], attributeOldValue: true }));
  }

  window.__ptraceInstallWrappers = installWrappers;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observeTabMutations);
  else observeTabMutations();
  record("TRACE script loaded", { host }, { noSnapshot: true });
  requestAnimationFrame(frameTick);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => renderOverlay(null));
  else renderOverlay(null);
})();
