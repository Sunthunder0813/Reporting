const $ = (id) => document.getElementById(id);

const countEl = $("count");
const onlineCountEl = $("online-count");
const offlineCountEl = $("offline-count");
const statusMsg = $("status-msg");
const gridEl = $("player-grid");

const startBtn = $("start-btn");
const resetBtn = $("reset-btn");
const wheelBtn = $("wheel-btn");
const wheelCloseBtn = $("wheel-close-btn");
const redToggleBtn = $("red-toggle-btn");
const redClearBtn = $("red-clear-btn");

const selectAllCheckbox = $("select-all-checkbox");
const giveBtn = $("give-btn");
const takeBtn = $("take-btn");
const deleteSelectedBtn = $("delete-selected-btn");
const resetScoresBtn = $("reset-scores-btn");

const users = new Map(); // id -> { id, full_name, photo_url, score, online }
const selectedIds = new Set();
let redState = { on: false, users: [] }; // mirrors the server

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let statusTimer = null;
function showStatus(text) {
  statusMsg.textContent = text;
  statusMsg.classList.remove("hidden");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusMsg.classList.add("hidden"), 6000);
}

// Every +/- tap moves a player's score by this many points.
const POINTS_PER_TAP = 10;

function currentAmount() {
  return POINTS_PER_TAP;
}

// ---------------------------------------------------------------------
// Player cards (5 per row). Fixed join order, so a card never jumps
// away from under your finger when its points change.
// ---------------------------------------------------------------------
function updateToolbarState() {
  countEl.textContent = users.size;
  const onlineNow = Array.from(users.values()).filter((u) => u.online === true).length;
  onlineCountEl.textContent = onlineNow;
  offlineCountEl.textContent = users.size - onlineNow;
  startBtn.disabled = users.size === 0;
  const none = selectedIds.size === 0;
  giveBtn.disabled = none;
  takeBtn.disabled = none;
  deleteSelectedBtn.disabled = none;
  selectAllCheckbox.checked = users.size > 0 && selectedIds.size === users.size;

  // Red alert buttons
  const anyAlert = redState.on || (redState.users || []).length > 0;
  redToggleBtn.classList.toggle("on", redState.on);
  redToggleBtn.textContent = redState.on ? "🚨 Alerting everyone (tap to stop)" : "🚨 Alert everyone";
  redClearBtn.classList.toggle("hidden", !anyAlert);
}

let lastGridHtml = null;

function renderGrid() {
  updateToolbarState();

  if (users.size === 0) {
    const emptyHtml = `<div class="ctl-empty">No one has registered yet.</div>`;
    if (emptyHtml !== lastGridHtml) { gridEl.innerHTML = emptyHtml; lastGridHtml = emptyHtml; }
    return;
  }

  const amt = currentAmount();
  const alerting = new Set((redState.users || []).map(Number));

  const html = Array.from(users.values())
    .sort((a, b) => a.id - b.id)
    .map((u) => {
      const isAlerting = alerting.has(u.id);
      return `
      <article class="pc${selectedIds.has(u.id) ? " selected" : ""}${isAlerting ? " alerting" : ""}${u.online === true ? "" : " offline"}">
        <label class="pc-check" title="Select">
          <input type="checkbox" class="pc-checkbox" data-id="${u.id}" ${selectedIds.has(u.id) ? "checked" : ""} />
        </label>
        <span class="pc-dot${u.online === true ? " on" : ""}" title="${u.online === true ? "Online" : "Offline"}"></span>
        <div class="pc-photo-wrap">
          <img class="pc-photo" src="${escapeHtml(u.photo_url)}" alt="" />
          ${u.online === true ? "" : `<div class="pc-off-overlay">Disconnected</div>`}
        </div>
        <div class="pc-name">${escapeHtml(u.full_name)}</div>
        <div class="pc-score">${u.score || 0}<span class="pc-pts">pts</span></div>
        <div class="pc-actions">
          <button type="button" class="pc-btn pc-minus" data-id="${u.id}" title="Take points">&minus;${amt || ""}</button>
          <button type="button" class="pc-btn pc-plus" data-id="${u.id}" title="Give points">+${amt || ""}</button>
        </div>
        <button type="button" class="pc-alert${isAlerting ? " on" : ""}" data-id="${u.id}">
          🚨 ${isAlerting ? "Stop alert" : "Alert"}
        </button>
      </article>`;
    })
    .join("");

  // Only touch the DOM when something actually changed. The background refreshes
  // run every few seconds, and rebuilding the cards mid-click would swallow taps.
  if (html === lastGridHtml) return;
  gridEl.innerHTML = html;
  lastGridHtml = html;
}

