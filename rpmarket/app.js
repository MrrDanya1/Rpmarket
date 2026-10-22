/* RP Market guest-only mode for the GitHub Pages copy.
   Browsing must never trigger the Telegram sign-in flow.
   Server-backed actions remain unavailable without the original API. */
window.__RP_MARKET_GUEST_MODE__ = true;
try {
  if (typeof webAuthBoot === "function") {
    webAuthBoot = async function () { return null; };
  }
} catch (_) {}

async function runAndroidAuthBridgeIfNeeded() {
  if (window.__RP_MARKET_GUEST_MODE__) return false;
  try {
    const startParam = String(window.Telegram?.WebApp?.initDataUnsafe?.start_param || "").trim();
    if (startParam !== "android_auth") return false;

    const root = document.getElementById("app");
    if (root) {
      root.innerHTML = `
        <div style="padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
          <h2 style="margin:0 0 8px;">RP Market</h2>
          <p style="margin:0;">Подтверждаем вход для Android-приложения...</p>
        </div>
      `;
    }

    let initData = getInitData();
    if (!initData) {
      initData = await waitForInitData(8000);
    }
    if (!initData) {
      throw new Error("init_data_missing");
    }

    const resp = await fetch("/api/v2/auth/telegram/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        init_data: initData,
        device_id: "android-bridge",
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.code) {
      throw new Error(String(data.error || `http_${resp.status}`));
    }

    const origin = String(window.location.origin || "").trim();
    const deepLink = `rpmarket://auth?code=${encodeURIComponent(data.code)}`;
    const bridgeUrl =
      `${origin}/android-auth-return.html` +
      `?code=${encodeURIComponent(data.code)}`;

    try {
      if (window.Telegram?.WebApp?.openLink) {
        window.Telegram.WebApp.openLink(bridgeUrl);
      } else {
        window.location.href = bridgeUrl;
      }
    } catch (_) {
      try {
        window.location.href = bridgeUrl;
      } catch (_) {}
    }
    setTimeout(() => {
      if (root) {
        root.innerHTML = `
          <div style="padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
            <h2 style="margin:0 0 8px;">RP Market</h2>
            <p style="margin:0 0 12px;">Если приложение не открылось автоматически, нажмите кнопку:</p>
            <a href="${bridgeUrl}" style="display:inline-block;padding:10px 14px;background:#1e82f2;color:#fff;border-radius:10px;text-decoration:none;margin-right:8px;">Открыть через браузер</a>
            <a href="${deepLink}" style="display:inline-block;padding:10px 14px;background:#0f172a;color:#fff;border-radius:10px;text-decoration:none;">Открыть deep link</a>
          </div>
        `;
      }
    }, 1200);
    return true;
  } catch (error) {
    const root = document.getElementById("app");
    if (root) {
      root.innerHTML = `
        <div style="padding:24px;font-family:Arial,sans-serif;color:#0f172a;">
          <h2 style="margin:0 0 8px;">RP Market</h2>
          <p style="margin:0 0 12px;">Ошибка входа для Android: ${String(error && error.message ? error.message : error)}</p>
          <button onclick="location.reload()" style="padding:10px 14px;border:0;background:#1e82f2;color:#fff;border-radius:10px;">Повторить</button>
        </div>
      `;
    }
    return true;
  }
}

let interactionFallbacksInstalled = false;

function installInteractionFallbacks() {
  if (interactionFallbacksInstalled) return;
  interactionFallbacksInstalled = true;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;

    const marketTypeButton = target.closest("#marketTypeSwitch [data-market-type]");
    if (marketTypeButton) {
      const nextType = marketTypeButton.dataset.marketType || "all";
      if (stateFilters.listingType !== nextType) {
        setMarketListingTypeFilter(nextType);
        updateFiltersBar();
        loadMarket();
      }
      return;
    }

    const createTypeButton = target.closest("#createTypeSwitch [data-create-type]");
    if (createTypeButton) {
      setCreateListingType(createTypeButton.dataset.createType || "sell");
      return;
    }

    const createCategoryPill = target.closest("#createCategoryPills .pill");
    if (createCategoryPill) {
      const value = String(createCategoryPill.dataset.value || "");
      stateCreate.category = value;
      if (elements.createCategoryInput) {
        elements.createCategoryInput.value = value;
      }
      setActivePill(elements.createCategoryPills, value);
      return;
    }

    const filterCategoryPill = target.closest("#filterCategoryPills .pill");
    if (filterCategoryPill) {
      const value = String(filterCategoryPill.dataset.value || "");
      stateFilters.category = value;
      setActivePill(elements.filterCategoryPills, value);
    }
  });

  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.id !== "createForm") return;
      stateCreate.listingType = elements.createListingTypeInput?.value === "buy" ? "buy" : "sell";
      if (!stateCreate.category && elements.createCategoryInput?.value) {
        stateCreate.category = String(elements.createCategoryInput.value || "");
      }
    },
    true
  );
}

