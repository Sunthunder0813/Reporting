const scrollEl = document.getElementById("sb-scroll");
const trackEl = document.getElementById("sb-track");
const emptyEl = document.getElementById("sb-empty");
const countEl = document.getElementById("count");

const ROW_H = 72; // must match .sb-row height in scoreboard.css
const MEMBER_ROW_H = 52; // must match .sb-member-row height in style.css
const rows = new Map(); // user_id -> row element
const users = new Map(); // user_id -> { id, full_name, photo_url, score, online, leaderId }
const seen = new Set();
const capturingIds = new Set();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------
// Scoreboard rendering
// Rows are never re-inserted or re-ordered in the DOM. Ranking only
// changes each row's translateY, so nothing pops in again and nothing
// jumps while the Pokéball reveal is playing.
// ---------------------------------------------------------------------
// Leader row shows the TEAM total (leader's own score + every member's);
// layout() below fills in that number every time it's called, so the
// value rendered here is just a placeholder until the next layout pass.
function buildLeaderRow(row, leader) {
  row.className = "sb-row" + (leader.online ? "" : " offline");
  row.innerHTML = `
    <div class="sb-row-inner">
      <span class="sb-rank"></span>
      <div class="sb-player">
        <div class="sb-photo-wrap">
          <img class="sb-photo" src="${escapeHtml(leader.photo_url)}" alt="" />
          <span class="sb-status-dot" title="This device's connection"></span>
        </div>
        <span class="sb-name">${escapeHtml(leader.full_name)}</span>
        <span class="sb-off-tag">Device disconnected</span>
      </div>
      <span class="sb-score">${leader.score}</span>
    </div>
  `;
}

// Member row shows their own individual score, not the team total. No
// separate offline text here -- members share the leader's one phone/
// socket, so their dot just mirrors the leader's connection live instead
// of repeating the same "offline" label on every member.
function buildMemberRow(row, member) {
  row.className = "sb-row sb-member-row" + (member.online ? "" : " offline");
  row.innerHTML = `
    <div class="sb-row-inner">
      <span class="sb-rank"></span>
      <div class="sb-player">
        <div class="sb-photo-wrap">
          <img class="sb-photo" src="${escapeHtml(member.photo_url)}" alt="" />
          <span class="sb-status-dot"></span>
        </div>
        <span class="sb-name">${escapeHtml(member.full_name)}</span>
      </div>
      <span class="sb-score">${member.score}</span>
    </div>
  `;
}

// Groups every known user into { leader, members[] } blocks. A team is
// keyed by the leader's own id -- a solo registrant (no members added)
// is simply a team of one.
function getTeams() {
  const teams = new Map();
  users.forEach((u) => {
    const teamKey = u.leaderId == null ? u.id : u.leaderId;
    if (!teams.has(teamKey)) teams.set(teamKey, { leader: null, members: [] });
    const t = teams.get(teamKey);
    if (u.leaderId == null) t.leader = u;
    else t.members.push(u);
  });
  // A member can briefly exist without its leader's row yet (e.g. the
  // poll fallback discovers users out of order) -- skip those teams
  // until the leader shows up on a later layout() call.
  return [...teams.values()].filter((t) => t.leader);
}

function teamScore(t) {
  return t.leader.score + t.members.reduce((s, m) => s + m.score, 0);
}

function teamCapturing(t) {
  return capturingIds.has(t.leader.id) || t.members.some((m) => capturingIds.has(m.id));
}