// ---------------------------------------------------------------------
// Card + toolbar interactions
// ---------------------------------------------------------------------
gridEl.addEventListener("change", (e) => {
  if (!e.target.classList.contains("pc-checkbox")) return;
  const id = parseInt(e.target.dataset.id, 10);
  if (e.target.checked) selectedIds.add(id);
  else selectedIds.delete(id);
  renderGrid();
});

gridEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  if (btn.classList.contains("pc-plus")) awardPoints([id], currentAmount());
  else if (btn.classList.contains("pc-minus")) awardPoints([id], -currentAmount());
  else if (btn.classList.contains("pc-alert")) toggleUserAlert(id);
});

selectAllCheckbox.addEventListener("change", () => {
  if (selectAllCheckbox.checked) users.forEach((_, id) => selectedIds.add(id));
  else selectedIds.clear();
  renderGrid();
});

giveBtn.addEventListener("click", () => awardPoints(Array.from(selectedIds), currentAmount()));
takeBtn.addEventListener("click", () => awardPoints(Array.from(selectedIds), -currentAmount()));

deleteSelectedBtn.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  if (!window.confirm(`Delete ${selectedIds.size} player(s)? This can't be undone.`)) return;
  deleteSelectedBtn.disabled = true;
  try {
    const res = await fetch("/api/users/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selectedIds) }),
    });
    const data = await res.json();
    if (data.ok) {
      removeUsers(data.removed);
      showStatus(`Removed ${data.removed.length} player(s).`);
    } else {
      showStatus("Delete failed.");
    }
  } catch (err) {
    showStatus("Delete failed. Check the server is running.");
  }
  updateToolbarState();
});

// ---------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------
function applyScoreUpdates(updates) {
  (updates || []).forEach((s) => {
    const u = users.get(s.id);
    if (u) u.score = s.score;
  });
  renderGrid();
}

async function awardPoints(ids, points) {
  if (!ids.length) {
    showStatus("Tick at least one player first.");
    return;
  }
  if (!points) {
    showStatus("Enter a whole number of points above 0.");
    return;
  }
  try {
    const res = await fetch("/api/score/award", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, points, reason: "manual" }),
    });
    const data = await res.json();
    if (data.ok) {
      applyScoreUpdates(data.updates);
      const sign = points > 0 ? "+" : "";
      const who = data.updates.length === 1 && users.get(data.updates[0].id)
        ? users.get(data.updates[0].id).full_name
        : `${data.updates.length} players`;
      showStatus(`${sign}${points} points for ${who}.`);
    } else {
      showStatus("Could not update points.");
    }
  } catch (err) {
    showStatus("Could not update points. Check the server is running.");
  }
}

resetScoresBtn.addEventListener("click", async () => {
  if (!window.confirm("Set every player's score back to 0?")) return;
  try {
    const res = await fetch("/api/score/reset", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      users.forEach((u) => { u.score = 0; });
      renderGrid();
      showStatus("All scores reset to 0.");
    }
  } catch (err) {
    showStatus("Could not reset scores. Check the server is running.");
  }
});

// ---------------------------------------------------------------------
// Red alert: everyone, or one player
// ---------------------------------------------------------------------
function applyRedState(state) {
  if (!state) return;
  redState = { on: !!state.on, users: state.users || [] };
  renderGrid();
}

