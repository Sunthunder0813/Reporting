const grid = document.getElementById("grid");
const countEl = document.getElementById("count");
const seen = new Set();

function addTile(user) {
  if (seen.has(user.id)) return;
  seen.add(user.id);

  const tile = document.createElement("div");
  tile.className = `tile gender-${user.gender}`;
  tile.innerHTML = `
    <div class="tile-photo-wrap">
      <img src="${user.photo_url}" alt="${user.full_name}" />
    </div>
    <div class="tile-name">${user.full_name}</div>
  `;
  grid.prepend(tile);
  countEl.textContent = seen.size;
}

// Load anyone who already registered before this page opened/reloaded
fetch("/api/users")
  .then((r) => r.json())
  .then((users) => users.forEach(addTile));

// Live updates
const socket = io();
socket.on("new_registration", addTile);

// Game start trigger (from /control) -- placeholder transition until the
// real game screen is built; swap this handler's contents for the actual
// game UI later.
socket.on("game_start", () => {
  const preGame = document.getElementById("pre-game-view");
  const gameStart = document.getElementById("game-start-view");
  if (preGame) preGame.classList.add("hidden");
  if (gameStart) gameStart.classList.remove("hidden");
});
