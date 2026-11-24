/* GLPI adapter of niimbot-web-bluetooth 2.6.0 (iscarelli, MIT).
 * One private connection per label. See LICENSE.
 */
  const VERSION = "2.6.0";   // shown in the demo/console; bump on each release (or dev change)
  const SVC_UUID = "e7810a71-73ae-499d-8c15-faa9aef0c3f2";
  const CHAR_UUID = "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Debug logging (toggle via Niimbot.DEBUG) ────────────────────────────────
  let DEBUG = false;
  // Tolerates null because `wantResp` legitimately IS null for the reads that accept
  // any response opcode (getStatus's heartbeat, the handshake's info reads). Without
  // this, the timeout WARNING below throws a TypeError — so a printer that simply went
  // quiet produced a hard error instead of the soft "no answer" the caller handles.
  const h2 = (b) => (b == null ? "—" : b.toString(16).padStart(2, "0"));
  const hex = (arr) => Array.from(arr).map(h2).join(" ");
  let _imgRows = 0; // coalesce the many 0x84/0x85 row packets into one log line
  function flushImg() {
    if (_imgRows && DEBUG) console.log(`[niimbot] →  (… ${_imgRows} image rows 0x84/0x85 …)`);
    _imgRows = 0;
  }
  function logTx(cmd, data) {
    if (!DEBUG) return;
    if (cmd === 0x84 || cmd === 0x85) { _imgRows++; return; }
    flushImg();
    console.log(`[niimbot] →  ${h2(cmd)} (${(data || []).length}b) ${hex(data || [])}`);
  }
  function logRx(cmd, data) { if (DEBUG) { flushImg(); console.log(`[niimbot] ←  ${h2(cmd)} (${data.length}b) ${hex(data)}`); } }
  function logMsg(m) { if (DEBUG) { flushImg(); console.log(`[niimbot] ·  ${m}`); } }
  // NOT gated behind DEBUG: which write path a print actually took must be readable
  // without turning on the packet dump that buries it (a phone has no console — the
  // demo's log panel mirrors console.log, and DEBUG off is its default). Reserved for
  // the few lines that answer "how did this print go out?".
  function logAlways(m) { flushImg(); console.log(`[niimbot] ·  ${m}`); }

  // ── One driver instance per printer ─────────────────────────────────────────
  // Everything from here to the end of the file is per-CONNECTION state and the code
  // that drives it (device, characteristic, waiter queue, detected model, write/bundle
  // settings, page counters), so it lives inside createInstance(): each call is an
  // independent driver, which is what lets one page run a B1 and a D11 at once. The
  // body is deliberately NOT re-indented (a 1400-line whitespace diff would bury the
  // change). Above this line stays shared: constants, the log helpers, and DEBUG (one
  // switch for all instances). `Niimbot` itself is the default instance, so every
  // pre-existing caller is unaffected.
  function createInstance() {

  // Timing trace for batch diagnostics (concise: a few lines per batch), gated behind
  // DEBUG. Reveals whether an inter-label gap is us sending the next page late or the
  // printer idling after a page. Times are ms since the batch began.
  let _t0 = 0;
  function tlog(m) { if (DEBUG) console.log(`[niimbot t+${String(Date.now() - _t0).padStart(5)}ms] ${m}`); }

  // Connection reused across prints (one per driver instance — see createInstance).
  let device = null;
  let characteristic = null;
  // Waiters registered by sendWait()/getPrintStatus(), in registration order. Each
  // entry is { cmd, resolve } — `cmd === null` means "any opcode" (the handshake's
  // PrinterInfo reads use that, since the response code varies by sub-command). A
  // notification resolves the FIRST entry whose cmd matches (or the first `null`
  // entry), so two waiters for different opcodes can be outstanding at once and each
  // gets its own reply; two waiters for the SAME opcode resolve in the order they
  // were registered. Nothing registers more than one waiter at a time yet — no print
  // path sends in parallel — so today this behaves exactly like the single slot it
  // replaced; the capacity is unused until a caller needs it.
  let pendingQueue = [];
  let lastUnsolicited = null; // last unsolicited response (e.g. status during the poll)

  // Row-received counter (0xD3), unsolicited: the printer volunteers it during row
  // upload, unasked. 3-byte payload [rowHi, rowLo, ?] — the first two are the LAST ROW
  // INDEX it has received so far, big-endian, 0-based (`00 c7` = 199, `01 03` = 259 —
  // docs/NOTES.md, §"0xD3 is a row-received counter" and §"Ink is free, row changes are
  // not"). The third byte is undecoded. Only the D11_H and B2 Pro have been seen sending
  // it; most models never do, which is why a page with no 0xD3 at all must NOT be
  // treated as a failure (see rowsProblem below). Tracked as the MAX seen, not the last:
  // one page can emit it more than once (one per internal frame — a 200-row run cap
  // split one all-black page into 199 then 259), and the true answer is the highest.
  // Reset per PAGE (see resetRowsSeen, called at the top of sendPagePacked), not per
  // job, since a job can carry several pages over the same wire.
  let _rowsSeenMax = null;
  function resetRowsSeen() { _rowsSeenMax = null; }

  // Register a waiter and return a token to clear it (on timeout) without disturbing
  // any other waiter in the queue.
  function registerWait(cmd, resolve, acceptPrintError = false) {
    const entry = { cmd, resolve, acceptPrintError };
    pendingQueue.push(entry);
    return entry;
  }
  function clearWait(entry) {
    const idx = pendingQueue.indexOf(entry);
    if (idx >= 0) pendingQueue.splice(idx, 1);
  }

  // ── Frame V4: [0x55,0x55,cmd,len,...data,crc,0xAA,0xAA], crc = cmd^len^data ──
  function pack(cmd, data) {
    data = data || [];
    const pkt = new Uint8Array(7 + data.length);
    pkt[0] = 0x55; pkt[1] = 0x55; pkt[2] = cmd; pkt[3] = data.length;
    let crc = cmd ^ data.length;
    for (let i = 0; i < data.length; i++) { pkt[4 + i] = data[i]; crc ^= data[i]; }
    pkt[4 + data.length] = crc & 0xff;
    pkt[5 + data.length] = 0xaa; pkt[6 + data.length] = 0xaa;
    return pkt;
  }

  function onNotify(event) {
    const v = event.target.value; // DataView
    if (v.byteLength < 7) return;
    if (v.getUint8(0) !== 0x55 || v.getUint8(1) !== 0x55) return;
    const cmd = v.getUint8(2);
    const len = v.getUint8(3);
    if (v.byteLength !== len + 7 || v.getUint8(len + 5) !== 0xaa || v.getUint8(len + 6) !== 0xaa) return;
    const data = [];
    let checksum = cmd ^ len;
    for (let i = 0; i < len; i++) {
      const byte = v.getUint8(4 + i);
      checksum ^= byte;
      data.push(byte);
    }
    if (checksum !== v.getUint8(len + 4)) return;
    logRx(cmd, data);
    if (cmd === 0xd3 && data.length >= 2) {
      const rowIdx = (data[0] << 8) | data[1];
      if (_rowsSeenMax === null || rowIdx > _rowsSeenMax) _rowsSeenMax = rowIdx;
    }
    const idx = pendingQueue.findIndex((w) => w.cmd === cmd || w.cmd === null || (cmd === 0xdb && w.acceptPrintError));
    if (idx >= 0) {
      const [w] = pendingQueue.splice(idx, 1);
      w.resolve({ cmd, data });
    } else {
      lastUnsolicited = { cmd, data };
    }
  }

  // Flow control. Unacked writes (writeValueWithoutResponse) can be dropped under a
  // burst, leaving the page incomplete — on the B1 the page stalls; on macOS the page
  // comes out BLANK. "acked" = write-with-response (ordered, slow); "paced" = unacked
  // + a short gap; "fast" = unacked, no gap.
  //
  // ⚠ "fast" IS AN UNMEASURED DEFAULT, not a measured choice. This comment used to say
  // the B1 Pro / M2-H "take fast on Windows" and that Windows "tolerates" the burst.
  // Nothing ever measured that. As of 2026-08-13 the score is: THREE confirmed failures
  // in "fast" (a non-Mac desktop and an iPhone, both on dense content, plus the macOS
  // blank-page history) and ZERO confirmed successes in "fast" — every print known to
  // have succeeded either ran "paced" or ran on a machine whose OS nobody recorded.
  // Whether any platform actually needs the unpaced path is still open; see
  // docs/NOTES.md § Write mode. Do not restate the old claim without a measurement.
  // IS_MAC matches iOS TOO, and that is not a bug in the test: every iOS user agent
  // contains "like Mac OS X", and iOS is CoreBluetooth as well. The consequence is that
  // an iPhone has only ever printed PACED — whether it needs to is unmeasured. See the
  // write-mode override below, which is what makes that measurable.
  // MAC_SOURCE records WHICH input decided IS_MAC, and it is printed on the connect
  // line. Reason: on 2026-08-13 the same Chrome on the same Mac logged `mac=true` in one
  // session and `mac=false` in another, and `mac=false` alone could not say why — the
  // value is computed once at load, so the difference had to be in what `navigator`
  // reported (DevTools device emulation overrides BOTH `userAgentData.platform` and the
  // user agent, for instance). A boolean with no provenance turned that into hours of
  // guessing about which machine was used. Never remove this from the log line.
  let MAC_SOURCE = "?";
  const IS_MAC = (() => {
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        // Report `platform` alongside it even though the decision ignores it: when the
        // two DISAGREE (uaData="Windows" while platform="MacIntel") something is
        // rewriting the identity — device emulation, a privacy extension, a spoofed UA
        // — and that contradiction is the single most useful thing this line can show.
        MAC_SOURCE = `uaData="${navigator.userAgentData.platform}" platform="${navigator.platform || ""}"`;
        return navigator.userAgentData.platform === "macOS";
      }
    } catch (e) {}
    const plat = navigator.platform || "";
    const ua = navigator.userAgent || "";
    const hit = /Mac/i.test(plat + " " + ua);
    // Say which of the two matched: on iOS it is the UA ("like Mac OS X"), on macOS
    // usually the platform ("MacIntel"). That distinction is the iOS/macOS tell.
    MAC_SOURCE = `platform="${plat}"${hit ? (/Mac/i.test(plat) ? " matched:platform" : " matched:ua") : ""}`;
    return hit;
  })();
  let writeMode = "fast";   // "fast" | "acked" | "paced" — as DETECTED at connect; the override below never overwrites it
  let PACE_MS = 10;         // gap (ms) between unacked writes so rows aren't dropped; runtime-tunable via Niimbot.PACE_MS

  // ── Write-mode override: an escape hatch in BOTH directions ─────────────────
  // Niimbot.WRITE_MODE forces "fast" | "paced" | "acked" over whatever connect()
  // detected; null (the default) means auto. Read per WRITE, not per connect, so it can
  // be flipped on an already-open connection, and `writeMode` above keeps reporting what
  // was DETECTED — the two are separate on purpose, so a log line can show both.
  //
  // Why it must force "fast" and not only "paced": IS_MAC matches iOS as well as macOS.
  // Every iOS user agent contains "like Mac OS X", so an iPhone matches — measured, not
  // assumed: the device's connect line reads `mac=true`. **iOS has therefore only ever
  // printed paced.** Whether it NEEDS the pacing is unmeasured, and the only way to find
  // out is to force "fast" there and look at the paper (README § iOS coverage has the
  // procedure). A one-directional FORCE_PACING could not ask that question.
  //
  // Sharp edge, deliberate: FORCE_PACING (published API in 1.4.0) is kept as an ALIAS —
  // reading it is `override === "paced"`, setting true sets "paced", setting false
  // clears the override to null. So `FORCE_PACING = false` also clears a "fast" or
  // "acked" override, because a boolean cannot express "not paced, but keep the other
  // thing". Use WRITE_MODE when that distinction matters.
  const WRITE_MODES = ["fast", "paced", "acked"];
  let writeOverride = null;
  function setWriteOverride(v) {
    const next = (v == null || v === "auto") ? null : v;
    if (next !== null && WRITE_MODES.indexOf(next) < 0) {
      throw new Error(`Niimbot.WRITE_MODE must be null (auto) or one of ${WRITE_MODES.map((m) => `"${m}"`).join(", ")} — got ${JSON.stringify(v)}.`);
    }
    writeOverride = next;
    logAlways(`WRITE_MODE override = ${next || "auto"} → effective=${effectiveWriteMode()} (detected=${writeMode})`);
    warnOverrideVsModel();
  }
  function effectiveWriteMode() {
    return writeOverride || writeMode;
  }
  // The 203 dpi B1 drops rows on an unpaced burst (MODEL_IDS `paced`), so forcing
  // "fast" there is a diagnostic, not a setting. Say so loudly — and still obey it:
  // refusing would put this driver in the business of overruling the measurement it
  // exists to make possible.
  function warnOverrideVsModel() {
    const meta = (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
    if (writeOverride === "fast" && meta && meta.paced) {
      logAlways(`⚠ WRITE_MODE="fast" overrides ${meta.label}, which NEEDS pacing (${meta.dpi} dpi: it drops rows on an unpaced burst). Obeying — expect blank or short labels. This is a diagnostic, not a setting.`);
    }
  }
  async function writeRaw(bytes) {
    const mode = effectiveWriteMode();
    if (mode === "acked") { await characteristic.writeValueWithResponse(bytes); return; }
    // writeValueWithoutResponse pode estourar o buffer BLE em rajada — retry curto.
    let last = null;
    for (let tries = 0; tries < 30; tries++) {
      try {
        await characteristic.writeValueWithoutResponse(bytes);
        if (mode === "paced") await sleep(PACE_MS);
        return;
      } catch (e) { last = e; await sleep(4); }
    }
    // Name the mode: with an override in play, "unacked writes keep failing" may mean
    // the characteristic has no unacked path at all and "acked" is the only one it takes.
    throw new Error(`Failed to write to BLE in "${mode}" mode (buffer full, or this characteristic has no unacked write path)${last && last.message ? ": " + last.message : ""}`);
  }

  function send(cmd, data) { logTx(cmd, data); return writeRaw(pack(cmd, data)); }

  // Frame bundling. Each row is its own BLE write, and on the B1 every write costs a
  // ~10 ms pace — so a dense page (≈one packet per row) is dominated by the write
  // COUNT, not the bytes. The protocol is a frame stream and the printer reassembles
  // it, so several [55 55 … aa aa] frames can ride in one write, as long as the write
  // stays within the BLE MTU. BUNDLE_MAX = max bytes per write; 0 disables bundling
  // (one frame per write, the original behavior). Tunable at runtime via Niimbot.
  // Single 61 B frames already work, so the MTU is ≥ ~64; 240 is safe for MTU ≥ 247.
  let BUNDLE_MAX = 240;
  let _bundleAllowed = false;   // set per connected model (see MODEL_IDS `bundle`)
  // Bundle override: an escape hatch to TEST bundling on a model that has not been
  // validated for it (see T-037 — the D11_H sends one frame per write and a 208-frame
  // page cuts short on paper, and there is no way to try bundling there today). null
  // (default) means "use the per-model default"; true/false forces it. DIAGNOSTIC: the
  // per-model default in MODEL_IDS keeps deciding for real use, and bundling is only
  // validated on the B1 and M2-H. Not reset at connect — same as writeOverride, so a
  // tester can fix it before connecting and have it survive.
  let bundleOverride = null;
  function effectiveBundle() {
    return bundleOverride === null ? _bundleAllowed : bundleOverride;
  }
  let _bundle = [];      // pending raw frames awaiting a flush
  let _bundleLen = 0;
  async function flushBundle() {
    if (!_bundle.length) return;
    let out;
    if (_bundle.length === 1) { out = _bundle[0]; }
    else {
      out = new Uint8Array(_bundleLen);
      let o = 0;
      for (const f of _bundle) { out.set(f, o); o += f.length; }
    }
    _bundle = []; _bundleLen = 0;
    await writeRaw(out);
  }
  // Queue a frame into the current bundle, flushing first if it wouldn't fit. A frame
  // is never split (max(BUNDLE_MAX, frame.length) keeps an oversized frame whole).
  async function sendBundled(cmd, data) {
    logTx(cmd, data);
    const frame = pack(cmd, data);
    const max = effectiveBundle() ? BUNDLE_MAX : 0;   // 0 → one frame per write (B1 Pro, unknown models)
    if (_bundleLen && _bundleLen + frame.length > Math.max(max, frame.length)) await flushBundle();
    _bundle.push(frame); _bundleLen += frame.length;
  }

  async function sendWait(cmd, data, wantResp, timeoutMs, acceptPrintError = false) {
    let entry;
    const wait = new Promise((resolve) => { entry = registerWait(wantResp, resolve, acceptPrintError); });
    try {
      await send(cmd, data);
      const res = await Promise.race([wait, sleep(timeoutMs).then(() => null)]);
      if (!res) logMsg(`⚠ no response to ${h2(cmd)} (wanted ${wantResp == null ? "any" : h2(wantResp)}) after ${timeoutMs}ms`);
      return res;
    } finally {
      clearWait(entry);
    }
  }

  async function waitForPrintReply(cmd, data, wantResp, timeoutMs, strict = false) {
    const reply = await sendWait(cmd, data, wantResp, timeoutMs, strict);
    if (!strict || reply?.cmd === wantResp) return reply;
    const error = new Error(reply ? `Printer rejected command ${h2(cmd)}: DB ${hex(reply.data)}` : `No printer reply to command ${h2(cmd)}`);
    error.niimbotCommand = cmd;
    error.niimbotCode = reply?.data[0] ?? null;
    throw error;
  }

  async function getPrintStatus(timeoutMs) {
    lastUnsolicited = null;
    let entry;
    const wait = new Promise((resolve) => { entry = registerWait(0xb3, resolve); });
    try {
      await send(0xa3, [0x01]);
      const res = await Promise.race([wait, sleep(timeoutMs).then(() => null)]);
      const r = res || (lastUnsolicited && lastUnsolicited.cmd === 0xb3 ? lastUnsolicited : null);
      if (!r || r.data.length < 4) return null;
      return { page: (r.data[0] << 8) | r.data[1], print: r.data[2], feed: r.data[3] };
    } finally {
      clearWait(entry);
    }
  }

  // ── Printer identification ──────────────────────────────────────────────────
  // The B1 and B1 Pro advertise the SAME BLE name ("B1…"), so the name can't tell
  // them apart. niim.blue asks the printer for its model id (PrinterInfo 0x40[08] →
  // 0x48, big-endian u16) and protocol version (PrinterStatusData 0xA5 → 0xB5, bytes
  // [11]*100+[12]), then picks the print task from that. We do the same to validate
  // the caller's selection. That 0xB5 reply opcode is NOT universal: the D110 answers
  // 0xB5 with too few bytes and the N1 answers 0xB4 entirely, so `protocolVersion`
  // comes back null on both and no retry changes that — identification rests on the
  // model id, not on the protocol version.
  // Every id in the table below has printed on real hardware — B1 (4096), B1 Pro
  // (4097), D11_H (528), D110 (2304), M2-H (4608), N1 (3586), B2 Pro (6912) — with
  // ONE exception: the B1 SE (4098) is listed because it shares the b1 task and has
  // never been seen on a printer here. Models outside the table are reported, not
  // enforced.
  // The actual print width comes from the registry size's `w_px` (per label), so a
  // model-level printhead figure isn't needed here and is omitted to avoid confusing
  // it with label width (e.g. the M2-H reports a 576 px head in dc[03] while
  // T50x30_m2h renders at 567 px — a deliberate ribbon margin, not the head).
  // niimbluelib has the printhead resolutions if ever needed.
  // `paced` = needs the ~10 ms gap between unacked row writes (the 203 dpi B1 drops
  // rows on a full-speed burst). `bundle` = tolerates several row frames per BLE write
  // (frame bundling) — only enabled where validated; the B1 Pro garbles/stalls on
  // bundled writes, so it stays one-frame-per-write. `pagesPerJob` = caps how many
  // pages/copies a single job actually prints on this model (the D110 acks N but only
  // prints 1, see below). All three are per-MODEL, not per-task.
  // `batteryScale` (added 2026-09-10, once niimbluelib#28 first told the two readings
  // apart) says how to read heartbeat idx2 (`chargeLevel` — see decodeHeartbeat and
  // battery() below): "percent" = the byte already IS 0-100; "enum" = it is a 0-4
  // level, the upstream's documented default (0=0%, 1=25%, 2=50%, 3=75%, 4=100%). The
  // two origins below are NOT the same kind of claim — see each entry.
  const MODEL_IDS = {
    785: { label: "NIIMBOT B21 Pro", task: "v4", dpi: 300, paced: true, bundle: false },
    4096: { label: "Niimbot B1",     task: "b1", dpi: 203, paced: true,  bundle: true,  batteryScale: "enum" },     // MEASURED 2026-09-10 against the official NIIMBOT app: chargeLevel read 4 and the app showed 100% — a percent scale would have shown 4%, so enum is what explains the reading
    4097: { label: "Niimbot B1 Pro", task: "v4", dpi: 300, paced: false, bundle: false, batteryScale: "percent" }, // MEASURED here: chargeLevel read 0x50 (80) across six captures and 0x28 (40) in another, and on that same connection 0x40[0x0a] answered the same 0x28 — consistent with a 0-100 percent, not a 0-4 level
    4098: { label: "Niimbot B1 SE",  task: "b1", dpi: 203, paced: true,  bundle: false, batteryScale: "enum" },     // "enum" is the upstream default; not verified on this model
    4608: { label: "Niimbot M2-H",   task: "b1", dpi: 300, paced: false, bundle: true,  batteryScale: "enum" },  // B1-Pro-class: b1 command sequence (per niimbluelib; v4 tested no better) + fast writes; batteryScale "enum" is the upstream default, not verified on this model
    // D11_H, discovered 2026-08-13 by open discovery (it advertises "D11_H-…", and
    // reports protocol 5). The v4 sequence PRINTS on it — solid black came out on the
    // first attempt — which is what the protocol doc predicted and nobody had tried.
    // `paced` is still the conservative default: not measured here. `bundle: true` IS
    // measured — 2026-09-11 in the small hours, on real paper, a real D11_H: with
    // `bundle: false` a real 10-page batch (99-208 frames per page,
    // `test/fixtures/qdc-etiquetas/`) came out as ZERO labels, one frame-per-write and
    // unconfirmed writes dropped silently. With `Niimbot.BUNDLE = true` (T-037) and
    // nothing else changed, the SAME batch printed whole TWICE, continuous like the
    // official app, in 10.5 s, with `rows confirmed: 259/259` on all ten pages — a
    // page's upload dropped from ~2080 ms to ~334 ms, under the ~900 ms the printer
    // takes to print one T12x22 LABEL (not one row), which is what removes the pause
    // between labels. Also
    // confirmed on the worst case tried: 3 pages of 260 distinct rows each (the
    // per-page ceiling at this height), same row-confirmation.
    528:  { label: "Niimbot D11_H", task: "v4", dpi: 300, paced: false, bundle: true,  batteryScale: "enum" },     // MEASURED 2026-09-10 against the official NIIMBOT app: chargeLevel read 3 and the app showed 75% — not a full battery, so not a scale-endpoint coincidence, confirming enum
    // D110, model id 2304, printed end to end on hardware 2026-08-14 (advertised name
    // "D110-FC06023035"). `task: "b1"` is MEASURED, not assumed. Driven as `v4` the
    // printer acked SetDensity (0x21→0x31), SetLabelType (0x23→0x33), PrintStart 9b
    // (0x01→0x02) and PrintStatus (0xa3→0xb3 = `00 00 00 00`), then went silent on
    // exactly the two commands that are v4-specific: SetPageSize 13-byte (0x13, no
    // 0x14) and PageEnd (0xe3, no 0xe4) — emitting an undocumented `0xdb` `06` at each.
    // Driven as `b1` (PageStart 0x03→0x04, SetPageSize 6-byte 0x13→0x14) every command
    // acked and the page printed. `dpi: 203` is MEASURED: 591 rows came out ≈ 73 mm →
    // 8.1 px/mm (300 dpi would have been 50 mm). `paced: true` is the mode that WORKED,
    // not a proven requirement: the b1 run wrote paced and the printer's own row
    // counter (0xd3) reached 590 of 591, so nothing was dropped — unpaced was never
    // tried on this model. `bundle: false` is the conservative default, never measured
    // here.
    // pagesPerJob: 1 — measured 2026-08-14. The D110 acks PrintStart pages=N and
    // SetPageSize copies=N exactly like any other b1-task model, but only actually
    // PRINTS the first page: a 3-copy upload prints ONE label and the page counter
    // parks at page 1 until PAGE_WAIT_MS gives up; a 3-page batch is refused mid-stream
    // with an undocumented `0xdb 06`. Three SEPARATE jobs print all three, clean. This
    // is per-MODEL, not per-task — do not add the field to another b1-task model
    // without measuring it broken the same way.
    2304: { label: "Niimbot D110",   task: "b1", dpi: 203, paced: true,  bundle: false, pagesPerJob: 1, batteryScale: "enum" },  // "enum" is the upstream default; not verified on this model
    // D110_M, model id 2320 (0x0910), advertised name e.g. "D110_M-H822021655".
    // IDENTIFIED on a real printer 2026-10-07 (connect + status only) — NEVER PRINTED.
    // Seen: 0x40[0x08] answered `09 10` = 2320; 0xb5 version bytes `03 01` = 301 =
    // protocol 4; heartbeat 11 bytes. NOT measured here (niimbluelib printer_models.ts and
    // print_tasks/index.ts, read 2026-10-07): dpi 203, printhead 96 px, and that the D110_M
    // at protocol v4 uses the `v4` sequence (otherwise `b1`). Hence task "v4" — the plain
    // D110 (2304) needed "b1", so do NOT assume this entry behaves like it.
    // paced/bundle/pagesPerJob are CONSERVATIVE choices copied from the D110's failure
    // modes, not measurements: pagesPerJob 1 because its sibling D110 prints only the
    // first page of a multi-page job. Not in INVERTED_LID_MODELS: lidClosed=true was read
    // with the lid shut.
    2320: { label: "Niimbot D110_M", task: "v4", dpi: 203, paced: true,  bundle: false, pagesPerJob: 1, batteryScale: "enum" },  // dpi/task from upstream, NOT printed here; "enum" is the upstream default, not verified
    // B2 Pro, model id 6912 (0x1B00), advertised name e.g. "B2 Pro-I304050285",
    // protocol 5. Printed end to end on hardware 2026-08-14.
    // `task: "v4"` is MEASURED: SetDensity (0x21→0x31), SetLabelType (0x23→0x33),
    // PrintStart (0x01→0x02), the 13-byte SetPageSize (0x13→0x14) and PageEnd
    // (0xe3→0xe4) all acked, and PrintEnd (0xf3→0xf4) closed the job. None of the
    // v4-specific commands went silent — that silence is the D110's tell for a wrong
    // task.
    // `dpi: 300` is MEASURED against the label itself, not read off a datasheet: a
    // 354 px tall block filled a 30 mm label exactly, and a 354 px wide block left
    // ~20 mm of white beside it. At 203 dpi the same block would have been 44 mm and
    // overrun the label.
    // No `pagesPerJob`, and that ABSENCE is measured too: `copies: 3` printed three
    // labels with the printer's own counter stepping page 1 → 2 → 3.
    // `paced: false` is NOT a measurement — it is the absence of one. The capture ran
    // `paced` only because `IS_MAC` forces it; unpaced was never tried on this unit.
    // `false` is chosen over `true` because the field's ONLY effect is
    // warnOverrideVsModel(), whose text asserts the model "NEEDS pacing … it drops rows
    // on an unpaced burst" — a claim nobody here has evidence for on this model. Do not
    // read this `false` as measured.
    // `bundle: false` is the conservative default, never measured.
    6912: { label: "Niimbot B2 Pro", task: "v4", dpi: 300, paced: false, bundle: false, batteryScale: "percent" }, // from niimbluelib#28's upstream claim; NOT measured here
    // N1, model id 3586 (0x0E02), advertised name e.g. "N1-H324110115", firmware 4.07.
    // Printed end to end on hardware 2026-08-14.
    // `task: "b1"` is MEASURED, and measured the hard way. Driven as `v4` the printer
    // acked SetDensity (0x21→0x31), SetLabelType (0x23→0x33) and PrintStart 9b
    // (0x01→0x02), then answered the 13-byte SetPageSize and PageEnd with `0xdb 06`
    // and nothing else — the same refusal signature the D110 gives for a wrong task.
    // Driven as `b1` (PrintStart 7b, PageStart 0x03→0x04, SetPageSize 6b 0x13→0x14)
    // every command acked, the page counter reached 1 at 100%/100%, and PrintEnd
    // (0xf3→0xf4) closed the job.
    // `dpi: 203` is MEASURED against the label, and it CONTRADICTS the spec sheet: the
    // N1 is SOLD AS 300 dpi. Do not "correct" this line. A row-numbered ruler printed
    // onto a 14 × 50 mm label was cut off after row 350, and row 350 landed ~45 mm down
    // a 50 mm label → ~7.8 px/mm, against 7.99 for 203 dpi. At 300 dpi (11.81 px/mm)
    // row 350 would have sat 29.6 mm down, leaving ~20 mm of blank label.
    // `paced: true` is the mode that WORKED, not a proven requirement: the capture ran
    // paced only because IS_MAC forces it, and unpaced was never tried on this model —
    // same standing as the D110 (2304) entry.
    // `bundle: false` is the conservative default, never measured here.
    // pagesPerJob: 1 — MEASURED 2026-08-14, and the printer agreed to the job first:
    // SetPageSize went out as `13 (6b) 01 90 00 60 00 03` (400 rows, 96 px, THREE
    // copies) and was acked with `14`, then `d3: 01 8f 01` reported row 399, so all 400
    // rows arrived — nothing was lost on the radio. One label printed, and the counter
    // parked at `page 1 / 100 % / 100 %` until PAGE_WAIT_MS expired and the driver
    // threw. This is per-MODEL: it says nothing about any other b1-task model that has
    // not been run the same way.
    3586: { label: "Niimbot N1",     task: "b1", dpi: 203, paced: true,  bundle: false, pagesPerJob: 1, batteryScale: "enum" },  // "enum" is the upstream default; not verified on this model
  };
  let printerInfo = null;   // { modelId, protocolVersion, label, task, dpi } after connect

  async function detectPrinter() {
    printerInfo = null;
    let modelId = null, protocolVersion = null;
    const s = await sendWait(0xa5, [0x01], 0xb5, 1000);            // PrinterStatusData (order as niim.blue)
    if (s && s.data.length >= 13) {
      const n = s.data[11] * 100 + s.data[12];
      protocolVersion = (n >= 204 && n < 300) ? 3 : (n >= 302 ? 5 : (n >= 300 ? 4 : 0));
    }
    const r = await sendWait(0x40, [0x08], 0x48, 1000);           // PrinterModelId
    if (r && r.data.length >= 1) {
      modelId = r.data.length >= 2 ? ((r.data[0] << 8) | r.data[1]) : (r.data[0] << 8);
    }
    const meta = (modelId != null && MODEL_IDS[modelId]) || null;
    printerInfo = {
      modelId, protocolVersion,
      deviceName: (device && device.name) || null,   // advertised BLE name (for filtering)
      label: meta ? meta.label : (modelId != null ? `unknown (id ${modelId})` : "unknown"),
      task: meta ? meta.task : null,
      dpi: meta ? meta.dpi : null,
    };
    logMsg(`identified ${printerInfo.label} (id=${modelId}, proto=${protocolVersion}, task=${printerInfo.task || "?"}, name="${printerInfo.deviceName || "?"}")`);
    return printerInfo;
  }

  // Throw a clear, actionable error when the selected model/size doesn't match the
  // connected printer — stops a wrong-resolution print before it starts. No-op for an
  // unidentified printer (trust the caller). Called after connect, before printing.
  function assertSelection(model, size) {
    if (!printerInfo || printerInfo.task == null) return;
    if (model && model.task && model.task !== printerInfo.task) {
      throw new Error(`Connected printer is ${printerInfo.label} (task "${printerInfo.task}", ${printerInfo.dpi} dpi), but the selected model uses task "${model.task}". Select the ${printerInfo.label} model (and a matching label size).`);
    }
    if (size && size.dpi != null && printerInfo.dpi != null && size.dpi !== printerInfo.dpi) {
      throw new Error(`Selected label size is ${size.dpi} dpi but ${printerInfo.label} prints at ${printerInfo.dpi} dpi. Pick a ${printerInfo.dpi} dpi size.`);
    }
  }

  async function connect(model) {
    if (characteristic && device && device.gatt.connected) return;
    logMsg(`Niimbot ${VERSION} — connecting (task=${(model && model.task) || "?"})`);
    // `!navigator.bluetooth` has two different causes and they need different advice.
    // `isSecureContext` is what the browser itself gates the API on, so it is the
    // one signal that tells them apart (read off `root`, the module's window/globalThis
    // — a bare `window` reference throws in the Node harnesses this file also runs
    // under). Conflating the two causes sent a real user
    // (on HTTPS) to check their connection when the actual
    // cause was Brave — which ships without Web Bluetooth, behind a flag — not
    // exposing the API at all.
    if (!navigator.bluetooth) {
      if (globalThis.isSecureContext) {
        throw new Error("This browser doesn't expose Web Bluetooth (the page is secure, so that's not the issue). Use Chrome, Edge or Opera on desktop, or Chrome on Android — Brave and some other Chromium builds ship Web Bluetooth off by default, behind a flag.");
      }
      throw new Error("Web Bluetooth unavailable (use Chrome/Edge over HTTPS).");
    }
    const prefixes = (model && model.name_prefixes) || [];
    // Filter the chooser by advertised-name prefix (known per model).
    //
    // `acceptAllDevices: true` is the DISCOVERY path, for a printer this registry does
    // not know yet — its name prefix is exactly what you are trying to find out. It was
    // removed once as "we know the names now", which was true only for the models in the
    // registry; bringing up a new one had no way in.
    //
    // NO PREFIX ⇒ discovery. It used to fall back to `{ services: [SVC_UUID] }`, which
    // LOOKS like a discovery path and is not: that filter matches the service UUID **as
    // advertised**, and these printers do not advertise it — the service only becomes
    // visible after connecting. Measured 2026-08-13: with that filter the chooser was
    // empty for a D11 *and* for a B1 Pro, a printer this driver prints with every day.
    // A filter that cannot find hardware we own is not a filter, it is a dead end.
    const req = prefixes.length
      ? { filters: prefixes.map((p) => ({ namePrefix: p })), optionalServices: [SVC_UUID] }
      : { acceptAllDevices: true, optionalServices: [SVC_UUID] };
    device = await navigator.bluetooth.requestDevice(req);
    logMsg(`device name: "${device.name || "?"}"`);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC_UUID);
    characteristic = await svc.getCharacteristic(CHAR_UUID);
    const props = characteristic.properties || {};
    writeMode = "fast";   // safe default for the tiny connect/detect packets; set per task below
    logMsg(`char props: write=${!!props.write} writeNoResp=${!!props.writeWithoutResponse}`);
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", onNotify);
    // SAY IT. The printer drops the link on its own — it powers down when idle, and BLE
    // links die for their own reasons — and this listener is the only moment anything
    // knows. Clearing `characteristic` silently meant the next call failed with a bare
    // "Not connected", several screens away from the cause, with nothing in between:
    // on a phone, where this log panel is the only trace, that is unreadable. NOT gated
    // behind DEBUG, for the same reason the connect summary line is not.
    device.addEventListener("gattserverdisconnected", () => {
      characteristic?.removeEventListener("characteristicvaluechanged", onNotify);
      const wasConnected = characteristic != null;
      characteristic = null;
      if (wasConnected) logMsg("printer disconnected (link dropped — reconnect to continue)");
    }, { once: true });
    // Initial connection packet (raw, 0x03 prefix — same as niimblue).
    await writeRaw(new Uint8Array([0x03, 0x55, 0x55, 0xc1, 0x01, 0x01, 0xc1, 0xaa, 0xaa]));
    await sleep(200);
    await detectPrinter();                 // identify B1 vs B1 Pro (same BLE name)
    // Flow control + arming follow the ACTUAL printer (detected), falling back to the
    // caller's pick when unidentified — so an identify-then-print flow (or a wrong
    // pick) still paces and arms a real B1 correctly.
    const meta = (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
    const task = (meta && meta.task) || (printerInfo && printerInfo.task) || (model && model.task);
    // Flow control is per-MODEL, not per-task. Only the 203 dpi B1 drops rows on a
    // full-speed burst, so it paces; the B1 Pro and B1-Pro-class M2-H take the unpaced
    // "fast" burst (writeNoResponse, no gap) — same as the B1 Pro path. When the model
    // is unknown, default a b1-task printer to paced (safe) and never use slow acked
    // writes unless writeNoResponse is unavailable.
    const needsPacing = meta ? !!meta.paced : (task === "b1");
    writeMode = needsPacing ? (props.writeWithoutResponse ? "paced" : "acked") : "fast";
    _bundleAllowed = !!(meta && meta.bundle);   // only bundle frames where validated (B1, M2-H)
    if (IS_MAC && writeMode === "fast") writeMode = "paced";   // macOS (and iOS — see IS_MAC) drops unacked bursts → pace the "fast" models too
    // NOT DEBUG-gated: `effective=` is the answer to "which write path did this print
    // take?", and the previous wrong conclusion about iOS was reached precisely because
    // nobody could see it. One line per connect.
    logAlways(`writeMode=${writeMode} override=${writeOverride || "auto"} effective=${effectiveWriteMode()} forcePacing=${writeOverride === "paced"} bundle=${effectiveBundle()} (detected=${_bundleAllowed}) mac=${IS_MAC} [${MAC_SOURCE}] pace=${PACE_MS} (task=${task || "?"}, model=${(meta && meta.label) || "?"}, write=${!!props.write}, writeNoResp=${!!props.writeWithoutResponse})`);
    warnOverrideVsModel();   // now that the model is identified, an override that fights it is worth saying

  }

  // Drop the BLE connection so a different printer can be paired/identified. Clears
  // all connection state (incl. the detected printerInfo); the next print reconnects.
  async function disconnect() {
    characteristic?.removeEventListener("characteristicvaluechanged", onNotify);
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); }
    catch (e) { /* already gone */ }
    characteristic = null; device = null; pendingQueue = []; lastUnsolicited = null; printerInfo = null;
    logMsg("disconnected");
  }

  // ── Bitmap: image → rows packed MSB-first (1 = black) ───────────────────────
  function imageToPacked(bmp, w, h, offsetY) {
    const dy = offsetY | 0;   // print-position calibration (paper registration, not scale — w/h stay put); dy > 0 shifts down, dy < 0 shifts up
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, dy, w, h);   // dy > 0 (e.g. T50x30_b1: +4): top dy rows stay white, bottom dy rows fall off the page.
                                       // dy < 0 (e.g. T15x50: -2): top |dy| rows of the SOURCE image are cut off, bottom |dy| rows of the page stay white.
                                       // Both directions are real hardware, not hypothetical: the B1 needed the print pushed down, the D110 needed it pulled up.
    const px = ctx.getImageData(0, 0, w, h).data;
    const stride = (w + 7) >> 3;
    const buf = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (px[i + 3] > 32 && lum < 128) buf[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { buf, stride };
  }

  function rowEmpty(buf, off, stride) {
    for (let b = 0; b < stride; b++) if (buf[off + b]) return false;
    return true;
  }
  function popcountRow(buf, off, stride) {
    let n = 0;
    for (let b = 0; b < stride; b++) { let v = buf[off + b]; while (v) { n += v & 1; v >>= 1; } }
    return n;
  }
  // Row-by-row bitmap (both tasks), grouping identical rows (run-length):
  // 0x84 (empty) / 0x85 (with pixels, count in "total mode" [00, lo, hi], repeat).
  // Verified byte-identical to niim.blue's B1 output.
  async function sendImage(buf, h, stride) {
    let r = 0;
    while (r < h) {
      const off = r * stride;
      const isVoid = rowEmpty(buf, off, stride);
      let run = 1;
      while (r + run < h && run < 200) {
        let same = true;
        const off2 = (r + run) * stride;
        for (let b = 0; b < stride; b++) if (buf[off + b] !== buf[off2 + b]) { same = false; break; }
        if (!same) break;
        run++;
      }
      if (isVoid) {
        await sendBundled(0x84, [(r >> 8) & 0xff, r & 0xff, run]);
      } else {

        const data = new Array(6 + stride);
        data[0] = (r >> 8) & 0xff; data[1] = r & 0xff; data[2] = 0;
        if (printerInfo?.modelId === 785) {
          // Three banks of 192 printhead dots, 24 packed bytes per bank.
          for (let bank = 0; bank < 3; bank++) {
            const start = bank * 24;
            data[2 + bank] = popcountRow(buf, off + start, Math.max(0, Math.min(24, stride - start)));
          }
        } else {
          const total = popcountRow(buf, off, stride);
          data[3] = total & 0xff;
          data[4] = (total >> 8) & 0xff;
        }
        data[5] = run;
        for (let b = 0; b < stride; b++) data[6 + b] = buf[off + b];
        await sendBundled(0x85, data);
      }
      r += run;
    }
    await flushBundle();   // push any rows still pending before PageEnd
  }

  // ── Job lifecycle (protocol V4) ─────────────────────────────────────────────
  // A "job" wraps one or more pages: PrintStart … (page)* … PrintEnd. The closing
  // PrintEnd (0xF3) is what makes the printer feed out + RETRACT the paper, so it
  // must run exactly once at the end — never between labels. Opening one job per
  // label (the old printOnePacked) caused a stop/retract between every label; the
  // Niimbot app keeps a single job open and streams pages back-to-back.

  // Two task variants (see registry.json `task`):
  //   "v4" (D110_M / B1 Pro / B21 Pro, protocol 4-5; independent of dpi — the D110_M is 203): PrintStart 9b
  //         (speed + page count); a single job streams N pages; status-poll paced.
  //   "b1" (B1 / B21 / D11, *protocol 3*, 203 dpi): PrintStart 7b · PageStart [1]
  //         · SetPageSize 6b [H,W,copies] (cols = printhead width 384, multiple of 8)
  //         · shared total-mode rows · PageEnd · shared status-poll + PrintEnd.
  //         Byte-for-byte as niimbluelib's B1PrintTask. Like "v4", a single job
  //         streams N pages: printStart7b declares N, each PageEnd parks the paper at
  //         the printhead waiting for the next page, and the lone PrintEnd at the end
  //         feeds it out — so a batch prints continuously, no retract between labels.
  function isB1(model) { return model && model.task === "b1"; }

  // The connected, IDENTIFIED printer's MODEL_IDS entry, or null when unidentified —
  // used to gate `pagesPerJob` (and anything else that must key off the ACTUAL printer
  // rather than the caller's selection, which can be wrong). Mirrors the same lookup
  // already used for flow control in connect() / warnOverrideVsModel().
  function connectedMeta() {
    return (printerInfo && printerInfo.modelId != null) ? MODEL_IDS[printerInfo.modelId] : null;
  }

  // Print density, 1–5, the same scale the official NIIMBOT app exposes. It is a real
  // print parameter — the same label wants more heat on some stock than on others — so
  // it belongs per JOB, not baked into the model. `opts.density` wins; `model.density`
  // from registry.json is the fallback.
  //
  // VALIDATED, not passed through: an out-of-range byte goes to the printhead, and this
  // is the one setting in the driver that controls how hard it burns. Refusing loudly
  // beats discovering the limit on hardware.
  //
  // ⚠ 1–5 is the range the official app offers. Whether every model accepts all five is
  // NOT established here — nothing in this repo has measured a per-model maximum, and
  // the registry gives all four models the same default of 3.
  function densityFor(model, opts) {
    const raw = (opts && opts.density != null) ? opts.density : (model && model.density);
    const d = Number(raw);
    if (!Number.isInteger(d) || d < 1 || d > 5) {
      throw new Error(`density must be an integer 1–5 (got ${JSON.stringify(raw)}) — the scale the official app uses`);
    }
    return d;
  }

  async function beginJob(model, totalPages, onProgress, density, strict, onStart) {
    onProgress && onProgress("configuring…");
    await waitForPrintReply(0x21, [density], 0x31, 1000, strict);
    await waitForPrintReply(0x23, [model.label_type], 0x33, 1000, strict);
    const n = Math.max(1, totalPages | 0);
    const start = isB1(model)
      ? [(n >> 8) & 0xff, n & 0xff, 0, 0, 0, 0, 0]                          // printStart 7b
      : [(n >> 8) & 0xff, n & 0xff, 0, 0, 0, 0, 0, model.speed, 0];         // printStart 9b (…, speed, flag)
    onStart?.();
    await waitForPrintReply(0x01, start, 0x02, 2000, strict);
  }

  // Queue one page's data within an open job — does NOT wait for it to print, so the
  // next page can be sent while this one is still printing. That keeps the printer
  // buffer primed when the send can keep up; in "paced" on dense pages it cannot (see
  // the header block), and the printer idles between labels waiting for data.
  //
  // `deferAck`, used only by printBatch's PAGE_PIPELINE path: when true, PageEnd
  // (0xE3) is still sent here, but its ack (0xE4) is NOT awaited — the function
  // returns as soon as the write goes out, wrapped as `{ ackPromise }` (an OBJECT,
  // not the promise itself: an async function that RETURNED a bare Promise would have
  // its own promise adopt it, and `await sendPagePacked(...)` would then block on the
  // ack anyway, silently undoing the deferral). The caller awaits `ackPromise` later,
  // once every page has been sent — see sendPageEndAsync below.
  async function sendPagePacked(model, size, buf, stride, copies, onProgress, tag, deferAck, strict) {
    const W = size.w_px, H = size.h_px;
    resetRowsSeen();   // 0xD3 tracking is per PAGE, not per job — see its declaration above
    const c = Math.max(1, copies | 0);   // printer repeats this page `c` times from one upload
    if (isB1(model)) {
      await sendWait(0x03, [0x01], 0x04, 1000);                             // PageStart (B1 only)
      await waitForPrintReply(0x13, [
        (H >> 8) & 0xff, H & 0xff, (W >> 8) & 0xff, W & 0xff, (c >> 8) & 0xff, c & 0xff,
      ], 0x14, 2000, strict);
    } else {
      await send(0xa3, [0x01]); await sleep(30);                           // PrintStatus (one-way)
      await waitForPrintReply(0x13, [
        (H >> 8) & 0xff, H & 0xff, (W >> 8) & 0xff, W & 0xff,
        (c >> 8) & 0xff, c & 0xff, 0, 0, 0, 0, 0, 0, 0,
      ], 0x14, 2000, strict);
    }

    onProgress && onProgress("sending image…");
    await sendImage(buf, H, stride);                                         // shared total-mode 0x84/0x85 encoder

    // PAGE_PIPELINE only: the 0xD3 row-check below (see rowsProblem) is deliberately
    // SKIPPED for this path, by returning before it runs. Under pipelining the next
    // page's sendPagePacked call — and its resetRowsSeen() — can run before this page's
    // PageEnd ack (and any 0xD3 that rides with it) has actually arrived, so the max
    // this function would see could belong to the wrong page. An alarm attributed to the
    // wrong page is worse than no alarm (docs/TASKS.md T-038), so PAGE_PIPELINE gets
    // neither — see the diagnostic's own caveats at the PAGE_PIPELINE declaration below.
    if (deferAck) return { ackPromise: sendPageEndAsync(tag) };

    // RETURN whether PageEnd was acknowledged. Discarding this is how a page that the
    // printer never confirmed still got logged as buffered and acked, directly under the
    // ⚠ warning saying it had not been.
    const ackT0 = Date.now();
    const pageEnd = await waitForPrintReply(0xe3, [0x01], 0xe4, PAGE_ACK_MS, strict);
    const ackMs = Date.now() - ackT0;
    const prefix = tag ? `${tag}: ` : "";
    tlog(pageEnd != null
      ? `${prefix}PageEnd acked in ${ackMs} ms`
      : `${prefix}PageEnd UNACKED after ${ackMs} ms (PAGE_ACK_MS)`);
    // Only once PageEnd itself is confirmed does the row-received counter get to speak —
    // an unacked PageEnd is already the unconfirmed path above/below this function's
    // callers. This is what catches the truncated-but-100%-reported upload: PageEnd can
    // be acked while rows were still dropped underneath it (measured on a D11_H,
    // 2026-09-10, "paced" — see docs/TASKS.md T-038 and docs/NOTES.md).
    if (pageEnd != null) {
      const rowsErr = rowsProblem(H, tag);
      if (rowsErr) {
        if (!strict) await endJob();
        throw rowsErr;
      }
    }
    return pageEnd != null;
  }

  // PAGE_PIPELINE only: fire PageEnd (0xE3) and register its wait, but do not block
  // on the reply — return a promise that resolves once the ack arrives or PAGE_ACK_MS
  // expires, so the caller can send the NEXT page's data first. Same logging and same
  // true/false result as the inline wait in sendPagePacked above; only the point where
  // the caller awaits it moves.
  async function sendPageEndAsync(tag) {
    const ackT0 = Date.now();
    const pageEnd = await sendWait(0xe3, [0x01], 0xe4, PAGE_ACK_MS);          // PageEnd (0xE3)
    const ackMs = Date.now() - ackT0;
    const prefix = tag ? `${tag}: ` : "";
    tlog(pageEnd != null
      ? `${prefix}PageEnd acked in ${ackMs} ms`
      : `${prefix}PageEnd UNACKED after ${ackMs} ms (PAGE_ACK_MS)`);
    return pageEnd != null;
  }

  // How long to wait for ONE page's PageEnd ack (0xE3 → 0xE4) before giving up on that
  // single page — see sendPagePacked above. This is NOT PAGE_WAIT_MS below: that one is
  // the deadline for the whole job's printed-page COUNTER (see waitPage), a different
  // wait entirely, and confusing the two is exactly the mistake this task exists to fix.
  // 10000 is chosen WITH MARGIN over the distribution measured on the D11_H (docs/NOTES.md,
  // 2026-09-10): ten PageEnd acks in a 10-page batch landed between 2057 and 2684 ms, and an
  // earlier attempt on the same printer exceeded the old 3000 default by ~70 ms and killed
  // the job. Erring high only costs waiting longer before declaring a page the printer is
  // never going to confirm.
  let PAGE_ACK_MS = 10000;

  // DIAGNOSTIC, under measurement — default OFF. When true, printBatch's single-job
  // streaming loop sends the next page's data WITHOUT waiting for the current page's
  // PageEnd ack (0xE4) first; every ack is instead collected and awaited before
  // PrintEnd (see the PAGE_PIPELINE branch in printBatch). Motivated by a D11_H
  // measurement (docs/NOTES.md, 2026-09-10): the PageEnd ack alone costs 2.0-2.7 s per
  // page, the driver sends nothing during that wait, and the printer visibly stops and
  // dries between labels — no retraction, so it is not the "job over" pause. The
  // official app prints 4 DIFFERENT labels emended together, and this driver's own
  // `copies:4` (one upload, no per-page PageEnd in between) also comes out continuous,
  // which is evidence the hardware is not what is imposing the stop.
  // It stays a diagnostic and not a setting because nobody has yet confirmed on paper
  // that the printer accepts the next page while the previous page's ack is still
  // outstanding — it might silently drop or corrupt it instead. The guarantee that
  // must hold either way: any page whose ack never comes back still ends the job as
  // unconfirmed, PrintEnd sent first, throw after — same as with the flag off.
  let PAGE_PIPELINE = false;

  // How long to wait for the printed-page counter to reach a target before giving up.
  // Exposed because a test cannot afford to sit through the real value, and because an
  // unusually slow consumable is a legitimate reason to raise it.
  let PAGE_WAIT_MS = 25000;

  // Poll until the cumulative printed-page counter (0xB3) reaches `target`.
  // Used both to throttle the look-ahead and to drain at end of job.
  //
  // RETURNS true if the counter reached the target, false if the deadline passed.
  // It used to `return` from inside the loop and also fall out of it, so "printed" and
  // "gave up" were the same answer — which is how a job that stalled at page 4 of 5 was
  // reported as "all 5 pages printed" and resolved as success (measured 2026-08-13).
  // `_pageSeen` keeps the last counter value so the caller can say what it stalled at.
  let _lastPage = -1;   // last printed-page counter seen, for the timing trace
  let _pageSeen = null; // last counter value observed by waitPage, for error messages
  async function waitPage(target, onProgress) {
    onProgress && onProgress("printing…");
    const t0 = Date.now();
    _pageSeen = null;
    while (Date.now() - t0 < PAGE_WAIT_MS) {
      const st = await getPrintStatus(900);
      if (st) {
        _pageSeen = st.page;
        if (st.page !== _lastPage) { tlog(`printer counter → page ${st.page} (print ${st.print}%, feed ${st.feed}%)`); _lastPage = st.page; }
        onProgress && onProgress(`printing… ${st.print}%`);
        if (st.page >= target) return true;
      }
      await sleep(150);
    }
    return false;
  }

  // Build the message for a job that could not be confirmed. It names the numbers
  // because "print failed" would repeat the very mistake this path exists to fix: the
  // caller needs to know it stalled at page 4 of 5, and that the paper was fed out.
  function unconfirmed(reason) {
    return new Error(`print not confirmed: ${reason}. PrintEnd was sent, so the paper has been fed out — check the labels, they may be blank, short or repeated.`);
  }

  // Called ONLY once PageEnd itself has been acked (see sendPagePacked) — an unacked
  // PageEnd is already handled as unconfirmed elsewhere. Compares the highest 0xD3 row
  // index seen on this page (_rowsSeenMax, reset per page — see its declaration) against
  // `h`, the page height in rows. 0xD3's index is 0-based, so full reception is
  // `_rowsSeenMax === h - 1`.
  //
  // Returns an Error to throw, or null in TWO different-meaning cases that must stay
  // distinguishable in the log (docs/TASKS.md T-038's "distinguish FAILED from COULD NOT
  // VERIFY"): no 0xD3 at all (most models never emit it — nothing here can say whether
  // the page is complete) vs. a 0xD3 that confirms every row arrived.
  function rowsProblem(h, tag) {
    const prefix = tag ? `${tag}: ` : "";
    const wantIdx = h - 1;
    if (_rowsSeenMax === null) {
      tlog(`${prefix}no 0xD3 seen; upload not verified`);
      return null;
    }
    if (_rowsSeenMax >= wantIdx) {
      tlog(`${prefix}rows confirmed: ${_rowsSeenMax}/${wantIdx}`);
      return null;
    }
    return unconfirmed(`${prefix}printer's 0xD3 counter last reached row ${_rowsSeenMax}, but the page needed row ${wantIdx} — the label may have come out short`);
  }

  async function endJob(strict) {
    await waitForPrintReply(0xf3, [0x01], 0xf4, 2500, strict);
    // B21 Pro may drop the first packet after PrintEnd (niimbluelib D110MV4PrintTask).
    if (printerInfo?.modelId === 785) await send(0xdc, [0x01]);
  }

  // Finalize the job: poll the printed-page counter to `target` (so PrintEnd doesn't
  // arrive mid-print and cut a label), then PrintEnd. `target` = copies for a single
  // image (printer repeats it), so we wait for all copies before feeding out.
  //
  // ORDER MATTERS: PrintEnd goes out even when the wait failed, because PrintEnd is what
  // feeds out and RETRACTS the paper. Skipping it on the error path would leave the label
  // parked under the printhead. Only after it is sent does the failure become a throw.
  async function finishJob(model, target, onProgress) {
    const want = Math.max(1, target | 0);
    const reached = await waitPage(want, onProgress);
    await endJob();
    if (!reached) {
      throw unconfirmed(`printer counter stopped at page ${_pageSeen == null ? "?" : _pageSeen} of ${want} after ${PAGE_WAIT_MS}ms`);
    }
  }

  async function printConfirmedImage(model, size, buf, stride, copies, onProgress, density) {
    let cleanupNeeded = false;
    try {
      await beginJob(model, copies, onProgress, density, true, () => { cleanupNeeded = true; });
      await sendPagePacked(model, size, buf, stride, copies, onProgress, undefined, false, true);
      const reached = await waitPage(copies, onProgress);
      cleanupNeeded = false;
      await endJob(true);
      if (!reached) {
        throw unconfirmed(`printer counter stopped at page ${_pageSeen == null ? "?" : _pageSeen} of ${copies} after ${PAGE_WAIT_MS}ms`);
      }
    } catch (error) {
      if (cleanupNeeded) {
        try { await endJob(); } catch {}
      }
      throw error;
    }
    onProgress?.("ok");
  }

  return async function print(canvas, model, size, beforePrint) {
    try {
      await connect(model);
      if (![528, 785].includes(model.id) || printerInfo?.modelId !== model.id) {
        throw new Error(`Выберите принтер NIIMBOT ${model.name}.`);
      }
      assertSelection(model, size);
      beforePrint();
      const { buf, stride } = imageToPacked(canvas, size.w_px, size.h_px, size.offset_y_px);
      await printConfirmedImage(model, size, buf, stride, 1, null, densityFor(model, {}));
    } finally {
      await disconnect();
    }
  };
}

export function printLabel(canvas, model, size, beforePrint) {
  return createInstance()(canvas, model, size, beforePrint);
}