redToggleBtn.addEventListener("click", async () => {
  redToggleBtn.disabled = true;
  try {
    const res = await fetch(redState.on ? "/stop-red-light" : "/trigger-red-light", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      applyRedState(data);
      showStatus(data.on ? "Red alert is ON for everyone." : "All alerts stopped.");
    } else {
      showStatus("Could not change the red alert.");
    }
  } catch (err) {
    showStatus("Could not change the red alert. Check the server is running.");
  }
  redToggleBtn.disabled = false;
});

redClearBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/stop-red-light", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      applyRedState(data);
      showStatus("All alerts stopped.");
    }
  } catch (err) {
    showStatus("Could not stop the alerts. Check the server is running.");
  }
});

async function toggleUserAlert(id) {
  const u = users.get(id);
  const turnOn = !(redState.users || []).map(Number).includes(id);
  try {
    const res = await fetch("/api/red-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, on: turnOn }),
    });
    const data = await res.json();
    if (data.ok) {
      applyRedState(data);
      const name = u ? u.full_name : "that player";
      showStatus(turnOn ? `Alert sent to ${name}.` : `Alert stopped for ${name}.`);
    } else {
      showStatus("Could not alert that player.");
    }
  } catch (err) {
    showStatus("Could not alert that player. Check the server is running.");
  }
}

// ---------------------------------------------------------------------
// Spin the wheel
// ---------------------------------------------------------------------
const WHEEL_SPIN_MS = 5000; // fallback only; the server sends the real spin length (games.py)
let wheelStatusTimer = null;

// The mini leaderboard preview (top right) is a full, separate /leaderboard
// page in an iframe with its own Socket.IO connection -- it's supposed to
// clear its wheel overlay the same way the real Leaderboard tab does when
// "wheel_close" arrives. A tiny, mostly off-screen iframe can get deprioritized
// by the browser though, so as a guaranteed fallback this reaches directly
// into the iframe's own DOM from here, driven by this page's own socket,
// instead of relying solely on the iframe's own connection.
function clearPreviewWheel() {
  try {
    const frame = document.querySelector(".ctl-preview-frame iframe");
    const wheelEl = frame?.contentDocument?.querySelector(".fx-wheel");
    if (wheelEl) wheelEl.classList.remove("on", "show-winner");
  } catch (e) { /* ignore -- cross-origin or not loaded yet */ }
}

wheelBtn.addEventListener("click", async () => {
  wheelBtn.disabled = true;
  let waitMs = 1500; // how long to keep the button locked
  try {
    const res = await fetch("/trigger-wheel", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      // Hold the winner's name back until the wheel has landed on every screen.
      waitMs = (data.lead_ms || 0) + (data.spin_ms || WHEEL_SPIN_MS) + 1500;
      showStatus("Wheel is spinning on the leaderboard and all phones...");
      clearTimeout(wheelStatusTimer);
      wheelStatusTimer = setTimeout(
        () => showStatus(`The wheel landed on ${data.winner.full_name}.`),
        waitMs
      );
    } else if (data.error === "busy") {
      showStatus("A spin is already running. Wait for it to finish.");
    } else if (data.error === "no_attendees") {
      showStatus("Can't spin -- no one has registered yet.");
    } else {
      showStatus("Could not spin the wheel.");
    }
  } catch (err) {
    showStatus("Could not spin the wheel. Check the server is running.");
  }
  // Block accidental double-clicks while a spin is in progress.
  setTimeout(() => { wheelBtn.disabled = false; }, waitMs);
});

wheelCloseBtn.addEventListener("click", async () => {
  clearPreviewWheel(); // clear it here immediately, don't wait for the round trip
  try {
    await fetch("/close-wheel", { method: "POST" });
    showStatus("Wheel closed.");
  } catch (err) {
    showStatus("Could not close the wheel. Check the server is running.");
  }
});

