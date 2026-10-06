const countEl = document.getElementById("count");
const seenIds = new Set();

async function refreshCount() {
  try {
    const res = await fetch("/api/users");
    const users = await res.json();
    users.forEach((u) => seenIds.add(u.id));
    countEl.textContent = seenIds.size;
  } catch (err) {
    // network hiccup -- next poll/socket event will catch up
  }
}

refreshCount();
setInterval(refreshCount, 4000);

const socket = io();

socket.on("new_registration", (user) => {
  if (!seenIds.has(user.id)) {
    seenIds.add(user.id);
    countEl.textContent = seenIds.size;
  }
});

socket.on("network_changed", (data) => {
  const img = document.getElementById("register-qr-img");
  const urlText = document.getElementById("register-url-text");
  if (img) img.src = "/qr.png?t=" + Date.now();
  if (urlText) urlText.textContent = data.register_url;
  showNetworkChangeBanner();
});

function showNetworkChangeBanner() {
  let banner = document.getElementById("network-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "network-banner";
    banner.className = "network-banner";
    document.body.appendChild(banner);
  }
  banner.textContent = "Network changed — QR code updated";
  banner.classList.remove("hidden");
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.classList.add("hidden"), 6000);
}

socket.on("game_start", () => {
  document.querySelector(".qr-page-shell")?.classList.add("hidden");

  let el = document.getElementById("game-starting-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "game-starting-banner";
    el.className = "qr-page-shell";
    el.innerHTML = `
      <div class="qr-page-hero">
        <span class="hero-eyebrow">It's happening</span>
        <h1 class="hero-title">Game Starting!</h1>
        <p class="hero-subtitle">Look at your phones</p>
      </div>
    `;
    document.body.appendChild(el);
  }
});

socket.on("game_reset", () => {
  document.querySelector(".qr-page-shell")?.classList.remove("hidden");
  document.getElementById("game-starting-banner")?.remove();
});

socket.on("users_removed", (data) => {
  (data.ids || []).forEach((id) => seenIds.delete(id));
  countEl.textContent = seenIds.size;
});