function layout() {
  const teams = getTeams();
  // Teams still mid-reveal are pinned to the bottom so their hidden slot
  // can never push visible rows around; otherwise rank by team total.
  teams.sort((a, b) =>
    (teamCapturing(a) - teamCapturing(b)) ||
    (teamScore(b) - teamScore(a)) ||
    (a.leader.id - b.leader.id)
  );

  let y = 0;
  let prevScore = null;
  let rank = 0;
  let teamIndex = 0;

  teams.forEach((t) => {
    const score = teamScore(t);
    if (!teamCapturing(t)) {
      teamIndex += 1;
      if (score !== prevScore) {
        rank = teamIndex;
        prevScore = score;
      }
    }

    const leaderRow = rows.get(t.leader.id);
    if (leaderRow) {
      leaderRow.style.transform = `translateY(${y}px)`;
      const hasRank = !teamCapturing(t) && score > 0;
      leaderRow.dataset.rank = hasRank ? rank : "";
      const rankEl = leaderRow.querySelector(".sb-rank");
      if (rankEl) rankEl.textContent = hasRank ? rank : "–";
      const scoreEl = leaderRow.querySelector(".sb-score");
      if (scoreEl) scoreEl.textContent = score;
    }
    y += ROW_H;

    t.members.forEach((m) => {
      const memberRow = rows.get(m.id);
      if (memberRow) memberRow.style.transform = `translateY(${y}px)`;
      y += MEMBER_ROW_H;
    });
  });

  trackEl.style.height = `${y}px`;
  countEl.textContent = seen.size;
  emptyEl.classList.toggle("hidden", seen.size > 0);
}

function setAttendeeStatus(userId, isOnline) {
  const u = users.get(userId);
  if (u) u.online = isOnline;
  const row = rows.get(userId);
  if (row) row.classList.toggle("offline", !isOnline);

  // Members never get their own phone/socket -- the leader registers
  // them -- so mirror the leader's connection status onto every member
  // of their group instead of leaving members stuck "offline" forever.
  users.forEach((member, id) => {
    if (member.leaderId === userId) {
      member.online = isOnline;
      const memberRow = rows.get(id);
      if (memberRow) memberRow.classList.toggle("offline", !isOnline);
    }
  });
}

function showDelta(row, delta) {
  const el = document.createElement("span");
  el.className = "sb-delta" + (delta < 0 ? " neg" : "");
  el.textContent = (delta > 0 ? "+" : "") + delta;
  el.addEventListener("animationend", () => el.remove());
  row.appendChild(el);
}

// Call from a socket event or from the console for testing:
//   applyScore(1, 150)   // user id 1 now has 150 points
function applyScore(userId, newScore, delta) {
  const u = users.get(userId);
  if (!u) return;
  const change = delta !== undefined ? delta : newScore - u.score;
  if (newScore === u.score && !change) return;
  u.score = newScore;

  const row = rows.get(userId);
  if (row) {
    // Member rows show their own number directly here. Leader rows show
    // the TEAM total instead, which layout() (called below) computes and
    // writes -- so a leader's own raw score is never written to its row.
    if (u.leaderId != null) {
      const scoreEl = row.querySelector(".sb-score");
      if (scoreEl) {
        scoreEl.textContent = newScore;
        scoreEl.classList.remove("bump");
        void scoreEl.offsetWidth;
        scoreEl.classList.add("bump");
      }
    }
    if (change) showDelta(row, change);
  }

  // Whoever changed, the team total on the leader's row needs a fresh
  // bump -- layout() sets the actual new number a moment later.
  const leaderId = u.leaderId != null ? u.leaderId : u.id;
  const leaderRow = rows.get(leaderId);
  if (leaderRow) {
    const leaderScoreEl = leaderRow.querySelector(".sb-score");
    if (leaderScoreEl) {
      leaderScoreEl.classList.remove("bump");
      void leaderScoreEl.offsetWidth;
      leaderScoreEl.classList.add("bump");
    }
  }

  layout();
}

const queuedIds = new Set(); // ids waiting in captureQueue but not yet started

async function refresh() {
  try {
    const res = await fetch("/api/users");
    const list = await res.json();
    list.forEach((user) => {
      if (seen.has(user.id)) {
        setAttendeeStatus(user.id, user.online);
        if (typeof user.score === "number") applyScore(user.id, user.score);
      } else if (!queuedIds.has(user.id) && !capturingIds.has(user.id)) {
        // Not seen yet AND not already waiting for/playing its capture
        // sequence -- e.g. the socket event was missed entirely. Queue
        // it properly instead of rendering it instantly, so every
        // attendee gets the same capture reveal no matter how they were
        // discovered (socket push vs poll fallback). Falls back to a
        // solo reveal since the poll can't tell us group membership on
        // its own -- fine in practice since new_group already covers
        // the normal path.
        captureQueue.push({ type: "solo", user });
        queuedIds.add(user.id);
        processQueue();
      }
    });
    layout();
  } catch (err) {
    // network hiccup -- next poll/socket event will catch up
  }
}