// ---------------------------------------------------------------------
// Start game / reset (unchanged behaviour)
// ---------------------------------------------------------------------
startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Starting...";
  try {
    const res = await fetch("/trigger-game", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showStatus("Game start signal sent to the screen and all phones.");
    } else if (data.error === "no_attendees") {
      showStatus("Can't start -- no one has registered yet.");
    } else {
      showStatus("Failed to send signal.");
    }
  } catch (err) {
    showStatus("Failed to send signal. Check the server is running.");
  }
  startBtn.textContent = "Start Game";
  updateToolbarState();
});

resetBtn.addEventListener("click", async () => {
  resetBtn.disabled = true;
  resetBtn.textContent = "Resetting...";
  try {
    const res = await fetch("/reset-game", { method: "POST" });
    const data = await res.json();
    if (data.ok) showStatus("Reset sent -- screens are back to normal.");
  } catch (err) {
    showStatus("Failed to send reset. Check the server is running.");
  }
  resetBtn.disabled = false;
  resetBtn.textContent = "Reset";
});

// ---------------------------------------------------------------------
// Loading + live updates
// ---------------------------------------------------------------------
function removeUsers(ids) {
  ids.forEach((id) => {
    users.delete(id);
    selectedIds.delete(id);
  });
  renderGrid();
}

async function loadUsers() {
  try {
    const res = await fetch("/api/users");
    const list = await res.json();
    users.clear();
    list.forEach((u) => users.set(u.id, u));
    Array.from(selectedIds).forEach((id) => { if (!users.has(id)) selectedIds.delete(id); });
    renderGrid();
  } catch (err) {
    // next poll/socket event will catch up
  }
}

async function loadRedState() {
  try {
    const res = await fetch("/api/red-state", { cache: "no-store" });
    applyRedState(await res.json());
  } catch (err) { /* ignore */ }
}

loadUsers();
loadRedState();
// Safety net: keep scores / online dots / alert states right even if a live message is missed.
setInterval(loadUsers, 8000);
setInterval(loadRedState, 4000);

const socket = io();

socket.on("new_registration", (user) => { users.set(user.id, user); renderGrid(); });
socket.on("users_removed", (data) => removeUsers(data.ids || []));
socket.on("score_update", (data) => applyScoreUpdates(Array.isArray(data) ? data : [data]));
socket.on("attendee_status", (data) => {
  const u = users.get(data.id);
  if (u) { u.online = data.online; renderGrid(); }
});
socket.on("red_state", applyRedState);
socket.on("wheel_close", clearPreviewWheel); // belt-and-suspenders: catches any wheel_close, not just this button's click

// ---------------------------------------------------------------------
// Live leaderboard mini-preview (top right). Same-origin, so we silence
// its audio from here -- otherwise the host would hear every red-alert
// alarm and Pokéball jingle twice: once for real, once from the preview.
// ---------------------------------------------------------------------
const previewFrame = document.querySelector(".ctl-preview-frame iframe");
if (previewFrame) {
  previewFrame.addEventListener("load", () => {
    try {
      const win = previewFrame.contentWindow;
      const doc = previewFrame.contentDocument;
      if (!win || !doc) return;

      const muteEl = (el) => { el.muted = true; el.volume = 0; };
      doc.querySelectorAll("audio, video").forEach(muteEl);

      // effects.js and leaderboard.js create some audio with `new Audio(...)`
      // rather than a DOM tag, so patch the preview's own constructor too.
      const OriginalAudio = win.Audio;
      win.Audio = function (...args) {
        const a = new OriginalAudio(...args);
        muteEl(a);
        return a;
      };

      // Catch any <audio>/<video> tag inserted into the DOM later.
      new win.MutationObserver((mutations) => {
        mutations.forEach((m) => {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.matches?.("audio, video")) muteEl(node);
            node.querySelectorAll?.("audio, video").forEach(muteEl);
          });
        });
      }).observe(doc.documentElement, { childList: true, subtree: true });
    } catch (e) {
      // Same-origin access blocked for some reason -- preview just stays as is.
    }
  });
}