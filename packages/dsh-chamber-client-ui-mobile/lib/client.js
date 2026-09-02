window.__ModuleLoader__.load({ id: "@dsh-chamber/dsh-client-ui-mobile", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/locales.ts
var zh = {
  "dsh-chamber.mobile.title": "\u79FB\u52A8\u89C6\u56FE",
  "dsh-chamber.mobile.drawer.open": "\u6253\u5F00\u4FA7\u8FB9\u680F",
  "dsh-chamber.mobile.drawer.close": "\u6536\u8D77\u4FA7\u8FB9\u680F"
};
var en = {
  "dsh-chamber.mobile.title": "Mobile view",
  "dsh-chamber.mobile.drawer.open": "Open sidebar",
  "dsh-chamber.mobile.drawer.close": "Close sidebar"
};

// src/client/styles.ts
var MOBILE_CSS = `
/* The mobile-only UI (hamburger, backdrop) defaults to hidden OUTSIDE the
   touch tier \u2014 the official shell.overlay layer renders entries
   unconditionally, so without this default desktop browsers would see an
   unstyled ghost button (design 17 \xA718.4.2 "PC leak" invariant, applied to
   the overlay entries). */
.dsh-mobile-nav-toggle,
.dsh-mobile-backdrop {
  display: none;
}

/* ---- touch tier: tablet/phone touch (design 17 \xA718.4.2) ---- */
@media (max-width: 1023px) and (pointer: coarse) {
  /* Three-column frame \u2192 single column; the sidebar leaves the grid flow
     entirely (it becomes the fixed drawer below). The grid tracks are
     explicitly locked so the center column is never squeezed into a 0-width
     track by the fixed sibling. IMPORTANT (P1-C): the official AppFrame
     sets NO explicit grid-column \u2014 with the sidebar fixed (out of flow),
     auto-placement would put conversation into track 1 (0px) and details
     into track 2 (full width). Both remaining columns must be pinned
     explicitly. */
  [data-mobile-frame] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  [data-mobile-role="conversation"] {
    grid-column: 2;
  }
  [data-mobile-role="details"] {
    grid-column: 3;
  }

  /* Sidebar \u2192 fixed overlay drawer, off-canvas by default. translateX(-105%)
     keeps the shadow out of view; the open state is driven purely by the
     official frame attribute (no JS state, no React). Motion uses the
     official tokens (--ds-ease-in-out / --ds-transition-duration-slow) and
     is disabled under prefers-reduced-motion. visibility hides the closed
     drawer from the tab order (WCAG 2.4.3 \u2014 off-canvas content must not be
     focusable) with a 0s delay so the close animation still plays. The
     official elevation shadow separates the drawer from the conversation. */
  [data-mobile-role="sidebar"] {
    position: fixed !important;
    top: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    z-index: 40;
    width: min(86vw, 280px) !important;
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.08));
    transform: translateX(-105%);
    visibility: hidden;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s 0.3s;
  }
  [data-mobile-frame]:not([data-sidebar-collapsed]) [data-mobile-role="sidebar"] {
    transform: none;
    visibility: visible;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-role="sidebar"] {
      transition: none;
    }
  }

  /* Drawer backdrop: dims the conversation behind the open drawer and \u2014 by
     sitting above it (z-39 < drawer 40) \u2014 absorbs stray taps on the ~50px
     live seam right of the drawer (the composer send button must not be
     hit while the drawer is open). Tap on the backdrop closes the drawer
     (the toggle component wires the click). */
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 39;
    background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
    -webkit-backdrop-filter: var(--dsw-mask-blur, blur(2px));
    backdrop-filter: var(--dsw-mask-blur, blur(2px));
    border: none;
    padding: 0;
  }

  /* Details column \u2192 right-side overlay when opened (data-details-collapsed
     removed): the official details/trajectory panel stays reachable on
     touch. Design \xA718.4.3 offers two variants (bottom sheet / Status tab);
     this implementation uses a THIRD form \u2014 a right-side overlay that
     keeps the official DOM untouched (zero re-implementation). The grid's
     third track stays 0 \u2014 the fixed column overlays the conversation.
     transform: none while open (same containing-block rule as the
     drawer). */
  [data-mobile-role="details"] {
    position: fixed !important;
    top: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    z-index: 38;
    width: min(86vw, 320px) !important;
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.08));
    transform: translateX(105%);
    visibility: hidden;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s 0.3s;
  }
  [data-mobile-frame]:not([data-details-collapsed]) [data-mobile-role="details"] {
    transform: none;
    visibility: visible;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-role="details"] {
      transition: none;
    }
  }

  /* Drag handles are desktop affordances (mouse resizing) \u2014 hidden on
     touch where the drawer/overlay geometry replaces them. */
  [data-mobile-frame] [class$="_widthHandle"],
  [data-mobile-frame] [class$="_handle"] {
    display: none !important;
  }

  /* Floating drawer toggle: the official sidebar toggle lives inside the
     sidebar DOM, which the off-canvas transform hides \u2014 this shell.overlay
     entry is the mobile entry point. Hidden again while the drawer is open
     (the drawer's own header carries the close control). The default
     display: none outside this tier kills the desktop ghost button \u2014 the
     official overlay layer renders entries unconditionally. Visual language
     follows the official icon buttons: transparent base, hover/active
     fills from the alias tokens, focus ring in the business-primary color. */
  .dsh-mobile-nav-toggle {
    position: fixed;
    top: max(10px, env(safe-area-inset-top, 0px));
    left: 10px;
    z-index: 41;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    border-radius: 12px;
    background: transparent;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-nav-toggle:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  }
  .dsh-mobile-nav-toggle:active {
    background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.08));
  }
  .dsh-mobile-nav-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
  }
  .dsh-mobile-nav-toggle-bars,
  .dsh-mobile-nav-toggle-bars::before,
  .dsh-mobile-nav-toggle-bars::after {
    display: block;
    width: 20px;
    height: 2px;
    border-radius: 2px;
    background: var(--dsw-alias-label-primary, #0f1115);
  }
  .dsh-mobile-nav-toggle-bars { position: relative; }
  .dsh-mobile-nav-toggle-bars::before,
  .dsh-mobile-nav-toggle-bars::after {
    content: '';
    position: absolute;
    left: 0;
  }
  .dsh-mobile-nav-toggle-bars::before { top: -6px; }
  .dsh-mobile-nav-toggle-bars::after { top: 6px; }
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-nav-toggle {
    display: none;
  }

  /* Touch targets: high-frequency controls get the 44px floor (Apple HIG;
     WCAG 2.5.8 \u226524px is exceeded). The official toolbar/sidebar buttons are
     28-36px (desktop-mouse sizes) \u2014 unusable on touch. Icon-only buttons
     also get a width floor; text buttons (composer bar) keep their natural
     width. Menu/popup items and settings entries get the same floor. */
  [data-slot="conversation.composer.bar"] button,
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [data-slot="settings.section"] button,
  [role="menuitem"], [role="option"] {
    min-height: 44px;
  }
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [role="menuitem"], [role="option"] {
    min-width: 44px;
  }

  /* touch-action: the composer contenteditable and inputs get
     manipulation (no double-tap zoom), but textareas MUST keep auto \u2014 a
     manipulation textarea swallows the caret/scroll (design \xA718.4.3
     note). */
  [contenteditable="true"], input:not([type="range"]) {
    touch-action: manipulation;
  }
  textarea {
    touch-action: auto;
  }

  /* No double-tap zoom / tap highlight noise; keep text scaling intact. */
  html {
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }
}

/* ---- phone tier (design 17 \xA718.4.2/\xA718.4.3) ---- */
@media (max-width: 768px) and (pointer: coarse) {
  /* Composer toolbar: one line. The official row wraps; force nowrap (the
     official 12px gap is kept \u2014 no gap override). */
  [data-slot="conversation.composer.bar"] [class$="_row"] {
    flex-wrap: nowrap !important;
  }
  [data-slot="conversation.composer.bar"] [class$="_row"] [class$="_trigger"],
  [data-slot="conversation.input.model"] button {
    max-width: 112px !important;
    flex: 0 1 auto !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Popups (command menu, model menu, context pickers) never overflow the
     viewport horizontally. */
  [role="menu"], [role="listbox"], [data-trigger-menu] {
    max-width: calc(100vw - 24px) !important;
  }

  /* Settings dialog \u2192 full-screen sheet with its own scrolling; the
     official 800px dialog is unusable on a phone. The :has() anchor is fine
     here: this rule is static (no per-DOM-change re-evaluation hot path).
     A 100vh fallback precedes 100dvh for older engines. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    max-width: none !important;
    height: 100vh !important;
    height: 100dvh !important;
    max-height: none !important;
    border-radius: 0 !important;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) nav {
    padding: calc(10px + env(safe-area-inset-top)) 12px 10px !important;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Composer seat: respect the home-indicator inset. The official seat is
     sticky inside the scroll body; the padding keeps the input above the
     gesture bar. */
  [data-composer-seat] {
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* iOS focus zoom: the composer must not trigger the automatic 16px
     minimum zoom on focus. max(16px, ...) keeps the official content-size
     preference (--dsh-content-font-size) when the user set it larger. */
  [data-composer-input] {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
  }

  /* Conversation header: allow the title cluster to wrap instead of
     overflowing (the official row assumes desktop width). */
  [data-slot="conversation.session.header"] [class$="_titleRow"] {
    flex-wrap: wrap;
  }

  /* Scrolling body: the official padding-bottom for the composer is a
     variable; keep it sane on short screens. */
  [data-conversation-scroll] {
    overscroll-behavior-y: contain;
  }
}
`;
var VIEWPORT_TOKENS = ["viewport-fit=cover", "interactive-widget=resizes-content"];
var PLUGIN_STYLE_TAG = "dsh-chamber-client-ui-mobile";

// src/client/markup.ts
var MOBILE_FRAME_ATTR = "data-mobile-frame";
var MOBILE_ROLE_ATTR = "data-mobile-role";
function findFrame(root) {
  for (const child of root.children) {
    if (child !== null) return child;
  }
  return null;
}
function findColumn(frame, slot) {
  for (const col of frame.children) {
    for (const inner of col.children) {
      if (inner.getAttribute("data-slot") === slot) return col;
    }
  }
  return null;
}
function stampFrame(root) {
  const frame = findFrame(root);
  if (frame === null) return null;
  frame.setAttribute(MOBILE_FRAME_ATTR, "");
  for (const slot of ["sidebar", "conversation", "details"]) {
    const column = findColumn(frame, slot);
    if (column !== null) column.setAttribute(MOBILE_ROLE_ATTR, slot);
  }
  return frame;
}
function deriveCollapsed(snapshot) {
  return snapshot.narrow ? !snapshot.narrowExpanded : snapshot.sidebar === 0;
}

// src/client/composer.ts
var COMPOSER_INPUT_SELECTOR = "[data-composer-input]";
var TOUCH_TIER_QUERY = "(max-width: 1023px) and (pointer: coarse)";
function isComposerInput(target) {
  return target instanceof Element && target.closest(COMPOSER_INPUT_SELECTOR) !== null;
}
function hasHighlightedMenuOpen() {
  const highlighted = document.querySelector(
    '[data-trigger-menu] [aria-activedescendant], [data-trigger-menu] [role="option"][aria-selected="true"], [role="menu"] [role="menuitem"][aria-selected="true"]'
  );
  return highlighted !== null;
}
function createComposingGuard() {
  let lastCompositionEnd = 0;
  const onStart = () => {
    lastCompositionEnd = 0;
  };
  const onEnd = () => {
    lastCompositionEnd = Date.now();
  };
  return {
    isComposingNow: () => Date.now() - lastCompositionEnd < 10,
    attach: () => {
      document.addEventListener("compositionstart", onStart, true);
      document.addEventListener("compositionend", onEnd, true);
      return () => {
        document.removeEventListener("compositionstart", onStart, true);
        document.removeEventListener("compositionend", onEnd, true);
      };
    }
  };
}
function installEnterToNewline() {
  const composing = createComposingGuard();
  const detachComposing = composing.attach();
  const onKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (composing.isComposingNow()) return;
    if (!isComposerInput(event.target)) return;
    if (hasHighlightedMenuOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    const ok = document.execCommand("insertLineBreak");
    if (!ok) document.execCommand("insertText", false, "\n");
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    detachComposing();
  };
}
function installEditabilityRecovery(root = document) {
  let lastEditable = true;
  const observer = new MutationObserver(() => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    const editable = input.contentEditable === "true";
    if (editable && !lastEditable && input === document.activeElement) {
      input.blur();
      input.focus({ preventScroll: true });
    }
    lastEditable = editable;
  });
  observer.observe(root, { attributes: true, attributeFilter: ["contenteditable"], subtree: true });
  return () => observer.disconnect();
}
function isKeyboardOpen(layoutHeight, visualHeight) {
  const gap = layoutHeight - visualHeight;
  return gap > 120 && gap > layoutHeight * 0.2;
}
function installImeLadder(root = document) {
  let lastPointerDown = 0;
  let keyboardOpen = false;
  const syncKeyboard = () => {
    const vv = window.visualViewport;
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height);
  };
  const onPointerDown = (event) => {
    if (event.pointerType === "mouse") return;
    lastPointerDown = Date.now();
  };
  const onFocusIn = (event) => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    if (event.target !== input && !input.contains(event.target)) return;
    const fromGesture = Date.now() - lastPointerDown < 500;
    if (fromGesture) return;
    let frames = 0;
    let cancelled = false;
    const onGestureCancel = () => {
      cancelled = true;
    };
    document.addEventListener("pointerdown", onGestureCancel, true);
    const drop = () => {
      frames += 1;
      if (frames > 12 || cancelled) {
        document.removeEventListener("pointerdown", onGestureCancel, true);
        return;
      }
      if (input === document.activeElement && !keyboardOpen) {
        input.blur();
        requestAnimationFrame(drop);
      } else {
        document.removeEventListener("pointerdown", onGestureCancel, true);
      }
    };
    drop();
  };
  const onPointerUp = (event) => {
    if (event.pointerType === "mouse") return;
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    if (!input.contains(event.target)) return;
    if (input === document.activeElement) return;
    if (keyboardOpen) return;
    input.focus({ preventScroll: true });
  };
  const onViewportResize = () => {
    syncKeyboard();
  };
  return {
    attach: () => {
      syncKeyboard();
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("focusin", onFocusIn, true);
      document.addEventListener("pointerup", onPointerUp, true);
      window.visualViewport?.addEventListener("resize", onViewportResize);
      window.visualViewport?.addEventListener("scroll", onViewportResize);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("pointerup", onPointerUp, true);
        window.visualViewport?.removeEventListener("resize", onViewportResize);
        window.visualViewport?.removeEventListener("scroll", onViewportResize);
      };
    },
    isKeyboardOpen: () => keyboardOpen
  };
}
function installKeyboardPinning(root = document) {
  let keyboardOpen = false;
  const onResize = () => {
    const vv = window.visualViewport;
    const next = vv !== null && isKeyboardOpen(window.innerHeight, vv.height);
    if (next === keyboardOpen) return;
    keyboardOpen = next;
    if (!keyboardOpen) return;
    const seat = root.querySelector("[data-composer-seat]");
    if (seat instanceof Element) {
      const rect = seat.getBoundingClientRect();
      const vvBottom = vv !== null ? vv.height : window.innerHeight;
      if (rect.bottom > vvBottom) {
        seat.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  };
  window.visualViewport?.addEventListener("resize", onResize);
  return () => window.visualViewport?.removeEventListener("resize", onResize);
}
var BUSY_STUCK_MS = 3e4;
function installComposerSelfHeal(root = document) {
  let lockedSince = 0;
  const observer = new MutationObserver(() => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    const editable = input.contentEditable === "true";
    if (!editable) {
      if (lockedSince === 0) lockedSince = Date.now();
    } else {
      lockedSince = 0;
    }
  });
  const onPointerDown = (event) => {
    if (event.pointerType === "mouse") return;
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    if (!input.contains(event.target)) return;
    if (lockedSince === 0) return;
    if (Date.now() - lockedSince < BUSY_STUCK_MS) return;
    lockedSince = 0;
    const editable = input.contentEditable === "true";
    if (editable) return;
    input.blur();
    input.contentEditable = "true";
    input.focus({ preventScroll: true });
  };
  observer.observe(root, { attributes: true, attributeFilter: ["contenteditable"], subtree: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}

// src/client/layout-facts.ts
function findFrame2() {
  const root = document.querySelector('[data-slot="root"]');
  if (root === null) return null;
  for (const child of root.children) {
    if (child instanceof Element) return child;
  }
  return null;
}
function createLayoutFactSource(ctx) {
  let facts;
  try {
    facts = ctx.layoutFacts;
  } catch {
    facts = void 0;
  }
  const tier = window.matchMedia(TOUCH_TIER_QUERY);
  if (facts !== void 0) {
    const listeners2 = /* @__PURE__ */ new Set();
    const notify2 = () => {
      for (const listener of listeners2) listener();
    };
    const unsubscribeStore = facts.subscribeLayout(notify2);
    const onTierChange2 = () => notify2();
    tier.addEventListener("change", onTierChange2);
    return {
      getCollapsed: () => deriveCollapsed(facts.getLayoutSnapshot()),
      getNarrow: () => tier.matches,
      subscribe: (listener) => {
        listeners2.add(listener);
        listener();
        return () => {
          listeners2.delete(listener);
        };
      },
      dispose: () => {
        unsubscribeStore();
        tier.removeEventListener("change", onTierChange2);
      }
    };
  }
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let frame = findFrame2();
  const frameObserver = new MutationObserver(notify);
  const attach = () => {
    const next = findFrame2();
    if (next === frame) return;
    if (frame !== null) frameObserver.disconnect();
    frame = next;
    if (frame !== null) {
      frameObserver.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "data-details-collapsed"] });
    }
    notify();
  };
  attach();
  const bodyObserver = new MutationObserver(attach);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  const onTierChange = () => notify();
  tier.addEventListener("change", onTierChange);
  return {
    getCollapsed: () => frame === null || frame.hasAttribute("data-sidebar-collapsed"),
    getNarrow: () => tier.matches,
    subscribe: (listener) => {
      listeners.add(listener);
      listener();
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      frameObserver.disconnect();
      bodyObserver.disconnect();
      tier.removeEventListener("change", onTierChange);
    }
  };
}