layout();
refresh();
setInterval(refresh, 4000);

// ---------------------------------------------------------------------
// Pokéball capture sequence (full-screen overlay). Unchanged except that
// the placeholder/normal tile now use the scoreboard row.
// ---------------------------------------------------------------------
const captureOverlay = document.getElementById("capture-overlay");
const capturePhotoBig = document.getElementById("capture-photo-big");
const captureNameBig = document.getElementById("capture-name-big");
const captureAudio = document.getElementById("capture-audio");
const soundUnlock = document.getElementById("sound-unlock");

let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  // Play-then-immediately-pause on a real user gesture satisfies the
  // browser's autoplay policy so later programmatic play() calls (during
  // the actual capture sequence, with no fresh click) are allowed to
  // produce sound instead of being silently blocked.
  captureAudio.play().then(() => {
    captureAudio.pause();
    captureAudio.currentTime = 0;
    audioUnlocked = true;
    soundUnlock.classList.add("hidden");
  }).catch(() => {
    // Still blocked -- leave the prompt visible so they can try again.
  });
}

soundUnlock.addEventListener("click", unlockAudio);
document.addEventListener("pointerdown", unlockAudio, { once: true });

const captureQueue = [];
let captureActive = false;
let captureToken = 0; // bumped each time a new capture starts; guards the fade-out cleanup below
const CAPTURE_DURATION_MS = 10100; // total full-screen sequence: ball falls/shakes/catches, then big reveal, then fades

function addPlaceholderTile(user) {
  // Reserve the row's slot immediately (pinned last by layout()) but keep
  // it invisible until the full-screen reveal ends.
  if (seen.has(user.id)) return;
  seen.add(user.id);

  users.set(user.id, {
    id: user.id,
    full_name: user.full_name,
    photo_url: user.photo_url,
    score: typeof user.score === "number" ? user.score : 0,
    online: !!user.online,
    leaderId: user.leader_id != null ? user.leader_id : null,
  });

  const row = document.createElement("div");
  row.className = "sb-row";
  row.dataset.userId = user.id;
  row.style.visibility = "hidden";
  rows.set(user.id, row);

  trackEl.appendChild(row);
  layout();
}

const ORB_VARIANT_COUNT = 3;
const MEMBER_POP_DELAY_MS = 1500;   // wait after the leader's own reveal pops before all members pop together
const MAX_ORBIT_SLOTS = 8;          // keeps the ring legible; extra members still join the board, just without their own orbit slot

function startCaptureSolo(user) {
  capturingIds.add(user.id);
  addPlaceholderTile(user);

  // Claim the shared overlay for this capture. If a queued capture starts
  // before the previous one's fade-out cleanup below has fired, this lets
  // that stale cleanup detect it's no longer the active capture and back off
  // instead of hiding the overlay out from under the new one.
  captureToken += 1;
  const myToken = captureToken;

  captureOverlay.style.display = "";
  captureOverlay.classList.remove("capture-finish", "capture-holding");
  captureOverlay.classList.add("showing");
  setTimeout(() => captureOverlay.classList.add("capture-holding"), 1000);
  void captureOverlay.offsetWidth;
  requestAnimationFrame(() => {
    captureOverlay.classList.add("visible");
  });

  // Clone-and-replace both animated elements (a fresh DOM node always
  // plays its animation from frame zero). Clone .pokeball-entry, not
  // just .pokeball-big, so the nested fall/shake/vanish wrappers reset.
  const oldPokeballEntry = captureOverlay.querySelector(".pokeball-entry");
  const newPokeballEntry = oldPokeballEntry.cloneNode(true);
  const newPokeball = newPokeballEntry.querySelector(".pokeball-big");
  for (let i = 1; i <= ORB_VARIANT_COUNT; i++) {
    newPokeball.classList.remove(`orb-variant-${i}`);
  }
  const variant = 1 + Math.floor(Math.random() * ORB_VARIANT_COUNT);
  newPokeball.classList.add(`orb-variant-${variant}`);
  oldPokeballEntry.replaceWith(newPokeballEntry);

  const oldReveal = captureOverlay.querySelector(".capture-reveal-big");
  const newReveal = oldReveal.cloneNode(true);
  oldReveal.replaceWith(newReveal);

  // cloneNode() copies the <img>/<div> children too, so the photo/name
  // must be set on the NEW clone's children.
  const photoEl = newReveal.querySelector("#capture-photo-big");
  const nameEl = newReveal.querySelector("#capture-name-big");
  photoEl.src = user.photo_url;
  photoEl.alt = user.full_name;
  nameEl.textContent = user.full_name;

  let finishStarted = false;
  const finishCapture = () => {
    if (finishStarted) return;
    finishStarted = true;
    captureOverlay.classList.add("capture-finish");
  };

  captureAudio.currentTime = 0;
  captureAudio.onended = finishCapture;
  captureAudio.play().catch(() => {
    // The visual sequence still completes even if autoplay is blocked.
  });
  // The bundled track is 6.774 seconds. This prevents the reveal from
  // getting stuck if a browser blocks audio playback and no `ended` event fires.
  setTimeout(finishCapture, 7000);

  setTimeout(() => {
    captureOverlay.classList.remove("visible");
    setTimeout(() => {
      // Only hide the overlay if a newer capture hasn't already claimed it --
      // otherwise this stale cleanup would yank it away mid-reveal for the
      // next queued attendee.
      if (myToken === captureToken) {
        captureOverlay.classList.remove("showing");
        captureOverlay.style.display = "none";
      }
    }, 450);
    capturingIds.delete(user.id);
    const row = rows.get(user.id);
    const u = users.get(user.id);
    if (row && u) {
      row.style.visibility = "";
      if (u.leaderId != null) buildMemberRow(row, u); else buildLeaderRow(row, u);
      layout(); // slides the new team from the bottom to their rank
    }
    captureActive = false;
    processQueue();
  }, CAPTURE_DURATION_MS);
}

