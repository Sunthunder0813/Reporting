/*
 * effects.js -- live host effects, loaded on every page from base.html.
 *
 *   Red light   : every screen (projector + phones) flashes red.
 *   Spin wheel  : only the /leaderboard page shows it.
 *
 * Everything is a DOM overlay. It never reloads or navigates, so
 * attendees keep their Socket.IO presence. It reuses the page's own
 * `socket` when there is one, otherwise opens its own.
 *
 * Warning sound: drop your file at static/bg_music/alarm.mp3
 * (or change RED_LIGHT_SOUND below). If the file is missing the effect
 * still runs silently.
 */
(function () {
  if (window.__fxLoaded) return; // never wire twice
  window.__fxLoaded = true;

  const RED_LIGHT_SOUND = "/static/bg_music/alarm.mp3";
  const SPIN_MS = 5000; // fallback only; the server sends the real spin length (games.py)
  const SPIN_TURNS = 7;

  const IS_CONTROL = location.pathname.startsWith("/control");
  const IS_BOARD = () => !!document.getElementById("sb-scroll");

  // ---------------------------------------------------------------
  // Styles (injected so no CSS file edit is needed)
  // ---------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    .fx-red {
      position: fixed; inset: 0; z-index: 99999;
      display: none; flex-direction: column; align-items: center; justify-content: center;
      gap: 12px; padding: 24px; text-align: center; color: #fff;
      background: #b91c1c;
      animation: fx-red-flash 0.5s ease-in-out infinite alternate;
    }
    .fx-red.on { display: flex; }
    @keyframes fx-red-flash { from { background: #7f1d1d; } to { background: #ef4444; } }
    .fx-red-icon { font-size: clamp(64px, 18vw, 180px); line-height: 1; }
    .fx-red-title { font-size: clamp(38px, 10vw, 130px); font-weight: 900; letter-spacing: 0.04em; }
    .fx-red-sub { font-size: clamp(16px, 3vw, 32px); opacity: 0.92; }

    .fx-wheel {
      position: fixed; inset: 0; z-index: 3200;
      display: none; flex-direction: column; align-items: center; justify-content: center;
      gap: 20px; padding: 24px;
      background: rgba(5, 6, 14, 0.94); backdrop-filter: blur(6px);
    }
    .fx-wheel.on { display: flex; }
    .fx-wheel-title { margin: 0; font-size: clamp(24px, 4vw, 40px); font-weight: 800; color: #f4f4f8; text-align: center; }
    .fx-wheel-stage { position: relative; transition: opacity 0.5s ease, transform 0.5s ease; }
    .fx-wheel.show-winner .fx-wheel-stage { opacity: 0; transform: scale(0.8); pointer-events: none; position: absolute; }
    .fx-wheel-canvas { display: block; }
    .fx-wheel-pointer {
      position: absolute; top: -8px; left: 50%; transform: translateX(-50%); z-index: 2;
      border-left: 16px solid transparent; border-right: 16px solid transparent;
      border-top: 34px solid #fff; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.5));
    }
    .fx-winner {
      display: none; flex-direction: column; align-items: center; gap: 22px;
    }
    .fx-wheel.show-winner .fx-winner { display: flex; animation: fx-winner-pop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
    .fx-winner img {
      width: min(50vh, 380px); height: min(50vh, 380px); border-radius: 50%; object-fit: cover;
      border: 10px solid #22d3ee; box-shadow: 0 0 100px rgba(34, 211, 238, 0.65);
    }
    .fx-winner-name { font-size: clamp(30px, 5vw, 56px); font-weight: 800; color: #f4f4f8; text-align: center; text-shadow: 0 0 24px rgba(124, 92, 255, 0.6); }
    @keyframes fx-winner-pop { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: scale(1); } }

    @media (prefers-reduced-motion: reduce) {
      .fx-red { animation: none; background: #dc2626; }
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------
  // Red light
  // ---------------------------------------------------------------
  let redEl = null;
  let redAudio = null;

  function ensureRed() {
    if (redEl) return;
    redEl = document.createElement("div");
    redEl.className = "fx-red";
    redEl.innerHTML = `
      <div class="fx-red-icon">🚨</div>
      <div class="fx-red-title">RED LIGHT</div>
      <div class="fx-red-sub">Stop what you're doing and look up!</div>
    `;
    document.body.appendChild(redEl);
  }

  function getRedAudio() {
    if (!redAudio) {
      redAudio = new Audio(RED_LIGHT_SOUND);
      redAudio.loop = true;
    }
    return redAudio;
  }

  // Browsers only allow sound after a tap on this page. Phones land on
  // /thanks via a redirect, which loses that permission, so the first
  // tap silently "unlocks" the alarm sound for later.
  function unlockSound() {
    if (IS_CONTROL || window.__fxRedInline) return; // /thanks unlocks its own alarm
    try {
      const a = getRedAudio();
      a.muted = true;
      a.volume = 0;
      // Same fix as thanks.html: pause synchronously instead of waiting for
      // the play() promise, so a mute-timing lag on some devices can't leak
      // a brief real chirp of the siren out during the unlock attempt.
      const playPromise = a.play();
      a.pause();
      a.currentTime = 0;
      if (playPromise && typeof playPromise.catch === "function") playPromise.catch(() => {});
      a.muted = false;
      a.volume = 1;
    } catch (e) { /* ignore */ }
  }
  document.addEventListener("pointerdown", unlockSound, { once: true });

  function stopRed() {
    if (!redEl || !redEl.classList.contains("on")) return; // nothing to stop (keeps polling quiet)
    redEl.classList.remove("on");
    if (redAudio) {
      redAudio.pause();
      redAudio.currentTime = 0;
    }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function startRed() {
    console.log("[fx] red_light ON");
    if (IS_CONTROL || window.__fxRedInline) return; // control page stays usable; /thanks handles it itself
    ensureRed();
    if (redEl.classList.contains("on")) return; // already on: don't restart sound/vibration
    redEl.classList.add("on");

    try {
      const audio = getRedAudio();
      audio.muted = false;
      audio.currentTime = 0;
      audio.play().catch(() => {}); // missing file or blocked autoplay: stay silent
    } catch (e) { /* ignore */ }

    try {
      if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400, 150, 400]);
    } catch (e) { /* ignore */ }
  }

  // Reliable delivery: live socket events + a polling safety net.
  // `seq` stops a slow/old answer overriding a newer one; `boot` resets it
  // when the server restarts.
  let redSeq = -1;
  let redBoot = null;

  // state = { on, users, seq, boot }. This page has no attendee id, so it only
  // reacts to "alert everyone" (individual alerts are for phones on /thanks).
  function applyRed(state) {
    if (!state) return;
    if (state.boot !== undefined) {
      if (state.boot !== redBoot) { redBoot = state.boot; redSeq = -1; }
      if (typeof state.seq === "number") {
        if (state.seq < redSeq) return; // stale answer
        redSeq = state.seq;
      }
    }
    if (state.on) startRed(); else stopRed();
  }

  async function pollRed() {
    try {
      const res = await fetch("/api/red-state", { cache: "no-store" });
      const d = await res.json();
      applyRed(d);
    } catch (e) { /* network hiccup: the next poll will catch up */ }
  }

  function startRedPolling() {
    // Not on the control page, and not on /thanks (it polls for itself).
    if (IS_CONTROL || window.__fxRedInline) return;
    pollRed();
    setInterval(() => {
      if (document.visibilityState === "visible") pollRed();
    }, 1500);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollRed();
    });
    window.addEventListener("online", pollRed);
    window.addEventListener("pageshow", pollRed);
  }

  // ---------------------------------------------------------------
  // Spin the wheel (leaderboard only)
  // ---------------------------------------------------------------
  const PALETTE = ["#7c5cff", "#22d3ee", "#f472b6", "#38bdf8", "#a78bfa", "#34d399"];
  let wheelEl = null;
  let wheelRaf = 0;
  let wheelTimer = null;
  let wheelDone = false;

  function ensureWheel() {
    if (wheelEl) return;
    wheelEl = document.createElement("div");
    wheelEl.className = "fx-wheel";
    wheelEl.innerHTML = `
      <h2 class="fx-wheel-title">Spin the wheel</h2>
      <div class="fx-wheel-stage">
        <div class="fx-wheel-pointer"></div>
        <canvas class="fx-wheel-canvas"></canvas>
      </div>
      <div class="fx-winner">
        <img alt="" />
        <div class="fx-winner-name"></div>
      </div>
    `;
    // Tap the projector to dismiss once the winner is showing.
    wheelEl.addEventListener("click", () => { if (wheelDone) closeWheel(); });
    document.body.appendChild(wheelEl);
  }

  function closeWheel() {
    cancelAnimationFrame(wheelRaf);
    clearTimeout(wheelTimer);
    if (wheelEl) wheelEl.classList.remove("on", "show-winner");
    if (window.__fxLock) {
      window.__fxLock.wheel = false;
      if (window.__fxApplyLock) window.__fxApplyLock();
    }
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, Math.max(1, max - 1)) + "…" : text;
  }

  function drawWheel(ctx, size, cands, angle) {
    const r = size / 2;
    const n = cands.length;
    const seg = (Math.PI * 2) / n;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(r, r);

    for (let i = 0; i < n; i++) {
      const a0 = angle + i * seg;
      let color = PALETTE[i % PALETTE.length];
      if (i === n - 1 && n > 1 && color === PALETTE[0]) color = "#fb923c";

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 6, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(11, 14, 26, 0.85)";
      ctx.stroke();

      // Name, written along the segment's radius
      const fontSize = Math.max(9, Math.min(20, r * 0.7 * seg * 0.55));
      const maxChars = Math.floor((r * 0.72) / (fontSize * 0.55));
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = 3;
      ctx.fillText(truncate(cands[i].full_name, maxChars), r - 22, fontSize * 0.35);
      ctx.restore();
    }

    // Outer ring + hub
    ctx.beginPath();
    ctx.arc(0, 0, r - 4, 0, Math.PI * 2);
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#f4f4f8";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = "#0b0e1a";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#f4f4f8";
    ctx.stroke();

    ctx.restore();
  }

  let activeSpinId = null;

  function showWinner(winner) {
    // On a phone, tell the winner it's them (ATTENDEE_ID is set by /thanks).
    const isMe =
      typeof ATTENDEE_ID !== "undefined" &&
      ATTENDEE_ID !== "" &&
      String(ATTENDEE_ID) === String(winner.id);
    wheelEl.querySelector(".fx-wheel-title").textContent = isMe
      ? "You won! \u{1F389}"
      : "We have a winner!";
    if (isMe && navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) { /* ignore */ }
    }
    wheelEl.classList.add("show-winner");
    wheelDone = true;
  }

  function startWheel(payload) {
    if (IS_CONTROL) return; // shows on the projector AND on phones
    const cands = (payload && payload.candidates) || [];
    const winnerIdx = cands.findIndex((c) => c.id === payload.winner_id);
    if (!cands.length || winnerIdx < 0) return;

    // The same spin can reach a screen twice (live event + catch-up after a
    // reconnect). Ignore repeats so the wheel never restarts or re-draws.
    if (payload.spin_id !== undefined && payload.spin_id === activeSpinId) return;
    activeSpinId = payload.spin_id;

    // ---- Shared timeline (the server's clock) -------------------------
    // Every screen converts the server's start time into its own clock using
    // the server_time stamped on this very message, so a phone whose clock is
    // wrong still starts and stops exactly with the projector.
    const spinMs = payload.spin_ms || SPIN_MS;
    const offset = typeof payload.server_time === "number" ? payload.server_time - Date.now() : 0;
    const startAt = typeof payload.start_at === "number" ? payload.start_at - offset : Date.now();
    const revealAt = startAt + spinMs + 600;

    ensureWheel();
    closeWheel();
    wheelDone = false;
    wheelEl.classList.add("on");
    if (window.__fxLock) {
      window.__fxLock.wheel = true;
      if (window.__fxApplyLock) window.__fxApplyLock();
    }
    const titleEl = wheelEl.querySelector(".fx-wheel-title");

    // Preload the winner's photo so it appears instantly at the end.
    const winner = cands[winnerIdx];
    wheelEl.querySelector(".fx-winner img").src = winner.photo_url;
    wheelEl.querySelector(".fx-winner-name").textContent = winner.full_name;

    const size = Math.floor(Math.min(window.innerHeight * 0.72, window.innerWidth * 0.92, 660));
    const dpr = window.devicePixelRatio || 1;
    const canvas = wheelEl.querySelector(".fx-wheel-canvas");
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Land the winner's slice under the pointer at the top (-90deg).
    const seg = (Math.PI * 2) / cands.length;
    const jitterFraction =
      typeof payload.jitter === "number" ? payload.jitter : (Math.random() - 0.5) * 0.7;
    const finalAngle =
      -Math.PI / 2 - (winnerIdx + 0.5) * seg + jitterFraction * seg + Math.PI * 2 * SPIN_TURNS;

    let lastTitle = "";
    const setTitle = (text) => {
      if (text !== lastTitle) { titleEl.textContent = text; lastTitle = text; }
    };

    // The angle depends only on (now - startAt), never on when this screen
    // received the message, so every screen draws the same frame at the same moment.
    const frame = () => {
      const elapsed = Date.now() - startAt;
      const t = Math.max(0, Math.min(1, elapsed / spinMs));
      const eased = 1 - Math.pow(1 - t, 4); // fast start, long slow finish
      drawWheel(ctx, size, cands, finalAngle * eased);
      setTitle(elapsed < 0 ? "Get ready..." : "Spin the wheel");
      if (elapsed < spinMs) {
        wheelRaf = requestAnimationFrame(frame);
      } else {
        // Landed. Everyone reveals the winner at the same shared moment.
        wheelTimer = setTimeout(() => showWinner(winner), Math.max(0, revealAt - Date.now()));
      }
    };
    frame();
  }

  // ---------------------------------------------------------------
  // Socket wiring
  // ---------------------------------------------------------------
  function wire() {
    startRedPolling(); // works even on pages that have no Socket.IO (register, camera, login)

    let s = null;
    if (typeof socket !== "undefined" && socket && typeof socket.on === "function") {
      s = socket; // the page's own connection (leaderboard, host, thanks...)
    } else if (typeof io === "function") {
      s = io();
    }
    if (!s) {
      console.warn("[fx] no Socket.IO on this page, effects disabled");
      return; // page has no Socket.IO (e.g. plain forms)
    }
    console.log("[fx] effects.js ready on", location.pathname);

    s.on("red_state", applyRed);
    s.on("wheel_spin", startWheel);
    s.on("wheel_close", closeWheel);

    // If this screen connects/reloads while a wheel is active, ask the server
    // for the SAME wheel (same winner, same timeline), never a new draw.
    const askForState = () => {
      s.emit("wheel_state_request");
      s.emit("red_state_request"); // also match the host's red light ON/OFF
    };
    s.on("connect", askForState);
    if (s.connected) askForState();
    s.on("game_reset", () => { closeWheel(); }); // red light only ends with the host's OFF switch
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();