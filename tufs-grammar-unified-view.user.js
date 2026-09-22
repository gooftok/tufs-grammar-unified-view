// ==UserScript==
// @name         TUFS 文法・1画面表示
// @namespace    local.tufs-unified-view
// @version      0.4.0
// @description  東外大言語モジュールの文法教材を、ページ構成に合わせて1画面で表示する
// @homepageURL  https://github.com/gooftok/tufs-grammar-unified-view
// @supportURL   https://github.com/gooftok/tufs-grammar-unified-view/issues
// @downloadURL  https://raw.githubusercontent.com/gooftok/tufs-grammar-unified-view/main/tufs-grammar-unified-view.user.js
// @updateURL    https://raw.githubusercontent.com/gooftok/tufs-grammar-unified-view/main/tufs-grammar-unified-view.user.js
// @match        https://www.coelang.tufs.ac.jp/mt/*/gmod/courses/*/lesson*/step*/*/*.html
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // @noframes が無視される環境でも、iframe 内で統合画面を再帰生成しない。
  if (window.top !== window.self) return;

  const DEBUG = false;

  /**
   * 2026-09-22 に文法一覧の22区分で確認した共通テンプレート。
   * 言語別の複製を作らず、本文候補とページ内リンクで教材ごとの差を扱う。
   */
  const SELECTORS = Object.freeze({
    container: "#container",
    siteHeader: "#container > header",
    breadcrumb: "#t_path4",
    content: "#content_box",
    pageTabs: "#gmodnav .gra_in_menu_container",
    stepTitle: "#content_box > h2.gra_in_title",
    stepTitleText: "#step_title",
    footer: "#footer",
    previousStep:
      "#gmodnav #gra_step_back a[href], #gmodnav [id^='gra_step_back'] a[href]",
    nextStep:
      "#gmodnav #gra_step_next a[href], #gmodnav [id^='gra_step_next'] a[href]",
    mainContent:
      "#content_box > .contents, #content_box > .gra_in_content, " +
      "#card_box, #explanation_box, #instances_box, #exercises_box",
    audioTrigger:
      "#instances_box .instance .voiceLinkBox " +
      "a[href^=\"javascript:playItem(\"], " +
      ".instance .voiceLinkBox a[href^=\"javascript:playItem(\"]",
    audioImageFallback:
      "#instances_box .instance .voiceLinkBox img[alt*='音声を再生'], " +
      ".instance .voiceLinkBox img[alt*='音声を再生']",
    audioDownloadImage: "img[alt*='ダウンロード']",
    audioDownloadAnchor: "a[href]",
    exampleContainer: ".instance, .gra_dl_box, tr, li",
    exampleText: ".instance_t, .instTxtBlk",
    exampleNumber: ".orgNo",
    exampleTranslation: ".translation",
    examplePronunciation: ".pron",
    explanationExample: "#content_box .instance",
    explanationVoiceBox: ".voiceLinkBox",
  });

  const PAGE_TYPES = Object.freeze({
    card: ["カード"],
    explanation: ["解説"],
    instances: ["例文"],
    exercises: ["練習問題"],
  });

  const PAGE_LABELS = Object.freeze({
    card: "カード",
    explanation: "解説",
    instances: "例文",
    exercises: "練習問題",
  });

  const PAGE_ORDER = Object.freeze([
    "card",
    "explanation",
    "instances",
    "exercises",
  ]);

  const STORAGE_PREFIX = "tufs-unified.collapsed.";
  const FRAME_TIMEOUT_MS = 20000;
  const MAX_BULK_DOWNLOAD_FILES = 100;
  const MAX_BULK_DOWNLOAD_BYTES = 128 * 1024 * 1024;
  const BULK_DOWNLOAD_CONCURRENCY = 3;

  const state = {
    pageUrls: {},
    unavailablePageTypes: new Set(),
    frames: new Map(),
    observers: new Map(),
    audioEntries: [],
    audioPageType: null,
    explanationAudioBindings: [],
    bulkDownloadController: null,
    bulkDownloadInProgress: false,
    previousStepUrl: null,
    nextStepUrl: null,
    lessonUrl: null,
    previousStepLabel: "前へ",
    nextStepLabel: "次へ",
    metadata: null,
    route: null,
    originalUrl: null,
    host: null,
    root: null,
    main: null,
    audioPanel: null,
    audioList: null,
    topNavigation: null,
    sections: new Map(),
    loadPromises: [],
    loadedUrls: new Set(),
    resizeHandler: null,
    unloadHandler: null,
    disposed: false,
  };

  void main();

  async function main() {
    try {
      const currentUrl = new URL(window.location.href);

      if (currentUrl.searchParams.get("unified") === "0") {
        return;
      }

      if (!isSupportedPage(currentUrl) || !hasSupportedStructure(document)) {
        debug("対応外のURLです", currentUrl.href);
        return;
      }

      state.route = parseCurrentRoute(currentUrl);
      state.originalUrl = canonicalizeUrl(currentUrl);
      state.metadata = extractStepMetadata(document);
      state.lessonUrl = state.metadata.lessonUrl;

      const discovered = discoverPageUrls(document, currentUrl);
      state.pageUrls = discovered.urls;
      state.unavailablePageTypes = discovered.unavailable;
      state.audioPageType = state.pageUrls.instances ? "instances"
        : state.pageUrls.explanation ? "explanation" : null;

      const navigation = extractStepNavigation(document);
      state.previousStepUrl = navigation.previousUrl;
      state.nextStepUrl = navigation.nextUrl;
      state.previousStepLabel = navigation.previousLabel || "前へ";
      state.nextStepLabel = navigation.nextLabel || "次へ";

      createUnifiedShell();

      for (const pageType of PAGE_ORDER) {
        createSection(pageType, state.pageUrls[pageType] || null);
      }

      installGlobalListeners();

      const results = await Promise.allSettled(state.loadPromises);
      debug("各セクションの初回読み込み結果", results);
    } catch (error) {
      console.error("[TUFS Unified] 統合表示の初期化に失敗しました", error);
    }
  }

  function isSupportedPage(url) {
    // 言語・方言コードを含む文法Stepだけを対象にし、別分野は変更しない。
    return (
      url instanceof URL &&
      url.origin === "https://www.coelang.tufs.ac.jp" &&
      parseCurrentRoute(url) !== null
    );
  }

  function hasSupportedStructure(sourceDocument) {
    // 未知のテンプレートでは元ページを保つ。URLだけでは表示を置換しない。
    return Boolean(sourceDocument.querySelector(SELECTORS.content) &&
      sourceDocument.querySelector(SELECTORS.pageTabs) &&
      sourceDocument.querySelector(SELECTORS.stepTitle));
  }

  function parseCurrentRoute(url) {
    const target = url instanceof URL ? url : new URL(url, window.location.href);
    const match = target.pathname.match(
      /^(\/mt\/([a-z]+(?:-[a-z]+)*)\/gmod\/courses\/([^/]+)\/(lesson[^/]+)\/(step[^/]+)\/)(card|explanation|instances|exercises)\/([^/]+\.html)$/,
    );

    if (!match) return null;

    return {
      stepRoot: match[1],
      language: match[2],
      course: match[3],
      lesson: match[4],
      step: match[5],
      pageType: match[6],
      fileName: match[7],
    };
  }

  function discoverPageUrls(sourceDocument, currentUrl) {
    const urls = {};
    const unavailable = new Set();
    const tabContainer = sourceDocument.querySelector(SELECTORS.pageTabs);
    const currentRoute = parseCurrentRoute(currentUrl);
    if (!currentRoute) return { urls, unavailable };

    if (tabContainer) {
      for (const item of tabContainer.children) {
        const label = normalizeNavigationLabel(item.textContent);
        const pageType = findPageTypeByLabel(label);
        const link = item.querySelector("a[href]");

        if (pageType && !link) {
          unavailable.add(pageType);
        }
      }
      // 文言やタグ名に依存せず、同じStepの実リンクから種別を取得する。
      for (const link of tabContainer.querySelectorAll("a[href]")) {
        const resolved = normalizePageUrl(link.href);
        const linkedRoute = resolved && parseCurrentRoute(resolved);
        if (linkedRoute?.stepRoot === currentRoute.stepRoot) {
          urls[linkedRoute.pageType] = resolved;
          unavailable.delete(linkedRoute.pageType);
        }
      }
    }

    // 表記違いで同じStepに複数の教材番号があっても、現在のページを優先する。
    urls[currentRoute.pageType] = normalizePageUrl(currentUrl);
    unavailable.delete(currentRoute.pageType);

    return { urls, unavailable };
  }

  function normalizeNavigationLabel(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(/[\s\u00a0]+/g, "")
      .trim();
  }

  function findPageTypeByLabel(label) {
    for (const [pageType, aliases] of Object.entries(PAGE_TYPES)) {
      if (
        aliases.some(
          (alias) => normalizeNavigationLabel(alias) === normalizeNavigationLabel(label),
        )
      ) {
        return pageType;
      }
    }
    return null;
  }

  function normalizePageUrl(value) {
    try {
      const url = value instanceof URL ? new URL(value.href) : new URL(value, location.href);
      if (url.origin !== location.origin) return null;
      url.searchParams.delete("unified");
      url.hash = "";
      return url.href;
    } catch (error) {
      debug("URLを正規化できませんでした", value, error);
      return null;
    }
  }

  function canonicalizeUrl(value) {
    const url = value instanceof URL ? new URL(value.href) : new URL(value, location.href);
    url.searchParams.delete("unified");
    return url.href;
  }

  function createUnifiedShell() {
    const host = document.createElement("div");
    host.id = "tufs-unified-host";
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = getUnifiedStyles();
    root.appendChild(style);

    const app = createElement("div", "tufs-unified-app");
    const top = createTopNavigation();
    const layout = createElement("div", "tufs-unified-layout");
    const main = createElement("main", "tufs-unified-main");
    main.id = "tufs-unified-main";

    const audioPanel = createElement("details", "tufs-audio-sidebar");
    audioPanel.open = true;
    const audioSummary = createElement("summary", "tufs-audio-summary", "音声");
    const audioList = createElement("div", "tufs-audio-list");
    audioList.setAttribute("aria-live", "polite");
    audioList.appendChild(
      createElement("p", "tufs-audio-message", state.audioPageType
        ? `${PAGE_LABELS[state.audioPageType]}の音声を読み込んでいます…`
        : "このStepには音声の取得元となるページがありません。"),
    );
    audioPanel.append(audioSummary, audioList);

    layout.append(main, audioPanel);
    app.append(top, layout);
    root.appendChild(app);

    state.host = host;
    state.root = root;
    state.main = main;
    state.audioPanel = audioPanel;
    state.audioList = audioList;

    document.documentElement.style.background = "#f3f4f6";
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.body.style.background = "#f3f4f6";
    document.body.replaceChildren(host);

    const pageTitle = [state.metadata.lessonName, state.metadata.stepName]
      .filter(Boolean)
      .join(" / ");
    if (pageTitle) {
      document.title = `${pageTitle} | TUFS統合表示`;
    }
  }

  function createTopNavigation() {
    const top = createElement("header", "tufs-unified-top");
    const titleBlock = createElement("div", "tufs-unified-title-block");
    const title = createElement(
      "h1",
      "tufs-unified-title",
      [state.metadata.lessonName, state.metadata.stepName].filter(Boolean).join(" / ") ||
        "TUFS 文法統合表示",
    );

    titleBlock.appendChild(title);

    const subtitle = [state.metadata.languageName, state.metadata.courseName]
      .filter(Boolean).join(" / ");
    if (subtitle) {
      titleBlock.appendChild(
        createElement("p", "tufs-unified-subtitle", subtitle),
      );
    }
    if (state.metadata.variants.length) {
      const variants = createElement("nav", "tufs-unified-actions");
      variants.setAttribute("aria-label", "教材の表記切り替え");
      for (const variant of state.metadata.variants) {
        variants.appendChild(createNavigationControl(
          variant.label, variant.url, "tufs-unified-button",
        ));
      }
      titleBlock.appendChild(variants);
    }

    const nav = createElement("nav", "tufs-unified-actions");
    nav.setAttribute("aria-label", "Stepナビゲーション");
    state.topNavigation = nav;
    updateTopNavigation();

    top.append(titleBlock, nav);
    return top;
  }

  function updateTopNavigation() {
    const nav = state.topNavigation;
    if (!nav) return;

    nav.replaceChildren();
    nav.appendChild(
      createNavigationControl(
        state.previousStepLabel,
        state.previousStepUrl,
        "tufs-unified-button",
      ),
    );

    nav.appendChild(
      createNavigationControl(
        "Lesson一覧へ戻る",
        state.lessonUrl,
        "tufs-unified-button",
      ),
    );

    const originalUrl = new URL(state.originalUrl);
    originalUrl.searchParams.set("unified", "0");
    nav.appendChild(
      createNavigationControl(
        "元のページを表示",
        originalUrl.href,
        "tufs-unified-button",
      ),
    );

    const reload = createElement(
      "button",
      "tufs-unified-button",
      "再読み込み",
    );
    reload.type = "button";
    reload.addEventListener("click", reloadAllFrames);
    nav.appendChild(reload);

    nav.appendChild(
      createNavigationControl(
        state.nextStepLabel,
        state.nextStepUrl,
        "tufs-unified-button",
      ),
    );
  }

  function createNavigationControl(label, url, className) {
    if (url) {
      const link = createElement("a", className, label);
      link.href = url;
      return link;
    }

    const button = createElement("button", className, label);
    button.type = "button";
    button.disabled = true;
    return button;
  }

  function createSection(pageType, url) {
    const label = PAGE_LABELS[pageType];
    const section = createElement("section", "tufs-section");
    section.dataset.pageType = pageType;

    const header = createElement("header", "tufs-section-header");
    const heading = createElement("h2", "tufs-section-title", label);
    const toggle = createElement("button", "tufs-section-toggle", "折りたたむ");
    toggle.type = "button";

    const body = createElement("div", "tufs-section-body");
    body.id = `tufs-section-body-${pageType}`;
    toggle.setAttribute("aria-controls", body.id);

    const collapsed = readCollapsedState(pageType);
    applyCollapsedState(pageType, body, toggle, collapsed);

    toggle.addEventListener("click", () => {
      const shouldCollapse = toggle.getAttribute("aria-expanded") === "true";
      applyCollapsedState(pageType, body, toggle, shouldCollapse);
      writeCollapsedState(pageType, shouldCollapse);

      if (!shouldCollapse) {
        const record = state.frames.get(pageType);
        record?.updateHeight?.();
      }
    });

    header.append(heading, toggle);
    section.append(header, body);
    state.main.appendChild(section);

    const sectionRecord = {
      pageType,
      label,
      url,
      section,
      body,
      toggle,
      status: null,
      iframe: null,
    };
    state.sections.set(pageType, sectionRecord);

    if (!url) {
      const message = state.unavailablePageTypes.has(pageType)
        ? `このStepには${label}がありません。`
        : `${label}のURLをページ内ナビゲーションから取得できませんでした。`;
      body.appendChild(createElement("p", "tufs-section-empty", message));

      state.loadPromises.push(
        Promise.resolve({ pageType, status: "unavailable" }),
      );
      return section;
    }

    if (state.loadedUrls.has(url)) {
      body.appendChild(
        createElement(
          "p",
          "tufs-section-empty",
          `${label}は別セクションと同じURLのため、重複読み込みを省略しました。`,
        ),
      );
      state.loadPromises.push(
        Promise.resolve({ pageType, status: "duplicate" }),
      );
      return section;
    }

    state.loadedUrls.add(url);

    const status = createElement(
      "div",
      "tufs-section-status",
      `${label}を読み込んでいます…`,
    );
    status.setAttribute("role", "status");
    body.setAttribute("aria-busy", "true");
    body.appendChild(status);
    sectionRecord.status = status;

    const { iframe, promise } = createIframe(pageType, url, sectionRecord);
    sectionRecord.iframe = iframe;
    body.appendChild(iframe);
    state.loadPromises.push(promise);
    return section;
  }

  function createIframe(pageType, url, sectionRecord) {
    const iframe = document.createElement("iframe");
    iframe.className = "tufs-section-frame";
    iframe.title = `${state.metadata.stepName || "現在のStep"} ${PAGE_LABELS[pageType]}`;
    iframe.hidden = true;
    iframe.setAttribute("loading", "eager");

    let initialSettled = false;
    let resolveInitial;
    let rejectInitial;

    const promise = new Promise((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });

    const record = {
      pageType,
      url,
      iframe,
      section: sectionRecord,
      timeoutId: null,
      loadHandler: null,
      errorHandler: null,
      updateHeight: null,
      settleSuccess() {
        if (initialSettled) return;
        initialSettled = true;
        resolveInitial({ pageType, status: "loaded" });
      },
      settleFailure(error) {
        if (initialSettled) return;
        initialSettled = true;
        rejectInitial(error);
      },
    };

    const onLoad = () => {
      if (iframe.src === "about:blank") return;

      clearFrameTimeout(record);
      try {
        handleFrameLoad(iframe, pageType);
        sectionRecord.status.hidden = true;
        sectionRecord.body.setAttribute("aria-busy", "false");
        iframe.hidden = false;
        sectionRecord.section.classList.remove("tufs-section-error");
        record.settleSuccess();
      } catch (error) {
        showSectionError(sectionRecord, error);
        record.settleFailure(error);
      }
    };

    const onError = () => {
      clearFrameTimeout(record);
      const error = new Error(`${PAGE_LABELS[pageType]}のiframe読み込みに失敗しました。`);
      showSectionError(sectionRecord, error);
      record.settleFailure(error);
    };

    record.loadHandler = onLoad;
    record.errorHandler = onError;
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);
    state.frames.set(pageType, record);

    startFrameTimeout(record);
    iframe.src = url;

    return { iframe, promise };
  }

  function handleFrameLoad(iframe, pageType) {
    disconnectFrameObservers(iframe);

    if (pageType === "explanation" || pageType === "instances") {
      clearExplanationAudioButtons();
    }

    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;

    if (!frameDocument || !frameWindow) {
      throw new Error("iframeの文書へアクセスできません。");
    }

    // 同じ本文構造でも、転送先が別教材なら現在のStepへ混在させない。
    const expected = new URL(state.pageUrls[pageType]);
    const actual = new URL(frameWindow.location.href);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      throw new Error("読み込み先が別の教材へ移動しました。元ページを開くか、再試行してください。");
    }

    if (!frameDocument.querySelector(SELECTORS.content)) {
      throw new Error("読み込んだページに文法本文が見つかりません。");
    }

    cleanFrameDocument(frameDocument, pageType);
    injectFrameStyles(frameDocument, pageType);

    const heightController = observeFrameHeight(iframe);
    const record = state.frames.get(pageType);
    if (record) record.updateHeight = heightController.update;

    const navigation = extractStepNavigation(frameDocument);
    let navigationChanged = false;

    if (!state.previousStepUrl && navigation.previousUrl) {
      state.previousStepUrl = navigation.previousUrl;
      state.previousStepLabel = navigation.previousLabel || state.previousStepLabel;
      navigationChanged = true;
    }

    if (!state.nextStepUrl && navigation.nextUrl) {
      state.nextStepUrl = navigation.nextUrl;
      state.nextStepLabel = navigation.nextLabel || state.nextStepLabel;
      navigationChanged = true;
    }

    if (navigationChanged) updateTopNavigation();

    if (pageType === state.audioPageType) {
      const entries = findAudioEntries(frameDocument);
      state.audioEntries = entries;
      createAudioSidebar(entries, iframe);
    }

    if (pageType === "explanation" || pageType === "instances") {
      decorateExplanationAudioButtons();
    }
  }

  function cleanFrameDocument(frameDocument, pageType) {
    frameDocument.documentElement.classList.add(
      "tufs-unified-frame-document",
      `tufs-unified-frame-${pageType}`,
    );

    // iframe内で意図せず親画面を置き換えないよう、既存のtargetだけを尊重する。
    for (const element of frameDocument.querySelectorAll("[autofocus]")) {
      element.removeAttribute("autofocus");
    }
  }

  function injectFrameStyles(frameDocument, pageType) {
    frameDocument.getElementById("tufs-unified-frame-style")?.remove();

    const style = frameDocument.createElement("style");
    style.id = "tufs-unified-frame-style";
    style.dataset.pageType = pageType;
    style.textContent = `
      html,
      body {
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: hidden !important;
        background: transparent !important;
      }

      body {
        margin: 0 !important;
        padding: 0 !important;
      }

      ${SELECTORS.container} {
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        background: transparent !important;
      }

      ${SELECTORS.siteHeader},
      ${SELECTORS.breadcrumb},
      #gmodnav,
      ${SELECTORS.footer},
      ${SELECTORS.stepTitle} {
        display: none !important;
      }

      ${SELECTORS.content} {
        box-sizing: border-box !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 8px 12px 16px !important;
        float: none !important;
        overflow: visible !important;
        background: transparent !important;
      }

      ${SELECTORS.mainContent},
      #content_box .contents,
      #content_box .gra_in_content {
        box-sizing: border-box !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        float: none !important;
      }

      #content_box img {
        max-width: 100%;
      }

      #instances_box .instance_t,
      #instances_box .instTxtBlk {
        line-height: 1.75 !important;
      }

      .tufs-unified-audio-proxied {
        display: none !important;
      }

      .tufs-unified-explanation-audio {
        appearance: none;
        display: inline-flex;
        min-height: 30px;
        align-items: center;
        justify-content: center;
        border: 1px solid #315f86;
        border-radius: 6px;
        padding: 4px 9px;
        color: #315f86;
        background: #fff;
        font: inherit;
        font-size: 0.82rem;
        line-height: 1.2;
        cursor: pointer;
      }

      .tufs-unified-explanation-audio:hover,
      .tufs-unified-explanation-audio-active {
        background: #e8f0f7;
      }

      .tufs-unified-explanation-audio:focus-visible {
        outline: 3px solid rgba(49, 95, 134, 0.35);
        outline-offset: 2px;
      }

      .tufs-unified-explanation-audio:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }
    `;
    frameDocument.head.appendChild(style);
  }

  function observeFrameHeight(iframe) {
    const frameDocument = iframe.contentDocument;
    const frameWindow = iframe.contentWindow;
    const content =
      frameDocument.querySelector(SELECTORS.content) || frameDocument.body;
    const cleanups = [];
    let frameRequest = 0;

    const measure = () => {
      frameRequest = 0;
      if (
        state.disposed ||
        !iframe.isConnected ||
        !frameDocument.body ||
        iframe.hidden
      ) {
        return;
      }

      const bodyRect = frameDocument.body.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const height = Math.ceil(
        Math.max(
          bodyRect.bottom,
          contentRect.bottom,
          frameDocument.body.scrollHeight,
          frameDocument.documentElement.scrollHeight,
        ),
      );
      const nextHeight = Math.max(80, height);
      const currentHeight = Number.parseFloat(iframe.style.height) || 0;

      if (Math.abs(currentHeight - nextHeight) > 1) {
        iframe.style.height = `${nextHeight}px`;
      }
    };

    const update = () => {
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(measure);
    };

    // iframe側のNodeと同じWindow由来のコンストラクタを使う。
    const ResizeObserverConstructor = frameWindow.ResizeObserver;
    if (typeof ResizeObserverConstructor === "function") {
      try {
        const resizeObserver = new ResizeObserverConstructor(update);
        resizeObserver.observe(frameDocument.documentElement);
        resizeObserver.observe(frameDocument.body);
        if (content !== frameDocument.body) resizeObserver.observe(content);
        cleanups.push(() => resizeObserver.disconnect());
      } catch (error) {
        debug("iframeのResizeObserverを開始できませんでした", error);
      }
    }

    // 操作による変化も段階的に再計測し、Observer非対応環境を補う。
    let interactionTimer = 0;
    let settledInteractionTimer = 0;
    const updateAfterInteraction = () => {
      frameWindow.clearTimeout(interactionTimer);
      frameWindow.clearTimeout(settledInteractionTimer);
      interactionTimer = frameWindow.setTimeout(update, 0);
      settledInteractionTimer = frameWindow.setTimeout(update, 250);
    };
    for (const eventName of [
      "click",
      "input",
      "change",
      "transitionend",
      "animationend",
    ]) {
      frameDocument.addEventListener(eventName, updateAfterInteraction, true);
      cleanups.push(() => {
        frameDocument.removeEventListener(
          eventName,
          updateAfterInteraction,
          true,
        );
      });
    }
    cleanups.push(() => {
      frameWindow.clearTimeout(interactionTimer);
      frameWindow.clearTimeout(settledInteractionTimer);
    });

    for (const image of content.querySelectorAll("img")) {
      if (image.complete) continue;
      image.addEventListener("load", update, { once: true });
      image.addEventListener("error", update, { once: true });
      cleanups.push(() => {
        image.removeEventListener("load", update);
        image.removeEventListener("error", update);
      });
    }

    cleanups.push(() => {
      if (frameRequest) cancelAnimationFrame(frameRequest);
    });
    state.observers.set(iframe, cleanups);

    update();
    return { update };
  }

  function findAudioEntries(frameDocument) {
    const triggers = [];
    const seen = new Set();

    for (const trigger of frameDocument.querySelectorAll(SELECTORS.audioTrigger)) {
      if (!seen.has(trigger)) {
        seen.add(trigger);
        triggers.push(trigger);
      }
    }

    if (triggers.length === 0) {
      for (const image of frameDocument.querySelectorAll(
        SELECTORS.audioImageFallback,
      )) {
        const trigger = image.closest("a, button, input") || image;
        if (!seen.has(trigger)) {
          seen.add(trigger);
          triggers.push(trigger);
        }
      }
    }

    return triggers
      .map((trigger, index) => extractAudioEntry(trigger, index))
      .filter(Boolean);
  }

  function extractAudioEntry(trigger, index) {
    const container =
      trigger.closest(SELECTORS.exampleContainer) || trigger.parentElement;
    if (!container) return null;

    // 原文・訳・発音表記が別要素の教材と、一つのspanにまとまる教材を扱う。
    const textElement = container.querySelector(".instance_t") ||
      container.querySelector(SELECTORS.exampleText);
    let rawText = normalizeDisplayText(textElement?.textContent);

    if (!rawText) {
      const clone = container.cloneNode(true);
      for (const unwanted of clone.querySelectorAll(
        ".voiceLinkBox, audio, button, input, img",
      )) {
        unwanted.remove();
      }
      rawText = normalizeDisplayText(clone.textContent);
    }

    if (!rawText) rawText = `例文${index + 1}`;

    const parsed = splitExampleText(rawText, index + 1);
    const translation = normalizeDisplayText(container.querySelector(SELECTORS.exampleTranslation)?.textContent);
    const pronunciation = normalizeDisplayText(container.querySelector(SELECTORS.examplePronunciation)?.textContent);
    const controlBox = trigger.closest(".voiceLinkBox");
    const downloadImage = controlBox?.querySelector(
      SELECTORS.audioDownloadImage,
    );
    const downloadTrigger =
      downloadImage?.closest(SELECTORS.audioDownloadAnchor) || null;
    const downloadUrl = downloadTrigger
      ? normalizePageUrl(downloadTrigger.href)
      : null;

    return {
      index,
      number: normalizeDisplayText(container.querySelector(SELECTORS.exampleNumber)?.textContent) || parsed.number,
      sourceText: rawText,
      matchKey: exampleMatchKey(container),
      primaryText: translation ? rawText : parsed.primaryText,
      translation: translation || parsed.translation,
      pronunciation,
      trigger,
      controlBox,
      downloadUrl,
      hasDownloadControl: Boolean(downloadImage),
      ready: isAudioProxyReady(trigger),
    };
  }

  function exampleMatchKey(container) {
    // 原文だけの一致で、訳・発音表記が異なる用例を結び付けない。
    const text = container.querySelector(".instTxtBlk") ||
      container.querySelector(SELECTORS.exampleText);
    return normalizeExampleMatchText(text?.textContent);
  }

  function splitExampleText(text, fallbackNumber) {
    const normalized = normalizeDisplayText(text);
    const match = normalized.match(
      /^(\(\s*\d+\s*\)|（\s*\d+\s*）)?\s*(.*?)(?:[（(]([^（）()]*)[）)])\s*$/,
    );

    if (match && match[2] && match[3]) {
      return {
        number: normalizeDisplayText(match[1]) || `(${fallbackNumber})`,
        primaryText: normalizeDisplayText(match[2]),
        translation: normalizeDisplayText(match[3]),
      };
    }

    const numbered = normalized.match(/^(\(\s*\d+\s*\)|（\s*\d+\s*）)\s*(.*)$/);
    return {
      number: numbered ? normalizeDisplayText(numbered[1]) : `(${fallbackNumber})`,
      primaryText: numbered ? normalizeDisplayText(numbered[2]) : normalized,
      translation: "",
    };
  }

  function createAudioSidebar(entries, iframe) {
    if (!state.audioList) return;

    cancelBulkDownload();
    state.audioList.replaceChildren();

    if (entries.length === 0) {
      setAudioMessage(`この${PAGE_LABELS[state.audioPageType]}ページから再生項目を取得できませんでした。`);
      return;
    }

    state.audioList.appendChild(createBulkDownloadToolbar(entries));

    const readyEntries = [];
    for (const entry of entries) {
      const item = createElement("div", "tufs-audio-entry");
      const button = createElement("button", "tufs-audio-item");
      button.type = "button";
      button.disabled = !entry.ready;

      const labelText = [entry.number, entry.primaryText].filter(Boolean).join(" ");
      button.setAttribute(
        "aria-label",
        entry.ready
          ? `${labelText} の音声を再生`
          : `${labelText} の音声はサイドバーから再生できません`,
      );

      const play = createElement("span", "tufs-audio-play", "▶");
      play.setAttribute("aria-hidden", "true");
      const text = createElement("span", "tufs-audio-text");
      const primary = createElement(
        "span",
        "tufs-audio-primary",
      );
      primary.append(`${entry.number} `);
      // 番号中の英字が、右から左に読む原文の方向判定へ混ざらないよう分離する。
      const originalText = createElement("bdi", "", entry.primaryText);
      originalText.dir = "auto";
      primary.appendChild(originalText);
      text.appendChild(primary);

      if (entry.translation) {
        text.appendChild(
          createElement("span", "tufs-audio-translation", entry.translation),
        );
      }
      if (entry.pronunciation) {
        const pronunciation = createElement("span", "tufs-audio-translation", entry.pronunciation);
        pronunciation.dir = "auto";
        text.appendChild(pronunciation);
      }

      button.append(play, text);

      if (entry.ready) {
        readyEntries.push(entry);
        button.addEventListener("click", () => {
          try {
            proxyAudioClick(entry.trigger, iframe);
            for (const item of state.audioList.querySelectorAll(
              ".tufs-audio-item",
            )) {
              item.classList.remove("tufs-audio-item-selected");
              item.removeAttribute("aria-current");
            }
            button.classList.add("tufs-audio-item-selected");
            button.setAttribute("aria-current", "true");
          } catch (error) {
            (entry.controlBox || entry.trigger).classList.remove(
              "tufs-unified-audio-proxied",
            );
            button.disabled = true;
            console.error("[TUFS Unified] 音声の代理再生に失敗しました", error);
          }
        });
      }

      item.appendChild(button);

      if (entry.downloadUrl) {
        const download = createElement("a", "tufs-audio-download", "DL");
        download.href = entry.downloadUrl;
        download.download = "";
        download.setAttribute(
          "aria-label",
          `${labelText} の音声をダウンロード`,
        );
        item.appendChild(download);
      }

      state.audioList.appendChild(item);
    }

    const movableEntries = readyEntries.filter(
      (entry) => !entry.hasDownloadControl || Boolean(entry.downloadUrl),
    );

    if (movableEntries.length > 0) {
      hideOriginalAudioControls(iframe.contentDocument, movableEntries);
    }

    if (movableEntries.length !== entries.length) {
      state.audioList.appendChild(
        createElement(
          "p",
          "tufs-audio-note",
          "右側へ移せない操作がある項目は、本文の元ボタンを残しています。",
        ),
      );
    }
  }

  function createBulkDownloadToolbar(entries) {
    const toolbar = createElement("div", "tufs-audio-bulk");
    const candidates = collectBulkDownloadCandidates(entries);
    const button = createElement(
      "button",
      "tufs-unified-button tufs-audio-bulk-button",
      `一括DL（${candidates.length}件）`,
    );
    button.type = "button";

    const status = createElement("p", "tufs-audio-bulk-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    if (candidates.length === 0) {
      button.disabled = true;
      status.textContent = "一括取得できるMP3がありません。";
    } else if (candidates.length > MAX_BULK_DOWNLOAD_FILES) {
      button.disabled = true;
      status.textContent = `一括DLは${MAX_BULK_DOWNLOAD_FILES}件までです。`;
    } else {
      button.addEventListener("click", () => {
        void downloadBulkAudio(candidates, button, status);
      });
    }

    toolbar.append(button, status);
    return toolbar;
  }

  function collectBulkDownloadCandidates(entries) {
    const candidates = [];
    const seenUrls = new Set();
    const usedNames = new Set();

    for (const entry of entries) {
      if (!entry.downloadUrl) continue;

      try {
        const url = new URL(entry.downloadUrl, location.href);
        if (url.origin !== location.origin || !/\.mp3$/i.test(url.pathname)) {
          continue;
        }

        url.hash = "";
        if (seenUrls.has(url.href)) continue;
        seenUrls.add(url.href);

        let sourceName = url.pathname.split("/").pop() || "";
        try {
          sourceName = decodeURIComponent(sourceName);
        } catch (error) {
          debug("音声ファイル名をデコードできませんでした", sourceName, error);
        }

        const prefix = String(candidates.length + 1).padStart(2, "0");
        let fileName = `${prefix}_${sanitizeDownloadFileName(sourceName)}`;
        let suffix = 2;
        while (usedNames.has(fileName.toLocaleLowerCase())) {
          fileName = `${prefix}_${suffix}_${sanitizeDownloadFileName(sourceName)}`;
          suffix += 1;
        }
        usedNames.add(fileName.toLocaleLowerCase());

        candidates.push({
          url: url.href,
          fileName,
        });
      } catch (error) {
        debug("一括DL対象のURLを利用できませんでした", entry.downloadUrl, error);
      }
    }

    return candidates;
  }

  function sanitizeDownloadFileName(value) {
    let fileName = normalizeDisplayText(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, 100);

    if (!fileName) fileName = "audio.mp3";
    if (!/\.mp3$/i.test(fileName)) fileName += ".mp3";
    return fileName;
  }

  async function downloadBulkAudio(candidates, button, status) {
    if (state.bulkDownloadInProgress) return;

    const controller = new AbortController();
    state.bulkDownloadController = controller;
    state.bulkDownloadInProgress = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = `音声を取得しています（0/${candidates.length}）…`;

    try {
      const files = await fetchBulkAudioFiles(
        candidates,
        controller.signal,
        (completed) => {
          if (status.isConnected) {
            status.textContent =
              `音声を取得しています（${completed}/${candidates.length}）…`;
          }
        },
      );

      if (controller.signal.aborted) {
        throw new DOMException("一括DLを中止しました。", "AbortError");
      }

      status.textContent = "ZIPを作成しています…";
      const zipBlob = buildStoredZip(files);
      const objectUrl = URL.createObjectURL(zipBlob);
      const download = document.createElement("a");
      download.href = objectUrl;
      download.download = createBulkZipFileName();
      download.hidden = true;
      document.body.appendChild(download);
      download.click();
      download.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      status.textContent = `${files.length}件のZIPを保存しました。`;
    } catch (error) {
      controller.abort();
      if (status.isConnected) {
        status.textContent =
          error?.name === "AbortError"
            ? "一括DLを中止しました。"
            : "一括DLに失敗しました。個別DLを利用してください。";
      }
      if (error?.name !== "AbortError") {
        console.error("[TUFS Unified] 音声の一括DLに失敗しました", error);
      }
    } finally {
      if (state.bulkDownloadController === controller) {
        state.bulkDownloadController = null;
        state.bulkDownloadInProgress = false;
      }
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function fetchBulkAudioFiles(candidates, signal, onProgress) {
    const files = new Array(candidates.length);
    let nextIndex = 0;
    let completed = 0;
    let totalBytes = 0;

    const worker = async () => {
      while (!signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= candidates.length) return;

        const candidate = candidates[index];
        const response = await fetch(candidate.url, {
          credentials: "same-origin",
          redirect: "follow",
          signal,
        });

        if (
          !response.ok ||
          !response.url ||
          new URL(response.url).origin !== location.origin
        ) {
          throw new Error(`音声${index + 1}を取得できませんでした。`);
        }

        const declaredLength = Number.parseInt(
          response.headers.get("content-length") || "",
          10,
        );
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_BULK_DOWNLOAD_BYTES
        ) {
          throw new Error("一括DLの合計サイズが上限を超えました。");
        }

        const data = await readBulkResponseData(response, (chunkBytes) => {
          totalBytes += chunkBytes;
          if (totalBytes > MAX_BULK_DOWNLOAD_BYTES) {
            throw new Error("一括DLの合計サイズが上限を超えました。");
          }
        });
        if (data.byteLength === 0) {
          throw new Error(`音声${index + 1}のデータが空です。`);
        }

        files[index] = {
          fileName: candidate.fileName,
          data,
        };
        completed += 1;
        onProgress(completed);
      }
    };

    const workerCount = Math.min(BULK_DOWNLOAD_CONCURRENCY, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );
    return files;
  }

  async function readBulkResponseData(response, addChunkBytes) {
    if (!response.body?.getReader) {
      const data = new Uint8Array(await response.arrayBuffer());
      addChunkBytes(data.byteLength);
      return data;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        addChunkBytes(value.byteLength);
        chunks.push(value);
        byteLength += value.byteLength;
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch (cancelError) {
        debug("音声レスポンスの中止処理に失敗しました", cancelError);
      }
      throw error;
    }

    const data = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  }

  function buildStoredZip(files) {
    const encoder = new TextEncoder();
    const crcTable = createCrc32Table();
    const localParts = [];
    const centralParts = [];
    const stamp = createDosDateTime(new Date());
    let localOffset = 0;
    let centralSize = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.fileName);
      const checksum = calculateCrc32(file.data, crcTable);
      const localHeader = new Uint8Array(30);
      const localView = new DataView(localHeader.buffer);

      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, stamp.time, true);
      localView.setUint16(12, stamp.date, true);
      localView.setUint32(14, checksum, true);
      localView.setUint32(18, file.data.byteLength, true);
      localView.setUint32(22, file.data.byteLength, true);
      localView.setUint16(26, nameBytes.byteLength, true);
      localView.setUint16(28, 0, true);
      localParts.push(localHeader, nameBytes, file.data);

      const centralHeader = new Uint8Array(46);
      const centralView = new DataView(centralHeader.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, stamp.time, true);
      centralView.setUint16(14, stamp.date, true);
      centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, file.data.byteLength, true);
      centralView.setUint32(24, file.data.byteLength, true);
      centralView.setUint16(28, nameBytes.byteLength, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, localOffset, true);
      centralParts.push(centralHeader, nameBytes);

      localOffset +=
        localHeader.byteLength + nameBytes.byteLength + file.data.byteLength;
      centralSize += centralHeader.byteLength + nameBytes.byteLength;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    endView.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, end], {
      type: "application/zip",
    });
  }

  function createCrc32Table() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value >>> 0;
    }
    return table;
  }

  function calculateCrc32(data, table) {
    let checksum = 0xffffffff;
    for (const byte of data) {
      checksum = table[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
    }
    return (checksum ^ 0xffffffff) >>> 0;
  }

  function createDosDateTime(value) {
    const year = Math.min(2107, Math.max(1980, value.getFullYear()));
    return {
      time:
        (value.getHours() << 11) |
        (value.getMinutes() << 5) |
        Math.floor(value.getSeconds() / 2),
      date:
        ((year - 1980) << 9) |
        ((value.getMonth() + 1) << 5) |
        value.getDate(),
    };
  }

  function createBulkZipFileName() {
    const language =
      new URL(state.originalUrl).pathname.match(/^\/mt\/([^/]+)\//)?.[1] ||
      "language";
    const routeParts = [
      "TUFS",
      language,
      state.route?.course,
      state.route?.lesson,
      state.route?.step,
      "audio",
    ];
    return (
      routeParts
        .filter(Boolean)
        .join("_")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") + ".zip"
    );
  }

  function cancelBulkDownload() {
    state.bulkDownloadController?.abort();
    state.bulkDownloadController = null;
    state.bulkDownloadInProgress = false;
  }

  function proxyAudioClick(originalTrigger, iframe) {
    if (
      !iframe.contentDocument ||
      originalTrigger.ownerDocument !== iframe.contentDocument ||
      !originalTrigger.isConnected
    ) {
      throw new Error("元の音声ボタンが利用できません。");
    }

    if (typeof originalTrigger.click === "function") {
      originalTrigger.click();
      return;
    }

    originalTrigger.dispatchEvent(
      new iframe.contentWindow.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: iframe.contentWindow,
      }),
    );
  }

  function hideOriginalAudioControls(frameDocument, entries) {
    if (!frameDocument || entries.length === 0) return;
    for (const entry of entries) {
      (entry.controlBox || entry.trigger).classList.add(
        "tufs-unified-audio-proxied",
      );
    }
  }

  function isAudioProxyReady(trigger) {
    const href = trigger.getAttribute?.("href") || "";

    if (/^\s*javascript\s*:\s*playItem\s*\(/i.test(href)) {
      return typeof trigger.ownerDocument.defaultView?.playItem === "function";
    }

    return (
      typeof trigger.click === "function" ||
      typeof trigger.onclick === "function" ||
      trigger.hasAttribute?.("onclick")
    );
  }

  function decorateExplanationAudioButtons() {
    clearExplanationAudioButtons();
    if (state.audioPageType !== "instances") return;

    const explanationRecord = state.frames.get("explanation");
    const instancesRecord = state.frames.get("instances");
    const explanationDocument = explanationRecord?.iframe.contentDocument;
    const instancesDocument = instancesRecord?.iframe.contentDocument;

    if (
      !explanationDocument ||
      !instancesDocument ||
      state.audioEntries.length === 0
    ) {
      return;
    }

    const explanationExamples = [
      ...explanationDocument.querySelectorAll(SELECTORS.explanationExample),
    ];
    if (explanationExamples.length === 0) return;

    const explanationKeyCounts = new Map();
    for (const example of explanationExamples) {
      const key = exampleMatchKey(example);
      if (!key) continue;
      explanationKeyCounts.set(key, (explanationKeyCounts.get(key) || 0) + 1);
    }

    const entriesByKey = new Map();
    for (const entry of state.audioEntries) {
      if (!entry.ready || !entry.matchKey) continue;
      const matching = entriesByKey.get(entry.matchKey) || [];
      matching.push(entry);
      entriesByKey.set(entry.matchKey, matching);
    }

    let added = 0;
    for (const example of explanationExamples) {
      const voiceBox = example.querySelector(SELECTORS.explanationVoiceBox);
      const key = exampleMatchKey(example);
      const matchingEntries = entriesByKey.get(key) || [];

      // 順番で補完しない。両ページで一意な完全一致の場合だけ関連付ける。
      if (
        !key ||
        explanationKeyCounts.get(key) !== 1 ||
        matchingEntries.length !== 1 ||
        !voiceBox ||
        voiceBox.children.length !== 0 ||
        normalizeDisplayText(voiceBox.textContent)
      ) {
        continue;
      }

      const entry = matchingEntries[0];
      const button = explanationDocument.createElement("button");
      button.type = "button";
      button.className = "tufs-unified-explanation-audio";
      button.textContent = "▶ 再生";
      button.setAttribute(
        "aria-label",
        `解説内の ${[entry.number, entry.primaryText]
          .filter(Boolean)
          .join(" ")} の音声を再生`,
      );

      const clickHandler = () => {
        try {
          proxyAudioClick(entry.trigger, instancesRecord.iframe);
          for (const current of explanationDocument.querySelectorAll(
            ".tufs-unified-explanation-audio-active",
          )) {
            current.classList.remove("tufs-unified-explanation-audio-active");
            current.removeAttribute("aria-current");
          }
          button.classList.add("tufs-unified-explanation-audio-active");
          button.setAttribute("aria-current", "true");
        } catch (error) {
          button.disabled = true;
          button.textContent = "再生不可";
          (entry.controlBox || entry.trigger).classList.remove(
            "tufs-unified-audio-proxied",
          );
          console.error(
            "[TUFS Unified] 解説内からの音声再生に失敗しました",
            error,
          );
        }
      };

      button.addEventListener("click", clickHandler);
      voiceBox.appendChild(button);
      state.explanationAudioBindings.push({ button, clickHandler });
      added += 1;
    }

    if (added > 0) {
      explanationRecord.updateHeight?.();
    }
  }

  function clearExplanationAudioButtons() {
    for (const { button, clickHandler } of state.explanationAudioBindings) {
      button.removeEventListener("click", clickHandler);
      button.remove();
    }
    state.explanationAudioBindings = [];

    const explanationDocument =
      state.frames.get("explanation")?.iframe.contentDocument;
    for (const button of explanationDocument?.querySelectorAll(
      ".tufs-unified-explanation-audio",
    ) || []) {
      button.remove();
    }
  }

  function extractStepMetadata(sourceDocument) {
    const breadcrumb = sourceDocument.querySelector(SELECTORS.breadcrumb);
    const breadcrumbLinks = breadcrumb
      ? [...breadcrumb.querySelectorAll("a[href]")]
      : [];
    const moduleRoot = `/mt/${state.route.language}/gmod/`;
    const courseRoot = `${moduleRoot}courses/${state.route.course}/`;
    const lessonLink = breadcrumbLinks.find((link) =>
      new URL(link.href).pathname.replace(/index\.html$/, "").replace(/\/?$/, "/") ===
        `${courseRoot}${state.route.lesson}/`,
    );
    const languageLink = breadcrumbLinks.find((link) =>
      new URL(link.href).pathname.replace(/\/?$/, "/") === `/mt/${state.route.language}/`,
    );
    const courseLink = breadcrumbLinks.find((link) =>
      /\/courses\/[^/]+\/?$/.test(new URL(link.href, location.href).pathname),
    );

    const titleElement = sourceDocument.querySelector(SELECTORS.stepTitle);
    const variants = [...(titleElement?.querySelectorAll("a[href]") || [])]
      .map((link) => ({ label: normalizeDisplayText(link.textContent), url: normalizePageUrl(link.href) }))
      .filter(({ label, url }) => {
        const route = url && parseCurrentRoute(url);
        return label && route?.stepRoot === state.route.stepRoot &&
          route.pageType === state.route.pageType && url !== state.originalUrl;
      });
    let stepName = "";
    if (titleElement) {
      const clone = titleElement.cloneNode(true);
      clone.querySelector("#komtype")?.remove();
      stepName = normalizeDisplayText(clone.textContent);
    }

    return {
      variants,
      languageName: normalizeDisplayText(languageLink?.textContent) || state.route.language,
      lessonName:
        normalizeDisplayText(lessonLink?.textContent) ||
        state.route?.lesson ||
        "Lesson",
      stepName:
        stepName ||
        `${state.route?.step || "Step"} ${normalizeDisplayText(
          sourceDocument.querySelector(SELECTORS.stepTitleText)?.textContent,
        )}`.trim(),
      courseName: normalizeDisplayText(courseLink?.textContent),
      lessonUrl: lessonLink ? normalizePageUrl(lessonLink.href) : null,
    };
  }

  function extractStepNavigation(sourceDocument) {
    const previous = sourceDocument.querySelector(SELECTORS.previousStep);
    const next = sourceDocument.querySelector(SELECTORS.nextStep);

    return {
      previousUrl: previous ? normalizePageUrl(previous.href) : null,
      nextUrl: next ? normalizePageUrl(next.href) : null,
      previousLabel: previous
        ? normalizeDisplayText(previous.textContent) || "前へ"
        : null,
      nextLabel: next ? normalizeDisplayText(next.textContent) || "次へ" : null,
    };
  }

  function showSectionError(sectionRecord, error) {
    const { label, url, status, iframe, body, section } = sectionRecord;
    console.error(`[TUFS Unified] ${label}を読み込めませんでした`, error);

    if (
      sectionRecord.pageType === "explanation" ||
      sectionRecord.pageType === "instances"
    ) {
      clearExplanationAudioButtons();
    }
    if (sectionRecord.pageType === state.audioPageType) {
      cancelBulkDownload();
      state.audioEntries = [];
      setAudioMessage("音声を読み込めませんでした。");
    }

    body.setAttribute("aria-busy", "false");
    section.classList.add("tufs-section-error");
    if (iframe) iframe.hidden = true;

    status.hidden = false;
    status.className = "tufs-section-status tufs-section-status-error";
    status.replaceChildren();
    status.appendChild(
      createElement("p", "", `${label}を読み込めませんでした。`),
    );

    const actions = createElement("div", "tufs-section-error-actions");
    const original = createElement("a", "tufs-unified-button", "元ページを開く");
    original.href = url;
    original.target = "_blank";
    original.rel = "noopener noreferrer";

    const retry = createElement("button", "tufs-unified-button", "再試行");
    retry.type = "button";
    retry.addEventListener("click", () => {
      const frameRecord = state.frames.get(sectionRecord.pageType);
      if (frameRecord) reloadFrame(frameRecord);
    });
    actions.append(original, retry);
    status.appendChild(actions);
  }

  function reloadAllFrames() {
    for (const record of state.frames.values()) {
      reloadFrame(record);
    }
  }

  function reloadFrame(record) {
    const { iframe, section, pageType } = record;
    disconnectFrameObservers(iframe);
    clearFrameTimeout(record);

    if (pageType === "explanation" || pageType === "instances") {
      clearExplanationAudioButtons();
    }

    section.status.className = "tufs-section-status";
    section.status.textContent = `${section.label}を読み込んでいます…`;
    section.status.hidden = false;
    section.body.setAttribute("aria-busy", "true");
    section.section.classList.remove("tufs-section-error");
    iframe.hidden = true;

    if (pageType === state.audioPageType) {
      cancelBulkDownload();
      state.audioEntries = [];
      setAudioMessage(`${PAGE_LABELS[pageType]}の音声を読み込んでいます…`);
    }

    startFrameTimeout(record);
    // 転送先や本文内リンクの移動先ではなく、要求した教材を読み直す。
    iframe.src = record.url;
  }

  function startFrameTimeout(record) {
    clearFrameTimeout(record);
    record.timeoutId = window.setTimeout(() => {
      const error = new Error(
        `${PAGE_LABELS[record.pageType]}の読み込みが時間内に完了しませんでした。`,
      );
      showSectionError(record.section, error);
      record.settleFailure(error);
    }, FRAME_TIMEOUT_MS);
  }

  function clearFrameTimeout(record) {
    if (!record.timeoutId) return;
    clearTimeout(record.timeoutId);
    record.timeoutId = null;
  }

  function installGlobalListeners() {
    state.resizeHandler = () => {
      for (const record of state.frames.values()) {
        record.updateHeight?.();
      }
    };
    state.unloadHandler = dispose;

    window.addEventListener("resize", state.resizeHandler, { passive: true });
    window.addEventListener("beforeunload", state.unloadHandler, { once: true });
  }

  function disconnectFrameObservers(iframe) {
    const cleanups = state.observers.get(iframe);
    if (!cleanups) return;

    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        debug("Observerの解除に失敗しました", error);
      }
    }
    state.observers.delete(iframe);
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;

    cancelBulkDownload();
    clearExplanationAudioButtons();

    if (state.resizeHandler) {
      window.removeEventListener("resize", state.resizeHandler);
    }

    for (const record of state.frames.values()) {
      clearFrameTimeout(record);
      disconnectFrameObservers(record.iframe);
      record.iframe.removeEventListener("load", record.loadHandler);
      record.iframe.removeEventListener("error", record.errorHandler);
    }

    state.frames.clear();
    state.sections.clear();
    state.audioEntries = [];
  }

  function readCollapsedState(pageType) {
    try {
      const value = localStorage.getItem(`${STORAGE_PREFIX}${state.route.language}.${pageType}`);
      // 旧版の韓国語設定だけは引き継ぎ、他言語へは波及させない。
      return (value ?? (state.route.language === "ko"
        ? localStorage.getItem(`${STORAGE_PREFIX}${pageType}`) : null)) === "true";
    } catch (error) {
      debug("折りたたみ状態を読み取れませんでした", error);
      return false;
    }
  }

  function writeCollapsedState(pageType, collapsed) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${state.route.language}.${pageType}`, String(collapsed));
    } catch (error) {
      debug("折りたたみ状態を保存できませんでした", error);
    }
  }

  function applyCollapsedState(pageType, body, toggle, collapsed) {
    body.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.textContent = collapsed ? "展開する" : "折りたたむ";
    toggle.setAttribute(
      "aria-label",
      `${PAGE_LABELS[pageType]}を${collapsed ? "展開する" : "折りたたむ"}`,
    );
  }

  function setAudioMessage(message) {
    if (!state.audioList) return;
    state.audioList.replaceChildren(
      createElement("p", "tufs-audio-message", message),
    );
  }

  function normalizeDisplayText(value) {
    return String(value || "")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
  }

  function normalizeExampleMatchText(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
  }

  function createElement(tagName, className = "", text = "") {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function debug(...args) {
    if (DEBUG) {
      console.debug("[TUFS Unified]", ...args);
    }
  }

  function getUnifiedStyles() {
    return `
      :host {
        --tufs-bg: #f3f4f6;
        --tufs-panel: #ffffff;
        --tufs-border: #d7dce2;
        --tufs-text: #20242a;
        --tufs-muted: #667085;
        --tufs-accent: #315f86;
        --tufs-accent-soft: #e8f0f7;
        --tufs-error: #9f2d32;
        display: block;
        min-height: 100vh;
        color: var(--tufs-text);
        background: var(--tufs-bg);
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP",
          "Yu Gothic UI", "Yu Gothic", sans-serif;
        line-height: 1.6;
      }

      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }

      .tufs-unified-app {
        min-height: 100vh;
      }

      .tufs-unified-top {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 20px;
        max-width: 1500px;
        margin: 0 auto;
        padding: 18px 16px 4px;
      }

      .tufs-unified-title-block {
        min-width: 0;
      }

      .tufs-unified-title {
        margin: 0;
        font-size: clamp(1.2rem, 2vw, 1.65rem);
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .tufs-unified-subtitle {
        margin: 4px 0 0;
        color: var(--tufs-muted);
        font-size: 0.9rem;
      }

      .tufs-unified-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .tufs-unified-button,
      .tufs-section-toggle {
        appearance: none;
        display: inline-flex;
        min-height: 38px;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--tufs-border);
        border-radius: 6px;
        padding: 7px 12px;
        color: var(--tufs-text);
        background: var(--tufs-panel);
        font: inherit;
        font-size: 0.88rem;
        line-height: 1.2;
        text-decoration: none;
        cursor: pointer;
      }

      .tufs-unified-button:hover:not(:disabled),
      .tufs-section-toggle:hover,
      .tufs-audio-item:hover:not(:disabled) {
        border-color: var(--tufs-accent);
        background: var(--tufs-accent-soft);
      }

      .tufs-unified-button:focus-visible,
      .tufs-section-toggle:focus-visible,
      .tufs-audio-item:focus-visible,
      .tufs-audio-download:focus-visible,
      .tufs-audio-summary:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--tufs-accent) 45%, transparent);
        outline-offset: 2px;
      }

      .tufs-unified-button:disabled {
        color: var(--tufs-muted);
        background: #eef0f2;
        cursor: not-allowed;
        opacity: 0.7;
      }

      .tufs-unified-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
        gap: 20px;
        max-width: 1500px;
        margin: 0 auto;
        padding: 16px;
      }

      .tufs-unified-main {
        display: grid;
        min-width: 0;
        gap: 16px;
      }

      .tufs-section {
        min-width: 0;
        overflow: clip;
        border: 1px solid var(--tufs-border);
        border-radius: 8px;
        background: var(--tufs-panel);
      }

      .tufs-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 55px;
        border-bottom: 1px solid var(--tufs-border);
        padding: 8px 14px;
      }

      .tufs-section-title {
        margin: 0;
        font-size: 1.13rem;
      }

      .tufs-section-toggle {
        min-height: 34px;
        flex: 0 0 auto;
        padding: 5px 10px;
      }

      .tufs-section-body[hidden] {
        display: none;
      }

      .tufs-section-status,
      .tufs-section-empty {
        margin: 0;
        padding: 22px 16px;
        color: var(--tufs-muted);
      }

      .tufs-section-status[hidden] {
        display: none;
      }

      .tufs-section-status-error {
        color: var(--tufs-error);
      }

      .tufs-section-status-error p {
        margin: 0 0 12px;
      }

      .tufs-section-error-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tufs-section-frame {
        display: block;
        width: 100%;
        min-height: 80px;
        border: 0;
        background: transparent;
      }

      .tufs-section-frame[hidden] {
        display: none;
      }

      .tufs-audio-sidebar {
        position: sticky;
        top: 16px;
        align-self: start;
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        border: 1px solid var(--tufs-border);
        border-radius: 8px;
        background: var(--tufs-panel);
      }

      .tufs-audio-summary {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 14px 16px;
        border-bottom: 1px solid var(--tufs-border);
        background: var(--tufs-panel);
        font-size: 1.08rem;
        font-weight: 700;
        cursor: pointer;
      }

      .tufs-audio-list {
        display: grid;
        gap: 8px;
        padding: 12px;
      }

      .tufs-audio-bulk {
        display: grid;
        gap: 5px;
        border-bottom: 1px solid var(--tufs-border);
        margin-bottom: 4px;
        padding-bottom: 12px;
      }

      .tufs-audio-bulk-button {
        width: 100%;
        border-color: var(--tufs-accent);
        color: var(--tufs-accent);
        font-weight: 700;
      }

      .tufs-audio-bulk-status {
        min-height: 1.4em;
        margin: 0;
        color: var(--tufs-muted);
        font-size: 0.8rem;
        line-height: 1.4;
      }

      .tufs-audio-entry {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px;
        align-items: stretch;
      }

      .tufs-audio-item {
        appearance: none;
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 8px;
        width: 100%;
        min-height: 54px;
        align-items: start;
        border: 1px solid var(--tufs-border);
        border-radius: 7px;
        padding: 10px;
        color: var(--tufs-text);
        background: var(--tufs-panel);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .tufs-audio-download {
        display: inline-flex;
        min-width: 48px;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--tufs-border);
        border-radius: 7px;
        padding: 8px;
        color: var(--tufs-accent);
        background: var(--tufs-panel);
        font-size: 0.82rem;
        font-weight: 700;
        text-decoration: none;
      }

      .tufs-audio-item:disabled {
        cursor: not-allowed;
        opacity: 0.65;
      }

      .tufs-audio-item-selected {
        border-color: var(--tufs-accent);
        background: var(--tufs-accent-soft);
      }

      .tufs-audio-download:hover {
        border-color: var(--tufs-accent);
        background: var(--tufs-accent-soft);
      }

      .tufs-audio-play {
        color: var(--tufs-accent);
        font-size: 0.9rem;
        line-height: 1.75;
      }

      .tufs-audio-text {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .tufs-audio-primary {
        line-height: 1.75;
        overflow-wrap: anywhere;
      }

      .tufs-audio-translation {
        color: var(--tufs-muted);
        font-size: 0.88rem;
        line-height: 1.6;
        overflow-wrap: anywhere;
      }

      .tufs-audio-message,
      .tufs-audio-note {
        margin: 0;
        color: var(--tufs-muted);
        font-size: 0.9rem;
      }

      .tufs-audio-note {
        border-top: 1px solid var(--tufs-border);
        padding-top: 10px;
      }

      @media (max-width: 1099px) {
        .tufs-unified-top {
          align-items: stretch;
          flex-direction: column;
        }

        .tufs-unified-actions {
          justify-content: flex-start;
        }

        .tufs-unified-layout {
          grid-template-columns: minmax(0, 1fr);
        }

        .tufs-audio-sidebar {
          position: static;
          grid-column: 1;
          grid-row: 1;
          max-height: none;
        }

        .tufs-unified-main {
          grid-column: 1;
          grid-row: 2;
        }

        .tufs-audio-summary {
          position: static;
        }
      }

      @media (max-width: 620px) {
        .tufs-unified-top,
        .tufs-unified-layout {
          padding-left: 10px;
          padding-right: 10px;
        }

        .tufs-unified-layout {
          gap: 12px;
        }

        .tufs-unified-actions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .tufs-unified-button {
          width: 100%;
        }

        .tufs-section-header {
          padding-left: 12px;
          padding-right: 10px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          scroll-behavior: auto !important;
        }
      }
    `;
  }
})();