function startCaptureGroup(leader, members) {
  capturingIds.add(leader.id);
  addPlaceholderTile(leader);
  members.forEach((m) => {
    capturingIds.add(m.id);
    addPlaceholderTile(m);
  });

  captureToken += 1;
  const myToken = captureToken;

  captureOverlay.style.display = "";
  captureOverlay.classList.remove("capture-finish", "capture-holding");
  captureOverlay.classList.add("showing");
  setTimeout(() => captureOverlay.classList.add("capture-holding"), 1000);
  void captureOverlay.offsetWidth;
  requestAnimationFrame(() => {
    captureOverlay.classList.add("visible");
  });

  // Leader ball: identical clone-and-replace trick as the solo reveal, so
  // it restarts from frame zero every time.
  const oldPokeballEntry = captureOverlay.querySelector(".pokeball-entry");
  const newPokeballEntry = oldPokeballEntry.cloneNode(true);
  const newPokeball = newPokeballEntry.querySelector(".pokeball-big");
  for (let i = 1; i <= ORB_VARIANT_COUNT; i++) newPokeball.classList.remove(`orb-variant-${i}`);
  newPokeball.classList.add(`orb-variant-${1 + Math.floor(Math.random() * ORB_VARIANT_COUNT)}`);
  oldPokeballEntry.replaceWith(newPokeballEntry);

  const oldReveal = captureOverlay.querySelector(".capture-reveal-big");
  const newReveal = oldReveal.cloneNode(true);
  oldReveal.replaceWith(newReveal);

  const photoEl = newReveal.querySelector("#capture-photo-big");
  const nameEl = newReveal.querySelector("#capture-name-big");
  photoEl.src = leader.photo_url;
  photoEl.alt = leader.full_name;
  nameEl.textContent = leader.full_name;

  // Orbiting mini pokeballs, one per member (capped for legibility).
  const oldOrbit = captureOverlay.querySelector(".group-orbit");
  if (oldOrbit) oldOrbit.remove();
  const shown = members.slice(0, MAX_ORBIT_SLOTS);
  const orbit = document.createElement("div");
  orbit.className = "group-orbit";
  orbit.style.setProperty("--n", shown.length || 1);
  shown.forEach((m, i) => {
    const slot = document.createElement("div");
    slot.className = "orbit-slot";
    slot.style.setProperty("--i", i);
    slot.innerHTML = `
      <div class="orbit-pokeball orb-variant-${1 + Math.floor(Math.random() * ORB_VARIANT_COUNT)}"></div>
      <img class="orbit-photo" src="${escapeHtml(m.photo_url)}" alt="" />
      <span class="orbit-name">${escapeHtml(m.full_name)}</span>
    `;
    orbit.appendChild(slot);
  });
  captureOverlay.appendChild(orbit);

  let finishStarted = false;
  const popMembers = () => {
    // All member pokeballs pop open together, one beat after the leader's
    // own reveal, rather than trickling in one at a time.
    setTimeout(() => {
      Array.from(orbit.children).forEach((slot) => slot.classList.add("popped"));
    }, MEMBER_POP_DELAY_MS);
  };
  const finishCapture = () => {
    if (finishStarted) return;
    finishStarted = true;
    captureOverlay.classList.add("capture-finish");
    popMembers();
  };

  captureAudio.currentTime = 0;
  captureAudio.onended = finishCapture;
  captureAudio.play().catch(() => {});
  setTimeout(finishCapture, 7000);

  const totalDuration = 10100 + MEMBER_POP_DELAY_MS + 1200;

  setTimeout(() => {
    captureOverlay.classList.remove("visible");
    setTimeout(() => {
      if (myToken === captureToken) {
        captureOverlay.classList.remove("showing");
        captureOverlay.style.display = "none";
        const liveOrbit = captureOverlay.querySelector(".group-orbit");
        if (liveOrbit) liveOrbit.remove();
      }
    }, 450);

    capturingIds.delete(leader.id);
    members.forEach((m) => capturingIds.delete(m.id));

    const leaderRow = rows.get(leader.id);
    const leaderU = users.get(leader.id);
    if (leaderRow && leaderU) {
      leaderRow.style.visibility = "";
      buildLeaderRow(leaderRow, leaderU);
    }
    members.forEach((m) => {
      const mRow = rows.get(m.id);
      const mU = users.get(m.id);
      if (mRow && mU) {
        mRow.style.visibility = "";
        buildMemberRow(mRow, mU);
      }
    });
    layout();

    captureActive = false;
    processQueue();
  }, totalDuration);
}