function runMeasuredStartupTask(label, task) {
  const startedAt = performance.now();
  return Promise.resolve()
    .then(task)
    .then((result) => {
      recordFrontendPerf(`STARTUP ${label}`, startedAt, { status: "ok" });
      return result;
    })
    .catch((error) => {
      recordFrontendPerf(`STARTUP ${label}`, startedAt, {
        status: "error",
        error: String(error?.payload?.error || error?.code || error?.name || "request_failed"),
      });
      throw error;
    });
}

function runBackgroundStartupTask(label, task) {
  // Diagnostic Mode B: measure the first screen without any background traffic.
  if (window.__PERF_DIAG__?.skipBackgroundStartup) {
    console.info(`perfdiag: SKIPPED background startup task`, { label });
    return Promise.resolve(null);
  }
  return runMeasuredStartupTask(label, task).catch((error) => {
    console.error(`Background startup task ${label} failed:`, error);
    return null;
  });
}

async function init() {
  const initStartedAt = performance.now();
  if (await runAndroidAuthBridgeIfNeeded()) return;
  const initLoadingToken = beginUiLoading("Загружаем маркет...", "Подбираем объявления");
  try {
  const isAndroidLite = applyAndroidPerfMode();
  applyViewportCssVars();
  window.addEventListener("resize", applyViewportCssVars, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", applyViewportCssVars, { passive: true });
  }
  applyThemeMode(getSavedThemeMode(), { persist: false });
  initTelegramViewportMode();
  applyUiFeatureFlags();
  populateCategories();
  syncActionBarMetrics("market");
  stateRating.mode = normalizeLeaderboardMode(localStorage.getItem(LEADERBOARD_MODE_KEY));
  stateCoins.favoritesCount = getFavoritesSet().size;
  bindEvents();
  installInteractionFallbacks();
  initKeyboardAwareBottomBar();
  renderLeaderboardModeUi();
  renderLeaderboardTimerUi();
  updateCoinsTileBadges();
  updateNavProfileAvatar(); // the last known avatar right away (no Telegram-photo → real-avatar jump)
  ensureLeaderboardTimer();
  initRootSwipeGesture();
  enableTapFeedback();
  if (elements.createFab || elements.actionBar || elements.marketScrollTop) {
    const modals = document.querySelectorAll(".modal");
    if (modals.length) {
      const observer = new MutationObserver(() => {
        updateFabVisibility();
        syncTelegramBackButton();
      });
      modals.forEach((modal) => {
        observer.observe(modal, { attributes: true, attributeFilter: ["class"] });
      });
    }
    initFabScrollBehavior();
    updateMarketScrollChrome();
  }
  restoreMarketServerFilter();
  updateFiltersBar();
  setMarketView();
  if (elements.marketTopBar) {
    elements.marketTopBar.classList.add("is-hidden");
  }
  if (elements.marketFiltersBar) {
    const hintKey = "mancini_filters_hint_seen";
    if (!localStorage.getItem(hintKey)) {
      elements.marketFiltersBar.classList.add("highlight");
      if (filtersHintTimer) clearTimeout(filtersHintTimer);
      filtersHintTimer = setTimeout(() => {
        elements.marketFiltersBar.classList.remove("highlight");
        localStorage.setItem(hintKey, "1");
      }, 2500);
    }
  }
  state.initData = getInitData();
  state.tid = getTid();
  if (!state.tid) {
    state.tid = getTelegramUserId();
  }
  // Plain browser (the website): no Telegram context to wait for. A stored
  // sign-in session provides the user id; otherwise the app runs as guest.
  state.webMode = !state.initData && isWebBrowserMode();
  if (state.webMode) {
    const webSession = await webAuthBoot();
    if (webSession && webSession.telegram_id > 0) state.tid = webSession.telegram_id;
    desktopShellInit();
  }
  const [resolvedInitData, resolvedTelegramUserId] = await Promise.all([
    state.initData || state.webMode ? Promise.resolve(state.initData) : waitForInitData(5000),
    state.tid || state.webMode ? Promise.resolve(state.tid) : waitForTelegramUserId(5000),
  ]);
  if (!state.initData) state.initData = resolvedInitData;
  if (!state.tid) state.tid = resolvedTelegramUserId;
  recordFrontendPerf("STARTUP telegram context", initStartedAt, {
    has_init_data: Boolean(state.initData),
    has_user_id: Boolean(state.tid),
  });
  runBackgroundStartupTask("favorites sync", () => favoritesBootstrapSync());
  loadDailySubscriptionPending();
  loadVipCheckoutPending();
  loadMcoinPackCheckoutPending();
  if (!state.initData && !state.tid) {
    try {
      await loadServers();
    } catch (error) {
      console.error("Failed to load servers during guest init:", error);
    }
    await loadMarket({ allowInactive: true }).catch((error) => {
      console.error("Failed to load market during guest init:", error);
    });
    resetNavTo("market", { skipPageLoad: true });
    return;
  }
  // Only servers and profile are required for routing. Everything else is
  // deliberately background work and must not delay the first usable screen.
  const adminRolePromise = runBackgroundStartupTask("admin role", () => loadAdminRole());
  runBackgroundStartupTask("daily tasks", () => loadDailyLoginStatus({ openModalIfClaimable: true }));
  runBackgroundStartupTask("notifications", () => refreshNotifications());
  const primaryResults = await Promise.allSettled([
    runMeasuredStartupTask("servers", () => loadServers()),
    runMeasuredStartupTask("profile bootstrap", () => loadBootstrapProfile({ timeoutMs: 8000, maxAttempts: 2 })),
  ]);
  const profileResult = primaryResults[1];
  const profile = profileResult.status === "fulfilled" ? profileResult.value : null;
  primaryResults.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Primary startup request ${index} failed:`, result.reason);
    }
  });
  // the first ask runs before auth is ready on a slow start; ask again now (it opens at most once)
  runBackgroundStartupTask("daily tasks (retry)", () => loadDailyLoginStatus({ openModalIfClaimable: true }));
  if (!window.__PERF_DIAG__?.hardMarketIsolation) {
    startLiveMcoinPolling();
  }
  if (!notificationsTimer) {
    notificationsTimer = setInterval(() => {
      refreshNotifications();
    }, isAndroidLite ? 90000 : 45000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshNotifications();
      refreshLiveMcoinBalanceNow();
    }
  });
  if (profile && !String(profile.game_nick || "").trim()) {
    resetNavTo("nickname");
    return;
  }
  if (!profile) {
    await loadMarket({ allowInactive: true }).catch((error) => {
      console.error("Failed to load market after partial init:", error);
    });
    resetNavTo("market", { skipPageLoad: true });
    return;
  }
  const chatListingId = Number(getChatParam() || 0);
  const chatThreadId = Number(getChatThreadParam() || 0);
  if (chatListingId > 0) {
    resetNavTo("profile");
    await openDealChat(chatListingId, { chatId: chatThreadId || undefined });
    return;
  }
  const listingId = getListingParam();
  if (listingId) {
    try {
      await loadListing(Number(listingId));
      return;
    } catch (error) {
      resetNavTo("market");
      await loadMarket();
      showToast("Объявление не найдено.", "info");
      return;
    }
  }
  const clubId = Number(getClubParam() || 0);
  if (clubId > 0 && isUiPageEnabled("club")) {
    resetNavTo("club");
    await loadClubPage();
    await openClubDetail(clubId);
    return;
  }
  const initialPage = getPageParam();
  if (initialPage === "profile-hidden" || initialPage === "profile-active") {
    // Telegram expiry notices: profile on the right tab, focused on the exact listing when it is still there
    // («Скрытые» = expired, renewable; «Активные» = the 3-day warning). Unknown/deleted listing → just the tab.
    setMyListingsTab(initialPage === "profile-hidden" ? "hidden" : "active");
    stateMyListings.focusId = getProfileListingParam() || 0;
    await prepareRootPage("profile");
    resetNavTo("profile", { animate: false, skipPageLoad: true });
    return;
  }
  if (initialPage === "profile") {
    await prepareRootPage("profile");
    resetNavTo("profile", { animate: false, skipPageLoad: true });
    return;
  }
  if (initialPage === "create") {
    resetCreateForm();
    resetNavTo("market");
    navigateTo("create");
    return;
  }
  if (initialPage === "favorites" || initialPage === "coins-favorites") {
    resetNavTo("coins");
    navigateTo("coins-favorites");
    await loadFavorites();
    return;
  }
  if (initialPage === "rating" && isUiPageEnabled("rating")) {
    resetNavTo("leaderboard");
    await loadLeaderboardPage();
    return;
  }
  if (initialPage === "leaderboard" && isUiPageEnabled("leaderboard")) {
    resetNavTo("leaderboard");
    await loadLeaderboardPage();
    return;
  }
  if (initialPage === "profile-stats") {
    await prepareRootPage("profile");
    resetNavTo("profile", { animate: false, skipPageLoad: true });
    navigateTo("profile-stats");
    return;
  }
  if (initialPage === "deal-chat" && chatListingId > 0) {
    resetNavTo("profile");
    await openDealChat(chatListingId, { chatId: chatThreadId || undefined });
    return;
  }
  if (initialPage === "coins") {
    await prepareRootPage("coins");
    resetNavTo("coins", { animate: false, skipPageLoad: true });
    return;
  }
  if (initialPage === "admin") {
    await adminRolePromise;
    if (stateAdmin.role) {
      resetNavTo("profile");
      navigateTo("admin");
      return;
    }
  }
  await loadMarket({ allowInactive: true }).catch((error) => {
    console.error("Failed to load market:", error);
  });
  resetNavTo("market", { skipPageLoad: true });
  // Hydrate avatar and equipped cosmetics after the stable initial Market paint.
  scheduleDeferredProfileHydration();
  } finally {
    endUiLoading(initLoadingToken);
    recordFrontendPerf("STARTUP init complete", initStartedAt, { page: String(state.page || "") });
  }
}

init().catch((error) => {
  console.error(error);
});