// src/client/MobileNavToggle.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function findFrame3(root) {
  for (const child of root.children) {
    if (child instanceof Element) return child;
  }
  return null;
}
function MobileNavToggle({ toggleSidebar, t }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const root = document.querySelector('[data-slot="root"]');
    if (root === null) return;
    const frame = findFrame3(root);
    if (frame === null) return;
    const sync = () => setOpen(!frame.hasAttribute("data-sidebar-collapsed"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
    return () => observer.disconnect();
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-mobile-nav-toggle",
        "aria-label": open ? t("dsh-chamber.mobile.drawer.close") : t("dsh-chamber.mobile.drawer.open"),
        "aria-expanded": open,
        "aria-haspopup": "true",
        onClick: () => toggleSidebar(),
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-mobile-nav-toggle-bars", "aria-hidden": "true" })
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-mobile-backdrop",
        "aria-label": t("dsh-chamber.mobile.drawer.close"),
        tabIndex: -1,
        onClick: () => toggleSidebar()
      }
    )
  ] });
}

// src/client/index.ts
var NS = "dsh-chamber.mobile";
var ROOT_SLOT_SELECTOR = '[data-slot="root"]';
var inject = ["slots", "locale", "layout"];
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-chamber: mobile dictionaries");
  ctx.effect(() => {
    const disposers = [];
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta instanceof HTMLMetaElement) {
      const content = meta.content;
      const missing = VIEWPORT_TOKENS.filter((token) => !content.includes(token));
      if (missing.length > 0) meta.content = [content, ...missing].filter(Boolean).join(", ");
    } else {
      const created = document.createElement("meta");
      created.name = "viewport";
      created.content = `width=device-width, initial-scale=1, ${VIEWPORT_TOKENS.join(", ")}`;
      document.head.appendChild(created);
      disposers.push(() => created.remove());
    }
    if (document.querySelector(`style[data-plugin="${PLUGIN_STYLE_TAG}"]`) === null) {
      const style = document.createElement("style");
      style.setAttribute("data-plugin", PLUGIN_STYLE_TAG);
      style.textContent = MOBILE_CSS;
      document.head.appendChild(style);
      disposers.push(() => style.remove());
    }
    const existingThemeMeta = document.querySelector('meta[name="theme-color"]');
    const themeMeta = existingThemeMeta ?? document.createElement("meta");
    if (existingThemeMeta === null) {
      themeMeta.name = "theme-color";
      document.head.appendChild(themeMeta);
      disposers.push(() => themeMeta.remove());
    }
    const syncThemeColor = () => {
      const surface = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
      themeMeta.setAttribute("content", surface === "" ? "#ffffff" : surface);
    };
    syncThemeColor();
    const themeObserver = new MutationObserver(syncThemeColor);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
    disposers.push(() => themeObserver.disconnect());
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-chamber: mobile assets");
  ctx.effect(() => {
    const stamped = /* @__PURE__ */ new WeakSet();
    const stamp = () => {
      for (const root of document.querySelectorAll(ROOT_SLOT_SELECTOR)) {
        const frame = stampFrame(root);
        if (frame !== null && !stamped.has(frame)) stamped.add(frame);
      }
    };
    const isStructuralTarget = (target) => target instanceof Element && (target.matches(ROOT_SLOT_SELECTOR) || target.matches("[data-mobile-frame]") || target.matches("[data-mobile-role]") || target.parentElement?.matches(ROOT_SLOT_SELECTOR) === true || target.parentElement?.matches("[data-mobile-frame]") === true);
    const onMutations = (mutations) => {
      if (mutations.some((mutation) => mutation.type === "childList" && Array.from(mutation.addedNodes).some((node) => isStructuralTarget(node)))) {
        stamp();
      }
    };
    stamp();
    const observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, "dsh-chamber: mobile frame stamping");
  const layoutSource = createLayoutFactSource(ctx);
  ctx.effect(() => {
    let lastLocked = false;
    const lockScroll = (locked) => {
      const containers = document.querySelectorAll("[data-conversation-scroll]");
      for (const container of containers) {
        if (container instanceof HTMLElement) {
          container.style.overflow = locked ? "hidden" : "";
        }
      }
      document.body.style.overflow = locked ? "hidden" : "";
    };
    const sync = () => {
      const locked = layoutSource.getNarrow() && !layoutSource.getCollapsed();
      if (locked === lastLocked) return;
      lastLocked = locked;
      lockScroll(locked);
    };
    const unsubscribe = layoutSource.subscribe(sync);
    return () => {
      unsubscribe();
      lockScroll(false);
    };
  }, "dsh-chamber: mobile drawer scroll lock");
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (!layoutSource.getCollapsed()) ctx.layout.toggleSidebar();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, "dsh-chamber: mobile drawer escape close");
  ctx.effect(() => () => layoutSource.dispose(), "dsh-chamber: mobile layout source");
  ctx.effect(() => {
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY);
    let disposers = [];
    const sync = () => {
      if (touchTier.matches) {
        if (disposers.length === 0) {
          const ladder = installImeLadder();
          disposers = [
            installEnterToNewline(),
            installEditabilityRecovery(),
            installKeyboardPinning(),
            installComposerSelfHeal(),
            ladder.attach()
          ];
        }
      } else {
        for (const dispose of disposers) dispose();
        disposers = [];
      }
    };
    sync();
    touchTier.addEventListener("change", sync);
    return () => {
      touchTier.removeEventListener("change", sync);
      for (const dispose of disposers) dispose();
    };
  }, "dsh-chamber: mobile composer behavior");
  const injected = () => ({
    toggleSidebar: () => ctx.layout.toggleSidebar(),
    t
  });
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "mobile-nav-toggle",
    label: () => t("dsh-chamber.mobile.title"),
    locale: NS,
    inject: injected
  }, MobileNavToggle));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