function processQueue() {
  if (captureActive || captureQueue.length === 0) return;
  captureActive = true;
  const item = captureQueue.shift();
  if (item.type === "group") {
    queuedIds.delete(item.leader.id);
    item.members.forEach((m) => queuedIds.delete(m.id));
    startCaptureGroup(item.leader, item.members);
  } else {
    queuedIds.delete(item.user.id);
    startCaptureSolo(item.user);
  }
}

const socket = io();
socket.on("new_registration", (user) => {
  if (seen.has(user.id) || queuedIds.has(user.id)) return;
  captureQueue.push({ type: "solo", user });
  queuedIds.add(user.id);
  processQueue();
});

socket.on("new_group", (payload) => {
  const leader = payload.leader;
  const members = payload.members || [];
  if (seen.has(leader.id) || queuedIds.has(leader.id)) return;
  captureQueue.push({ type: "group", leader, members });
  queuedIds.add(leader.id);
  members.forEach((m) => queuedIds.add(m.id));
  processQueue();
});
socket.on("attendee_status", (data) => setAttendeeStatus(data.id, data.online));

// Payload: { id, score, delta }  or an array of those.
socket.on("score_update", (data) => {
  const list = Array.isArray(data) ? data : [data];
  list.forEach((s) => applyScore(s.id, s.score, s.delta));
});

socket.on("game_start", () => {
  document.querySelector(".leaderboard-shell")?.classList.add("hidden");

  let el = document.getElementById("game-starting-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "game-starting-banner";
    el.className = "leaderboard-shell";
    el.innerHTML = `
      <div class="lb-hero">
        <span class="hero-eyebrow">It's happening</span>
        <h1 class="hero-title">Game Starting!</h1>
      </div>
    `;
    document.body.appendChild(el);
  }
});

socket.on("users_removed", (data) => {
  (data.ids || []).forEach((id) => {
    seen.delete(id);
    queuedIds.delete(id);
    capturingIds.delete(id);
    users.delete(id);

    const row = rows.get(id);
    if (row) {
      row.remove();
      rows.delete(id);
    }

    const queueIdx = captureQueue.findIndex((u) => u.id === id);
    if (queueIdx !== -1) captureQueue.splice(queueIdx, 1);
  });
  layout();
});