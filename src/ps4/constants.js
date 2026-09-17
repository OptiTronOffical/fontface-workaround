// constants.js — CSSFontFace offsets for the WebKit confirmation test
// Only the fields actually used by init_rw() and the read primitive.

const constants_cache = new Map();

const constants_map = {
  // ══════════════════════════════════════════════════════════════════
  // Firmware 13.x — CSSFontFace workaround
  //
  // WebKit-616-1300 moved the featureSettings getter behind
  // m_propertiesOrCSSConnection at +0x10. On 13.52 the workaround
  // selects the StyleRuleFontFace branch of the Variant.
  // ══════════════════════════════════════════════════════════════════
  13: {
    0: {
      // ── CSSFontFace layout ──
      wk_CSSFontFace_sizeof: 0xe8,
      wk_CSSFontFace_m_propertiesOrCSSConnection: 0x10,
      wk_CSSFontFace_m_clients: 0x68,
      wk_CSSFontFace_m_wrapper: 0x80,
      wk_CSSFontFace_m_status: 0x9a,
      wk_CSSFontFace_m_thread: 0xd8,
      wk_CSSFontFace_m_function: 0xe0,

      // Legacy m_featureSettings (fallback path)
      wk_CSSFontFace_m_featureSettings_m_buffer: 0x38,
      wk_CSSFontFace_m_featureSettings_m_size: 0x40,
      wk_CSSFontFace_m_featureSettings_m_capacity: 0x44,

      // ── Variant tags ──
      VARIANT_TAG_MUTABLE_STYLE_PROPERTIES: 0,
      VARIANT_TAG_STYLE_RULE_FONTFACE: 1,
    },
    0x52: {
      // Same struct layout as 13.00 — confirmed stable through 13.52
      wk_CSSFontFace_sizeof: 0xe8,
      wk_CSSFontFace_m_propertiesOrCSSConnection: 0x10,
      wk_CSSFontFace_m_clients: 0x68,
      wk_CSSFontFace_m_wrapper: 0x80,
      wk_CSSFontFace_m_status: 0x9a,
      wk_CSSFontFace_m_thread: 0xd8,
      wk_CSSFontFace_m_function: 0xe0,
      wk_CSSFontFace_m_featureSettings_m_buffer: 0x38,
      wk_CSSFontFace_m_featureSettings_m_size: 0x40,
      wk_CSSFontFace_m_featureSettings_m_capacity: 0x44,
      VARIANT_TAG_MUTABLE_STYLE_PROPERTIES: 0,
      VARIANT_TAG_STYLE_RULE_FONTFACE: 1,
    },
  },

  // ══════════════════════════════════════════════════════════════════
  // Firmware 11.x — legacy path (for testing the tool on older FW)
  // ══════════════════════════════════════════════════════════════════
  11: {
    0: {
      wk_CSSFontFace_sizeof: 0xe8,
      wk_CSSFontFace_m_clients: 0x68,
      wk_CSSFontFace_m_wrapper: 0x80,
      wk_CSSFontFace_m_status: 0x9a,
      wk_CSSFontFace_m_thread: 0xd8,
      wk_CSSFontFace_m_function: 0xe0,
      wk_CSSFontFace_m_featureSettings_m_buffer: 0x38,
      wk_CSSFontFace_m_featureSettings_m_size: 0x40,
      wk_CSSFontFace_m_featureSettings_m_capacity: 0x44,
      wk_CSSFontFace_m_propertiesOrCSSConnection: 0x10,
      VARIANT_TAG_MUTABLE_STYLE_PROPERTIES: 0,
      VARIANT_TAG_STYLE_RULE_FONTFACE: 1,
    },
  },
};

const constants = new Proxy(constants_map, {
  get(target, prop) {
    if (constants_cache.has(prop)) return constants_cache.get(prop);

    for (let major = version.major; major >= 0; major--) {
      if (major in target) {
        for (let minor = major === version.major ? version.minor : 0xff;
             minor >= 0; minor--) {
          if (minor in target[major] && prop in target[major][minor]) {
            const value = target[major][minor][prop];
            constants_cache.set(prop, value);
            return value;
          }
        }
      }
    }

    throw new Error(`${version} has no ${prop} !!`);
  },
});