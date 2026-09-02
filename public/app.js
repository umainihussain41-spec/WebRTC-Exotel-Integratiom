/* =========================================================================
   Exotel Softphone — front-end logic
   -------------------------------------------------------------------------
   In-browser calling (WebRTC) via the Exotel CRM WebSDK: real audio in the tab,
   outgoing and incoming.

   The WebSDK is loaded from vendor/exotel-websdk.bundle.js and is available
   as  window.ExotelCRMWebSDK.

   Every call is recorded. That is an Exotel APP-level setting (`record: true`,
   set by `npm run provision`), not something this page passes per call — the
   SDK's MakeCall payload has no record field.

   IMPORTANT — how an Exotel outgoing browser call actually works:
     webPhone.MakeCall(number) does NOT dial from the browser. It asks Exotel
     to place the call, and Exotel then rings THIS browser's SIP device with a
     normal INVITE. So an outgoing call arrives back here as an "incoming"
     event. We remember that we started the call (state.pendingOutbound) and
     answer that leg automatically, so the agent never sees an "incoming call"
     popup for a number they just dialled.
   ========================================================================= */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    themeToggle: $("themeToggle"),
    identityAgent: $("identityAgent"),
    signal: $("signal"),

    notice: $("notice"),
    noticeText: $("noticeText"),
    noticeAction: $("noticeAction"),

    numRow: $("numRow"),
    number: $("numberInput"),
    backspace: $("backspace"),
    padToggle: $("padToggle"),
    padToggle2: $("padToggle2"),
    dialpad: $("dialpad"),

    metaRow: $("metaRow"),
    metaDirection: $("metaDirection"),
    metaVia: $("metaVia"),

    callStateWrap: $("callStateWrap"),
    callState: $("callState"),
    callTimer: $("callTimer"),
    peerName: $("peerName"),

    inCallControls: $("inCallControls"),
    muteBtn: $("muteBtn"),
    holdBtn: $("holdBtn"),

    idleControls: $("idleControls"),
    dialBtn: $("dialBtn"),
    hangupControls: $("hangupControls"),
    hangupBtn: $("hangupBtn"),
    incomingControls: $("incomingControls"),
    acceptBtn: $("acceptBtn"),
    rejectBtn: $("rejectBtn"),

    toggleLog: $("toggleLog"),
    logDrawer: $("logDrawer"),
    logList: $("logList"),
    clearLog: $("clearLog"),

    incomingModal: $("incomingModal"),
    incomingNumber: $("incomingNumber"),
    incomingVia: $("incomingVia"),
    modalAccept: $("modalAccept"),
    modalReject: $("modalReject"),
    modalSilence: $("modalSilence"),

    soundGate: $("soundGate"),
    gateBtn: $("gateBtn"),
    gateBody: $("gateBody"),
    gateFoot: $("gateFoot"),
  };

  // How long to wait for Exotel to ring this browser back after MakeCall.
  const OUTBOUND_INVITE_TIMEOUT_MS = 45000;

  const state = {
    webPhone: null,
    deviceReady: false,
    callActive: false,       // media is up (SDK fired "connected")
    pendingOutbound: false,  // MakeCall sent; waiting for Exotel's INVITE
    outboundTimer: null,
    incoming: false,         // a genuine inbound call is ringing
    abortedOutboundUntil: 0, // hung up mid-dial; drop Exotel's late INVITE
    lastCallError: null,     // real reason recovered from Exotel's response body
    dialedNumber: null,      // what we dialled, for display during an outbound call
    muted: false,
    onHold: false,
    timerId: null,
    seconds: 0,
    padOpen: true,
    callerId: "",
  };

  /* ================= serverless cold starts =================
     Railway is set to sleep this service after a few idle minutes (service
     Settings > Deploy > Serverless). Two consequences the UI has to absorb:

       1. The first request to a sleeping service can come back 502/503/504,
          or drop outright, while the container boots. The same request a
          moment later succeeds, so backend calls go through wakeFetch().

       2. Exotel carries call media browser-to-Exotel directly; this server
          sees no traffic at all while a call is up. A long call therefore
          looks idle and the service would sleep mid-call, so the requests we
          make when it ends would fail. keepAwake() pings /healthz for as long
          as a call is on screen, and stops the moment we are idle again. */

  const WAKE_BACKOFF_MS = [400, 1200, 2500, 4000];

  async function wakeFetch(url, opts) {
    let lastErr = null;
    for (let attempt = 0; attempt <= WAKE_BACKOFF_MS.length; attempt++) {
      if (attempt) {
        if (attempt === 1) log("Server is asleep — waking it up...", "warn");
        setSignal("wait");
        await new Promise((r) => setTimeout(r, WAKE_BACKOFF_MS[attempt - 1]));
      }
      try {
        const r = await fetch(url, opts);
        // A 502/503/504 here is the edge proxy, not the app: still booting.
        if (r.status === 502 || r.status === 503 || r.status === 504) {
          lastErr = new Error("cold start " + r.status);
          continue;
        }
        return r;
      } catch (err) {
        lastErr = err;  // a sleeping service can also refuse the connection
      }
    }
    throw lastErr || new Error("unreachable");
  }

  // Comfortably inside the ~5 min of silence Railway needs before it sleeps.
  const KEEPALIVE_MS = 120000;
  let keepAliveId = null;

  function keepAwake(on) {
    if (on === !!keepAliveId) return;
    if (on) {
      keepAliveId = setInterval(() => {
        fetch("/healthz", { cache: "no-store" }).catch(() => {});
      }, KEEPALIVE_MS);
    } else {
      clearInterval(keepAliveId);
      keepAliveId = null;
    }
  }

  /* ======================================================================
     Ringer — synthesised so it needs no audio assets and cannot 404.
     Browsers block audio until the user has interacted with the page, so the
     AudioContext is created/resumed from the mic gate click (see micGate).
     ====================================================================== */
  const ringer = (() => {
    let ctx = null;
    let cycleTimer = null;
    let kind = null;
    const live = new Set();       // currently sounding oscillator/gain pairs
    const duckedEls = new Set();  // SDK <audio> elements we silenced

    function audio() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!ctx) {
        try { ctx = new AC(); } catch (e) { return null; }
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }

    // A shaped burst — ramped so it doesn't click on start/stop.
    function tone(freqs, at, dur, peak) {
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.02);
      gain.gain.setValueAtTime(peak, at + dur - 0.03);
      gain.gain.linearRampToValueAtTime(0, at + dur);
      freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start(at);
        osc.stop(at + dur + 0.03);
        const pair = { osc, gain };
        live.add(pair);
        osc.onended = () => live.delete(pair);
      });
    }

    // Incoming: the familiar double burst. Outgoing: a single long ringback.
    function ringCycle() {
      const t = ctx.currentTime;
      tone([440, 480], t, 0.4, 0.11);
      tone([440, 480], t + 0.6, 0.4, 0.11);
    }
    function ringbackCycle() {
      tone([400, 450], ctx.currentTime, 1.0, 0.05);
    }

    function start(which) {
      if (kind === which) return;
      stop();
      if (!audio()) return;
      kind = which;
      const cycle = which === "ring" ? ringCycle : ringbackCycle;
      try { cycle(); } catch (e) { return; }
      cycleTimer = setInterval(() => {
        try { cycle(); } catch (e) { stop(); }
      }, which === "ring" ? 3000 : 4000);
    }

    function stop() {
      if (cycleTimer) clearInterval(cycleTimer);
      cycleTimer = null;
      kind = null;
      if (ctx) {
        const now = ctx.currentTime;
        live.forEach(({ osc, gain }) => {
          try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(gain.gain.value, now);
            gain.gain.linearRampToValueAtTime(0, now + 0.05);
            osc.stop(now + 0.06);
          } catch (e) {}
        });
        live.clear();
      }
      // Give the SDK's own sounds their volume back.
      duckedEls.forEach((node) => { try { node.volume = 1; } catch (e) {} });
      duckedEls.clear();
    }

    function duck(node) { duckedEls.add(node); }
    function unlock() { audio(); }

    return { start, stop, unlock, duck, get kind() { return kind; } };
  })();

  // The SDK plays its own ringtone on detached <audio> elements. While our
  // ringer is running, silence those so the two don't beat against each other.
  // Volumes are restored by ringer.stop(), so call audio can never stay muted.
  function installSdkAudioSuppressor() {
    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || proto.__exoPatched) return;
    const origPlay = proto.play;
    proto.play = function () {
      if (ringer.kind && !this.isConnected) {
        try { this.volume = 0; ringer.duck(this); } catch (e) {}
      }
      return origPlay.apply(this, arguments);
    };
    proto.__exoPatched = true;
  }

  /* ================= small utilities ================= */
  function log(message, level = "") {
    const empty = el.logList.querySelector(".log-empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="t">${new Date().toTimeString().slice(0, 8)}</span>` +
      `<span class="${level ? "lv-" + level : ""}"></span>`;
    li.lastChild.textContent = message;
    el.logList.prepend(li);
    while (el.logList.children.length > 80) el.logList.lastChild.remove();
  }

  function setSignal(s) { el.signal.dataset.state = s; }

  function setNotice(text, tone, actionLabel, onAction) {
    if (!text) { el.notice.hidden = true; return; }
    el.notice.hidden = false;
    el.notice.dataset.tone = tone || "warn";
    el.noticeText.textContent = text;
    if (actionLabel) {
      el.noticeAction.hidden = false;
      el.noticeAction.textContent = actionLabel;
      el.noticeAction.onclick = onAction || null;
    } else {
      el.noticeAction.hidden = true;
      el.noticeAction.onclick = null;
    }
  }

  const icon = (id) => `<svg><use href="#${id}"/></svg>`;

  function setCallState(text, iconId, tone) {
    el.callState.innerHTML = `${icon(iconId)}<span></span>`;
    el.callState.lastChild.textContent = text;
    el.callStateWrap.dataset.tone = tone || "live";
  }

  function fmtTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return h ? `${h}:${m}:${ss}` : `${m}:${ss}`;
  }

  function startTimer() {
    stopTimer();
    state.seconds = 0;
    el.callTimer.textContent = "00:00";
    state.timerId = setInterval(() => {
      state.seconds += 1;
      el.callTimer.textContent = fmtTime(state.seconds);
    }, 1000);
  }
  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  /* ================= phases =================
     Exactly one action group is ever visible. */
  function showPhase(phase) {
    const busy = phase !== "idle";
    el.numRow.hidden = busy;
    el.metaRow.hidden = !busy;
    el.callStateWrap.hidden = !busy;

    el.idleControls.hidden = phase !== "idle";
    el.hangupControls.hidden = !(phase === "dialing" || phase === "incall");
    el.incomingControls.hidden = phase !== "incoming";
    el.inCallControls.hidden = !(phase === "dialing" || phase === "incall");

    // Mute/Hold only mean something once there is real media.
    const canToggle = phase === "incall";
    el.muteBtn.disabled = !canToggle;
    el.holdBtn.disabled = !canToggle;

    // Keypad: shown while idle (to dial) and in-call (to send DTMF).
    el.dialpad.hidden = !(state.padOpen && phase !== "incoming");
    updateDialAvailability();

    // Hold the server open for as long as anything is on the line.
    keepAwake(busy);
  }

  function resetCallUI() {
    state.callActive = false;
    state.incoming = false;
    state.pendingOutbound = false;
    state.dialedNumber = null;
    state.muted = false;
    state.onHold = false;
    clearOutboundTimer();
    stopTimer();
    ringer.stop();
    hideIncomingModal();
    el.muteBtn.classList.remove("on");
    el.holdBtn.classList.remove("on");
    el.muteBtn.innerHTML = `${icon("i-mic")}<em>Mute</em>`;
    el.holdBtn.innerHTML = `${icon("i-pause")}<em>Hold</em>`;
    el.callTimer.textContent = "00:00";
    showPhase("idle");
  }

  function clearOutboundTimer() {
    if (state.outboundTimer) clearTimeout(state.outboundTimer);
    state.outboundTimer = null;
  }

  function updateDialAvailability() {
    el.dialBtn.disabled = !state.deviceReady;
    el.dialBtn.title = state.deviceReady ? "Call" : "The browser line is not registered yet.";
  }

  /* ================= theme ================= */
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem("dialer-theme"); } catch (e) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    el.themeToggle.addEventListener("click", () => {
      // Light is the default and the OS preference is ignored, so the toggle
      // is a straight flip rather than a guess at what's currently showing.
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("dialer-theme", next); } catch (e) {}
    });
  })();

  /* ================= keypad ================= */
  function togglePad() {
    state.padOpen = !state.padOpen;
    el.padToggle.classList.toggle("off", !state.padOpen);
    showPhase(currentPhase());
  }
  function currentPhase() {
    if (state.incoming) return "incoming";
    if (state.callActive) return "incall";
    if (state.pendingOutbound) return "dialing";
    return "idle";
  }
  el.padToggle.addEventListener("click", togglePad);
  el.padToggle2.addEventListener("click", togglePad);

  el.dialpad.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-key]");
    if (!btn) return;
    const key = btn.dataset.key;
    // Only a *connected* call can take DTMF. While dialling there is no media
    // yet, so keys keep editing the number instead.
    if (state.callActive && state.webPhone && typeof state.webPhone.SendDTMF === "function") {
      try {
        state.webPhone.SendDTMF(key);
        log(`Sent tone: ${key}`);
      } catch (err) {
        log(`DTMF failed: ${err}`, "error");
      }
      return;
    }
    el.number.value += key;
  });

  el.backspace.addEventListener("click", () => {
    el.number.value = el.number.value.slice(0, -1);
  });

  /* ================= microphone ================= */
  // Browsers only surface the permission prompt after a user gesture, and the
  // same gesture is what lets us play sound. So we ask explicitly rather than
  // letting the SDK trigger a surprise prompt mid-call.
  async function requestMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { ok: false, reason: "unsupported" };
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.name) || "error" };
    }
  }

  function micBlockedNotice() {
    setNotice(
      "Microphone blocked — you won't be heard. Allow it from the padlock in the address bar.",
      "error",
      "Retry",
      () => openMicGate(true)
    );
  }

  function openMicGate(retry) {
    el.soundGate.hidden = false;
    el.gateFoot.textContent = "";
    if (retry) {
      el.gateBody.innerHTML =
        "Your browser is currently refusing the microphone. Open the padlock " +
        "icon in the address bar, set <strong>Microphone</strong> to " +
        "<strong>Allow</strong>, then click below.";
    }
  }

  async function onGateClick() {
    ringer.unlock(); // this click is also what unblocks audio playback
    el.gateFoot.textContent = "Waiting for your browser's permission prompt…";
    const res = await requestMic();
    if (res.ok) {
      el.soundGate.hidden = true;
      setNotice(null);
      log("Microphone ready", "ok");
      return;
    }
    if (res.reason === "unsupported") {
      el.gateFoot.textContent = "This browser has no microphone API. Use HTTPS or localhost.";
    } else if (res.reason === "NotAllowedError") {
      el.gateFoot.textContent = "Permission denied. Allow the microphone from the padlock icon, then retry.";
    } else if (res.reason === "NotFoundError") {
      el.gateFoot.textContent = "No microphone found. Plug in a headset and retry.";
    } else {
      el.gateFoot.textContent = `Could not open the microphone (${res.reason}).`;
    }
    log(`Microphone unavailable: ${res.reason}`, "error");
  }
  el.gateBtn.addEventListener("click", onGateClick);

  // Decide up front whether we need to show the gate at all.
  async function primeMicrophone() {
    if (!window.isSecureContext) {
      setNotice(
        "This page is not on HTTPS, so the browser will not allow microphone access.",
        "error"
      );
      log("Insecure context — WebRTC needs HTTPS (or localhost).", "error");
      return;
    }
    let perm = null;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        perm = await navigator.permissions.query({ name: "microphone" });
      }
    } catch (e) {}

    if (perm && perm.state === "granted") {
      const res = await requestMic();
      if (res.ok) log("Microphone ready", "ok");
      ringer.unlock();
      return;
    }
    if (perm && perm.state === "denied") {
      micBlockedNotice();
      openMicGate(true);
      return;
    }
    // "prompt", or a browser without the Permissions API: ask via the gate so
    // the click also unlocks audio for the ringer.
    openMicGate(false);
  }

  /* ================= call-failure reasons ================= */
  // The WebSDK reports MakeCall failures as `new Error(response.statusText)`,
  // but Exotel's API is served over HTTP/2 where statusText is always empty —
  // so the agent just sees "Error". Sniff the failing response body to recover
  // the real reason (insufficient balance, bad number, …) without patching the
  // vendored SDK.
  function explainExotelError(text, httpStatus) {
    let msg = "";
    try {
      const outer = JSON.parse(text);
      let inner = outer.Error;
      if (typeof inner === "string") {
        try { inner = JSON.parse(inner); } catch (e) { msg = inner; }
      }
      const ed = inner && inner.response && inner.response.error_data;
      if (ed) msg = ed.description || ed.message || msg;
    } catch (e) {}
    if (!msg && httpStatus === 402) msg = "Insufficient balance — recharge the Exotel account.";
    return msg || `Exotel rejected the call (HTTP ${httpStatus}).`;
  }

  function installCallErrorSniffer() {
    const orig = window.fetch;
    window.fetch = async function (...args) {
      const res = await orig.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (!res.ok && url.indexOf("/call/outbound_call") !== -1) {
          state.lastCallError = explainExotelError(await res.clone().text(), res.status);
        }
      } catch (e) {}
      return res;
    };
  }

  /* ================= WebRTC ================= */
  async function initWebrtc(config) {
    if (!window.ExotelCRMWebSDK) {
      setSignal("err");
      setNotice("Calling library failed to load. Run: npm run build:sdk", "error");
      log("window.ExotelCRMWebSDK is undefined — bundle not loaded.", "error");
      return;
    }
    setSignal("wait");
    let tokenResp;
    try {
      const r = await wakeFetch("/api/webrtc/token", { method: "POST" });
      tokenResp = await r.json();
    } catch (err) {
      setSignal("err");
      setNotice("Could not reach the token server.", "error");
      log(`Token request failed: ${err}`, "error");
      return;
    }
    if (!tokenResp.ok) {
      setSignal("err");
      setNotice("Exotel rejected the access token.", "error");
      log(`Token error: ${tokenResp.error || "unknown"}`, "error");
      return;
    }
    if (tokenResp.expiresAt) {
      const days = Math.round((new Date(tokenResp.expiresAt) - Date.now()) / 86400000);
      log(`Access token valid for ~${days} day(s).`);
    }
    const userId = tokenResp.userId || config.webrtcUserId;
    if (!userId) {
      setSignal("err");
      setNotice("No browser-calling agent configured.", "warn");
      log("EXOTEL_WEBRTC_USER_ID is empty. Set the agent email in .env and run: npm run provision", "warn");
      return;
    }

    log(`Initializing WebSDK for user: ${userId}`);
    installCallErrorSniffer();
    try {
      // The SDK drops the user id straight into a query string without
      // encoding it (`...usermapping?user_id=${agentUserID}`). A plus-addressed
      // email like  name+webrtc@gmail.com  therefore arrives at Exotel with the
      // "+" decoded as a space, the lookup 404s, and Initialize() returns void.
      // Pre-encoding here fixes it without touching the vendored bundle — the
      // SDK only uses this value for that URL, and builds its User object from
      // the response body.
      const sdk = new window.ExotelCRMWebSDK(tokenResp.accessToken, encodeURIComponent(userId), true);
      const webPhone = await sdk.Initialize(handleCallEvents, handleRegistration, handleSession);
      if (!webPhone) {
        setSignal("err");
        setNotice("Could not start the browser line (check agent provisioning).", "error");
        log("Initialize() returned void — usually means the user mapping was not found.", "error");
        return;
      }
      state.webPhone = webPhone;
      window.addEventListener("pagehide", () => {
        try { webPhone.UnRegisterDevice(); } catch (e) {}
      });
    } catch (err) {
      setSignal("err");
      setNotice("Browser line failed to start.", "error");
      log(`Initialize error: ${err}`, "error");
    }
  }

  // "registered" | "unregistered" | "sent_request"
  function handleRegistration(event) {
    log(`Device: ${event}`);
    if (event === "registered") {
      state.deviceReady = true;
      setSignal("on");
      setNotice(null);
    } else if (event === "sent_request") {
      setSignal("wait");
    } else if (event === "unregistered") {
      state.deviceReady = false;
      setSignal("err");
      setNotice("Browser line offline — reconnecting…", "warn");
      setTimeout(() => {
        if (!state.deviceReady && state.webPhone) {
          try { state.webPhone.RegisterDevice(); } catch (e) {}
        }
      }, 5000);
    }
    updateDialAvailability();
  }

  function handleSession(sessionState) {
    const s = String(sessionState || "");
    if (s.indexOf("permission_denied") !== -1) {
      log("Microphone permission denied — allow the mic to make calls.", "error");
      micBlockedNotice();
    } else if (s.indexOf("ice_connection_state_failed") === 0) {
      log("Media path failed (ICE). Check firewall/VPN — WebRTC needs UDP out.", "error");
    }
  }

  /* ================= incoming popup ================= */
  function showIncomingModal(from) {
    el.incomingNumber.textContent = from;
    el.incomingVia.textContent = state.callerId ? `via ${state.callerId}` : "";
    el.incomingModal.hidden = false;
  }
  function hideIncomingModal() {
    el.incomingModal.hidden = true;
  }

  /* ================= call events ================= */
  function handleCallEvents(eventType, callData) {
    switch (eventType) {
      case "incoming": {
        const from = (callData && (callData.callFromNumber || callData.remoteId)) || "Unknown";

        // The agent hung up while we were still dialling. Exotel's INVITE for
        // that abandoned attempt can still land — drop it rather than show it
        // as a surprise inbound call.
        if (Date.now() < state.abortedOutboundUntil) {
          state.abortedOutboundUntil = 0;
          log("Dropped the return leg of the cancelled outgoing call.");
          try { state.webPhone.HangupCall(); } catch (e) {}
          break;
        }

        // Exotel ringing us back for a call WE placed — answer it silently so
        // the agent simply hears the far end start ringing.
        if (state.pendingOutbound) {
          clearOutboundTimer();
          setCallState("Connecting", "i-phone", "wait");
          log("Exotel connected the outgoing leg — answering automatically.");
          try {
            state.webPhone.AcceptCall();
          } catch (err) {
            log(`Auto-answer failed: ${err}`, "error");
            resetCallUI();
          }
          break;
        }

        state.incoming = true;
        el.peerName.textContent = from;
        el.metaDirection.innerHTML = `${icon("i-in")}<span>Inbound call</span>`;
        el.metaVia.innerHTML = `${icon("i-phone")}<span></span>`;
        el.metaVia.lastChild.textContent = state.callerId || "—";
        setCallState("Ringing", "i-phone", "wait");
        el.callTimer.textContent = "00:00";
        showPhase("incoming");
        showIncomingModal(from);
        ringer.start("ring");
        log(`Incoming call from ${from}`, "ok");
        break;
      }
      case "connected": {
        state.callActive = true;
        state.incoming = false;
        state.pendingOutbound = false;
        clearOutboundTimer();
        ringer.stop();
        hideIncomingModal();
        // On an outbound call the SIP remoteId is our OWN device id, so show
        // the number the agent actually dialled instead.
        el.peerName.textContent =
          state.dialedNumber ||
          (callData && (callData.callFromNumber || callData.remoteId)) ||
          el.number.value ||
          "Connected";
        setCallState("Talking", "i-phone", "live");
        showPhase("incall");
        startTimer();
        log("Call connected", "ok");
        break;
      }
      case "callEnded": {
        const reason = callData && callData.callEndReason;
        log(reason ? `Call ended (${reason})` : "Call ended");
        resetCallUI();
        break;
      }
      case "holdtoggle": {
        state.onHold = !state.onHold;
        el.holdBtn.classList.toggle("on", state.onHold);
        el.holdBtn.innerHTML = state.onHold
          ? `${icon("i-play")}<em>Resume</em>`
          : `${icon("i-pause")}<em>Hold</em>`;
        setCallState(state.onHold ? "On hold" : "Talking", "i-phone", state.onHold ? "wait" : "live");
        log(state.onHold ? "Call on hold" : "Call resumed");
        break;
      }
      case "mutetoggle": {
        state.muted = !state.muted;
        el.muteBtn.classList.toggle("on", state.muted);
        el.muteBtn.innerHTML = state.muted
          ? `${icon("i-mic-off")}<em>Unmute</em>`
          : `${icon("i-mic")}<em>Mute</em>`;
        log(state.muted ? "Muted" : "Unmuted");
        break;
      }
      default:
        break;
    }
  }

  /* ================= dialling ================= */
  function normalizeNumber(n) {
    return (n || "").replace(/[^\d+*#]/g, "").trim();
  }

  async function dial() {
    const number = normalizeNumber(el.number.value);
    if (!/^\+?[0-9]{10,14}$/.test(number)) {
      log("Enter a valid number (10–14 digits, optional +).", "error");
      setNotice("Enter a valid number — 10 to 14 digits.", "warn");
      setTimeout(() => setNotice(null), 3500);
      el.number.focus();
      return;
    }

    if (!state.webPhone || !state.deviceReady) {
      log("Browser line not ready. Switch to Click to call or check provisioning.", "warn");
      return;
    }

    // Mark the attempt BEFORE calling: Exotel's INVITE can reach us before
    // MakeCall's own HTTP response does.
    state.pendingOutbound = true;
    state.lastCallError = null;
    state.dialedNumber = number;
    el.peerName.textContent = number;
    el.metaDirection.innerHTML = `${icon("i-out")}<span>Outbound call</span>`;
    el.metaVia.innerHTML = `${icon("i-phone")}<span></span>`;
    el.metaVia.lastChild.textContent = state.callerId || "—";
    setCallState("Dialing", "i-phone", "wait");
    el.callTimer.textContent = "00:00";
    showPhase("dialing");
    ringer.start("ringback");
    log(`Dialing ${number} (in-browser)…`);

    state.outboundTimer = setTimeout(() => {
      if (state.pendingOutbound && !state.callActive) {
        log("Exotel never rang this browser back — check the agent's ExoPhone/flow setup.", "error");
        setNotice("The call did not come back to this browser.", "error");
        resetCallUI();
      }
    }, OUTBOUND_INVITE_TIMEOUT_MS);

    try {
      state.webPhone.MakeCall(number, (status, response) => {
        if (status === "success") {
          const sid = response && response.Data && response.Data.CallSid;
          if (state.pendingOutbound) setCallState("Ringing", "i-phone", "wait");
          log(`Call placed. CallSid: ${sid || "—"}`, "ok");
        } else {
          const why = state.lastCallError || (response && response.message) || String(response);
          state.lastCallError = null;
          log(`Call request failed: ${why}`, "error");
          setNotice(why, "error");
          resetCallUI();
        }
      });
    } catch (err) {
      log(`MakeCall error: ${err}`, "error");
      resetCallUI();
    }
  }

  /* ================= buttons ================= */
  el.dialBtn.addEventListener("click", dial);

  function acceptCall() {
    if (!state.webPhone) return;
    ringer.stop();
    hideIncomingModal();
    state.webPhone.AcceptCall();
    state.incoming = false;
    setCallState("Connecting", "i-phone", "wait");
    showPhase("dialing");
    log("Call accepted", "ok");
  }
  function rejectCall() {
    ringer.stop();
    hideIncomingModal();
    if (state.webPhone) state.webPhone.HangupCall();
    log("Call rejected");
    resetCallUI();
  }
  el.acceptBtn.addEventListener("click", acceptCall);
  el.rejectBtn.addEventListener("click", rejectCall);
  el.modalAccept.addEventListener("click", acceptCall);
  el.modalReject.addEventListener("click", rejectCall);
  el.modalSilence.addEventListener("click", () => {
    ringer.stop();
    log("Ringer silenced");
  });

  el.hangupBtn.addEventListener("click", () => {
    // Cancelling mid-dial: there is no SIP session to hang up yet, so remember
    // to refuse Exotel's return INVITE if it still shows up.
    if (state.pendingOutbound && !state.callActive) {
      state.abortedOutboundUntil = Date.now() + OUTBOUND_INVITE_TIMEOUT_MS;
      log("Cancelled while dialing.");
    } else {
      log("Hung up");
    }
    if (state.webPhone) state.webPhone.HangupCall();
    resetCallUI();
  });

  el.muteBtn.addEventListener("click", () => {
    if (state.webPhone && state.callActive) state.webPhone.ToggleMute();
  });
  el.holdBtn.addEventListener("click", () => {
    if (state.webPhone && state.callActive) state.webPhone.ToggleHold();
  });

  el.toggleLog.addEventListener("click", () => {
    el.logDrawer.hidden = !el.logDrawer.hidden;
  });
  el.clearLog.addEventListener("click", () => {
    el.logList.innerHTML = '<li class="log-empty">Events will appear here…</li>';
  });

  el.number.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dial();
  });

  // Escape declines a ringing call.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.incoming) rejectCall();
  });

  /* ================= boot ================= */
  (async function boot() {
    installSdkAudioSuppressor();
    resetCallUI();
    setSignal("wait");

    let config = {};
    try {
      config = await (await wakeFetch("/api/config")).json();
    } catch (e) {
      log("Could not load /api/config", "error");
    }
    state.callerId = config.callerId || "";
    el.identityAgent.textContent = config.accountSid || "—";

    if (!config.hasWebrtc) {
      setSignal("err");
      setNotice("Browser calling not provisioned — run: npm run provision", "warn");
      return;
    }

    let status = null;
    try {
      status = await (await wakeFetch("/api/provision/status")).json();
    } catch (e) {}

    if (status && status.user && status.user.provisioned === false) {
      setSignal("err");
      setNotice("Your agent isn't provisioned yet.", "warn");
      log("Agent not provisioned. Run 'npm run provision' (see SOP section 6).", "warn");
      return;
    }

    if (status && status.user && status.user.provisioned) {
      const u = status.user;
      el.identityAgent.textContent = u.userId;
      el.identityAgent.title = `${u.userId} · ${config.accountSid} · ExoPhone ${u.virtualNumber || "—"}`;
      if (u.virtualNumber) state.callerId = u.virtualNumber;
      log(`Agent ${u.userId} · ExoPhone ${state.callerId || "—"} · device ${u.sipDeviceId || "—"}`, "ok");
      if (!u.outboundActive) log("Outbound calling is not active on this agent in Exotel.", "warn");
    }

    await primeMicrophone();
    await initWebrtc(config);
    log("Ready.");
  })();
})();
