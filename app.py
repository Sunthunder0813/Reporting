"""
Reporting Presentation App
--------------------------
Local-network-only interactive kiosk:
  1. Host laptop shows the "Join the Presentation" QR screen ("/" host view).
  2. Attendees scan the register QR with their phone -> lands on /register
     (same WiFi).
  3. They fill in full name + gender + a password (so they can reconnect
     later via /login if they disconnect) -> redirected to /camera.
  4. They take a selfie (circle guide is a draggable UI overlay only, the
     full raw photo is saved) -> redirected to /thanks.
  5. /leaderboard shows a live, animated grid of every registrant, with a
     full-screen "capture" reveal animation played once per new arrival.

Everything is stored locally in SQLite (database/app.db) and static/uploads/.
No internet / cloud services are used or required.
"""

import base64
import io
import ipaddress
import os
import socket
import sqlite3
import threading
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone

try:
    import eventlet
    eventlet.monkey_patch()
    ASYNC_MODE = "eventlet"

    # Eventlet's hub prints a full traceback for every rejected/incomplete
    # TLS handshake (background port scanners, antivirus HTTPS inspection,
    # stray probes hitting the open port) -- this is not an application
    # error and not a failed phone registration, so silence it to keep the
    # console readable during the event.
    def _quiet_squelch(fileno, exc_info):
        pass

    eventlet.hubs.get_hub().squelch_exception = _quiet_squelch
except ImportError:
    ASYNC_MODE = "threading"

import qrcode
from flask import (
    Flask, render_template, request, redirect, url_for,
    session, jsonify, send_file, flash
)
from flask_socketio import SocketIO
from werkzeug.security import generate_password_hash, check_password_hash

import scoring
import games

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "database", "app.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "static", "uploads")
PORT = int(os.environ.get("PORT", 5000))

# Optional: WiFi hotspot the phone should auto-join before registering.
# Set via environment variables (run.ps1 / setup.ps1 prompt for these),
# or prompted for interactively below if running "python app.py" directly.
WIFI_SSID = os.environ.get("WIFI_SSID", "").strip()
WIFI_PASSWORD = os.environ.get("WIFI_PASSWORD", "").strip()

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

CERT_DIR = os.path.join(BASE_DIR, "certs")
CERT_PATH = os.path.join(CERT_DIR, "cert.pem")
KEY_PATH = os.path.join(CERT_DIR, "key.pem")


def reset_event_data():
    """
    Wipe all registrants and uploaded selfies from a previous run. Called
    once at server startup so every restart begins with a clean slate.
    """
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)

    for fname in os.listdir(UPLOAD_DIR):
        fpath = os.path.join(UPLOAD_DIR, fname)
        try:
            if os.path.isfile(fpath):
                os.remove(fpath)
        except OSError:
            pass


def ensure_self_signed_cert(lan_ip):
    """
    Phone cameras (getUserMedia) only work in a 'secure context': HTTPS, or
    literally localhost. A plain http://<lan-ip> link cannot access the
    camera on current mobile browsers. So we generate a local, self-signed
    HTTPS certificate matching the current LAN IP and serve over HTTPS.
    Phones will show a one-time "connection not private" warning for this
    self-signed cert -- that's expected, tap through it.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    os.makedirs(CERT_DIR, exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, lan_ip)]
    )

    san_entries = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        san_entries.append(x509.IPAddress(ipaddress.ip_address(lan_ip)))
    except ValueError:
        pass

    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(key, hashes.SHA256())
    )

    with open(CERT_PATH, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    with open(KEY_PATH, "wb") as f:
        f.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )


def _cert_matches_current_ip(lan_ip):
    """
    Only regenerate the cert if none exists yet, or it was issued for a
    different LAN IP than the one we have now. Lets you trust the cert
    once in Windows and have it stay trusted across runs on the same
    network, instead of getting a fresh untrusted cert every launch.
    """
    if not (os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH)):
        return False
    try:
        from cryptography import x509
        with open(CERT_PATH, "rb") as f:
            existing_cert = x509.load_pem_x509_certificate(f.read())
        san = existing_cert.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value
        return lan_ip in [str(ip) for ip in san.get_values_for_type(x509.IPAddress)]
    except Exception:
        return False


app = Flask(__name__)
app.secret_key = "change-this-secret-for-your-event"  # local demo only, fine as-is
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=ASYNC_MODE)


# ---------------------------------------------------------------------------
# Presence tracking (who's currently connected on /thanks or /leaderboard)
# ---------------------------------------------------------------------------
# Maps socket session id -> registered user_id, so we know which attendee
# went offline when their socket disconnects (tab closed, phone locked,
# WiFi dropped). Host/leaderboard-screen sockets never appear in this dict.
connected_attendees = {}

# Serializes only the "Finish Group" broadcast step -- two leaders can
# register their whole groups fully in parallel (each has their own
# independent Flask session/cookie); this only guards the brief moment
# where the finished group's data is read and emitted, so a second leader
# finishing at the same instant waits milliseconds, not minutes.
GROUP_FINISH_LOCK = threading.Lock()

# Maps user_id -> bool, the last known online status for each attendee.
# This is what makes status survive host/leaderboard reloads -- without
# it, a screen that (re)loads after an attendee already went online/
# offline has no way to know their current state.
attendee_online_status = {}

# A weak-WiFi blip or a phone briefly backgrounding closes the socket and
# reopens a new one a few seconds later -- socket.io reconnects on its own,
# and /thanks re-announces itself on every reconnect (see announcePresence()
# in thanks.html). Without a grace period, /control and the leaderboard
# would flash "Disconnected" for every one of these normal blips. So a
# disconnect only actually broadcasts "offline" if the attendee hasn't
# reconnected by the time this grace period elapses.
DISCONNECT_GRACE_SECONDS = 5

# user_id -> generation counter. Bumped on every disconnect AND every
# reconnect, so a delayed "are they still gone?" check can tell whether a
# newer event has already superseded the one that scheduled it.
_presence_generation = {}


@socketio.on("connect")
def handle_connect():
    print(f"[socket] connected (sid={request.sid})")


def _finalize_offline(user_id, generation):
    """
    Runs after DISCONNECT_GRACE_SECONDS. Only marks the attendee offline if
    nothing reconnected them in the meantime -- their generation counter
    hasn't moved on, and no live sid is mapped to them.
    """
    if _presence_generation.get(user_id) != generation:
        return  # they reconnected (or disconnected again) since this was scheduled
    if user_id in connected_attendees.values():
        return  # a live socket is already mapped to them
    attendee_online_status[user_id] = False
    socketio.emit("attendee_status", {"id": user_id, "online": False}, to=None)


@socketio.on("disconnect")
def handle_disconnect():
    user_id = connected_attendees.pop(request.sid, None)
    if user_id is None:
        return
    generation = _presence_generation.get(user_id, 0) + 1
    _presence_generation[user_id] = generation

    def _delayed_check():
        socketio.sleep(DISCONNECT_GRACE_SECONDS)
        _finalize_offline(user_id, generation)

    socketio.start_background_task(_delayed_check)


@socketio.on("attendee_online")
def handle_attendee_online(data):
    """Attendee's /thanks page announces itself so we can track it."""
    raw_id = data.get("id")
    if raw_id is None:
        return
    try:
        # Normalize to int -- the browser sends this as a string (it came
        # from a URL query param), but SQLite/api_users always use int
        # ids. Without this, a str-keyed status entry never matches an
        # int-keyed lookup elsewhere, and status silently reverts to
        # offline on the next poll.
        user_id = int(raw_id)
    except (TypeError, ValueError):
        return
    connected_attendees[request.sid] = user_id
    # Invalidate any pending "mark offline" check scheduled by a disconnect
    # that this reconnect has now superseded.
    _presence_generation[user_id] = _presence_generation.get(user_id, 0) + 1
    attendee_online_status[user_id] = True
    socketio.emit("attendee_status", {"id": user_id, "online": True}, to=None)


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    # timeout: if the DB is momentarily locked by another concurrent write,
    # retry for up to 10s instead of throwing "database is locked"
    # immediately -- multiple phones can hit /capture (an INSERT) within
    # the same second of each other.
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL mode allows one writer + many concurrent readers instead of
    # locking the entire database file on every write.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                gender TEXT NOT NULL CHECK(gender IN ('male', 'female')),
                photo_filename TEXT NOT NULL,
                created_at TEXT NOT NULL,
                username TEXT UNIQUE,
                password_hash TEXT,
                leader_id INTEGER,
                finalized INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.commit()


def get_lan_ip():
    """Best-effort LAN IP of this laptop (what phones on the same WiFi use)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


LAN_IP = get_lan_ip()


def monitor_lan_ip():
    """
    Background watcher: if the laptop's LAN IP changes mid-event (DHCP
    renewal, switching networks, sleep/wake), regenerate the cert to
    match and push the new URLs to the QR/host screen instantly instead
    of every QR code silently going stale.
    """
    global LAN_IP
    while True:
        socketio.sleep(3)
        current_ip = get_lan_ip()
        if current_ip != LAN_IP:
            print(f"[network] LAN IP changed: {LAN_IP} -> {current_ip}")
            LAN_IP = current_ip
            ensure_self_signed_cert(LAN_IP)
            socketio.emit(
                "network_changed",
                {
                    "register_url": f"https://{LAN_IP}:{PORT}/register",
                    "host_url": f"https://{LAN_IP}:{PORT}/",
                },
            )

scoring.register_scoring(app, socketio, get_db)
games.register_games(app, socketio, get_db)

# ---------------------------------------------------------------------------
# Host / QR screen
# ---------------------------------------------------------------------------
@app.route("/")
def host():
    """Default projector screen: just the WiFi + register QR codes."""
    register_url = f"https://{LAN_IP}:{PORT}/register"
    return render_template(
        "host.html",
        register_url=register_url,
        has_wifi_qr=bool(WIFI_SSID),
        wifi_ssid=WIFI_SSID,
    )


@app.route("/qr.png")
def qr_png():
    register_url = f"https://{LAN_IP}:{PORT}/register"
    img = qrcode.make(register_url, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@app.route("/wifi-qr.png")
def wifi_qr_png():
    """QR that prompts the phone to join the hotspot WiFi (still needs one tap)."""
    security = "WPA" if WIFI_PASSWORD else "nopass"

    def esc(s):
        return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace('"', '\\"')

    wifi_string = f"WIFI:T:{security};S:{esc(WIFI_SSID)};P:{esc(WIFI_PASSWORD)};H:false;;"
    img = qrcode.make(wifi_string, box_size=10, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")


@app.route("/api/users")
def api_users():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, full_name, gender, photo_filename, created_at, leader_id "
            "FROM users WHERE finalized = 1 ORDER BY id ASC"
        ).fetchall()
        scores = scoring.get_scores(conn)
    users = [
        {
            "id": r["id"],
            "full_name": r["full_name"],
            "gender": r["gender"],
            "photo_url": url_for("static", filename=f"uploads/{r['photo_filename']}"),
            "created_at": r["created_at"],
            "online": attendee_online_status.get(r["id"], False),
            "score": scores.get(r["id"], 0),
            "leader_id": r["leader_id"],
        }
        for r in rows
    ]
    return jsonify(users)

# ---------------------------------------------------------------------------
# Leaderboard (live animated grid of every registrant)
# ---------------------------------------------------------------------------
@app.route("/leaderboard")
def leaderboard():
    return render_template("leaderboard.html")


# ---------------------------------------------------------------------------
# Control panel: trigger the game start signal (host only, not linked
# anywhere -- reachable only if you know the URL, printed at startup)
# ---------------------------------------------------------------------------
@app.route("/control")
def control():
    return render_template("control.html")


@app.route("/trigger-game", methods=["POST"])
def trigger_game():
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if count == 0:
        # Belt-and-suspenders: the button is disabled client-side with
        # zero attendees, but reject here too in case of a stale page.
        return jsonify({"ok": False, "error": "no_attendees"}), 400
    socketio.emit("game_start", {})
    return jsonify({"ok": True})


@app.route("/api/users/delete", methods=["POST"])
def delete_users():
    """Bulk-remove attendees (and their photos) from /control. Broadcasts
    users_removed so the QR page, leaderboard, and any bouncing gallery
    on attendee phones all drop the removed accounts immediately."""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids", [])
    if not isinstance(ids, list) or not ids:
        return jsonify({"ok": False, "error": "no_ids"}), 400

    try:
        ids = [int(i) for i in ids]
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "bad_ids"}), 400

    with get_db() as conn:
        # Cascade: deleting a leader also removes their group's members --
        # otherwise a member row is left pointing at a leader_id that no
        # longer exists, and shows up as an orphaned tile.
        placeholders = ",".join("?" * len(ids))
        member_ids = [
            row["id"]
            for row in conn.execute(
                f"SELECT id FROM users WHERE leader_id IN ({placeholders})", ids
            ).fetchall()
        ]
        ids = list(set(ids) | set(member_ids))
        placeholders = ",".join("?" * len(ids))

        rows = conn.execute(
            f"SELECT id, photo_filename FROM users WHERE id IN ({placeholders})",
            ids,
        ).fetchall()
        conn.execute(f"DELETE FROM users WHERE id IN ({placeholders})", ids)
        scoring.delete_for_users(conn, ids)
        conn.commit()

    for row in rows:
        fpath = os.path.join(UPLOAD_DIR, row["photo_filename"])
        try:
            if os.path.isfile(fpath):
                os.remove(fpath)
        except OSError:
            pass

    removed_ids = [row["id"] for row in rows]
    for uid in removed_ids:
        attendee_online_status.pop(uid, None)

    socketio.emit("users_removed", {"ids": removed_ids})
    return jsonify({"ok": True, "removed": removed_ids})


@app.route("/reset-game", methods=["POST"])
def reset_game():
    """
    Undo the game_start takeover on every screen -- registrations/photos
    are untouched, this only resets the visual state so Start Game can be
    triggered again later.

    IMPORTANT: game_start/game_reset must stay pure DOM show/hide on the
    client (see qr.js, leaderboard.js, thanks.html). Never make either
    handler navigate/reload the page (location.href, location.reload,
    a redirect response, etc) -- that would drop the attendee's Socket.IO
    connection, which briefly marks them "Disconnected" on the leaderboard
    and loses their place mid-event. Any future game screen must be
    swapped in the same way: show/hide within the current page.
    """
    socketio.emit("game_reset", {})
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Attendee flow: register -> camera -> thanks (and login for reconnecting)
# ---------------------------------------------------------------------------
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        full_name = request.form.get("full_name", "").strip()
        gender = request.form.get("gender", "")
        password = request.form.get("password", "")

        if not full_name or gender not in ("male", "female"):
            flash("Please enter your full name and select a gender.")
            return render_template("register.html", full_name=full_name, gender=gender)

        if not password:
            flash("Please choose a password so you can reconnect later.")
            return render_template("register.html", full_name=full_name, gender=gender)

        with get_db() as conn:
            existing = conn.execute(
                "SELECT id FROM users WHERE username = ?", (full_name,)
            ).fetchone()
        if existing:
            flash("That name is already registered. If this is you, log in instead.")
            return render_template("register.html", full_name="", gender=gender)

        session.pop("group_leader_id", None)  # start fresh if a prior group was abandoned
        session["full_name"] = full_name
        session["gender"] = gender
        session["username"] = full_name
        session["password_hash"] = generate_password_hash(password)
        session["pending_role"] = "leader"
        return redirect(url_for("camera"))

    return render_template("register.html", full_name="", gender="")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        with get_db() as conn:
            row = conn.execute(
                "SELECT id, password_hash FROM users WHERE username = ?", (username,)
            ).fetchone()

        if row and row["password_hash"] and check_password_hash(row["password_hash"], password):
            return redirect(url_for("thanks", uid=row["id"]))

        flash("Incorrect name or password.")
        return render_template("login.html", username=username)

    return render_template("login.html", username="")


@app.route("/camera", methods=["GET"])
def camera():
    if "full_name" not in session:
        return redirect(url_for("register"))
    return render_template("camera.html", full_name=session["full_name"])


@app.route("/capture", methods=["POST"])
def capture():
    if "full_name" not in session:
        return jsonify({"error": "session_expired"}), 400

    data = request.get_json(silent=True) or {}
    image_data_url = data.get("image")
    if not image_data_url or "," not in image_data_url:
        return jsonify({"error": "no_image"}), 400

    header, encoded = image_data_url.split(",", 1)
    photo_bytes = base64.b64decode(encoded)

    filename = f"{uuid.uuid4().hex}.jpg"
    filepath = os.path.join(UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(photo_bytes)

    full_name = session.pop("full_name")
    gender = session.pop("gender")
    username = session.pop("username", None)
    password_hash = session.pop("password_hash", None)
    role = session.pop("pending_role", "leader")
    leader_id = session.get("group_leader_id") if role == "member" else None
    created_at = datetime.now().isoformat(timespec="seconds")

    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO users (full_name, gender, photo_filename, created_at, username, password_hash, leader_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (full_name, gender, filename, created_at, username, password_hash, leader_id),
        )
        user_id = cur.lastrowid
        if scoring.REGISTER_BONUS:
            scoring.award(conn, user_id, scoring.REGISTER_BONUS, "registered")
        conn.commit()

    # Deliberately no socketio.emit here -- the leaderboard reveal fires
    # once, for the whole group together, when the leader hits "Finish
    # Group" on /add-member (leader centered, members orbiting). Emitting
    # per-person here would show the leader's reveal alone, then each
    # member's separately, instead of one combined moment.
    if role == "leader":
        session["group_leader_id"] = user_id

    return jsonify({"ok": True, "redirect": url_for("add_member")})

@app.route("/add-member", methods=["GET", "POST"])
def add_member():
    leader_id = session.get("group_leader_id")
    if not leader_id:
        flash("Please register yourself first.")
        return redirect(url_for("register"))

    with get_db() as conn:
        leader_row = conn.execute(
            "SELECT id, full_name, gender, photo_filename FROM users WHERE id = ?",
            (leader_id,),
        ).fetchone()

    if not leader_row:
        # Leader row vanished (e.g. the server restarted mid-event, which
        # wipes the DB) -- the session cookie still thinks a flow is
        # active but has nothing to attach members to. Start over.
        session.pop("group_leader_id", None)
        flash("Your session expired. Please register again.")
        return redirect(url_for("register"))

    if request.method == "POST":
        action = request.form.get("action", "add")

        if action == "finish":
            with GROUP_FINISH_LOCK:
                with get_db() as conn:
                    conn.execute(
                        "UPDATE users SET finalized = 1 WHERE id = ? OR leader_id = ?",
                        (leader_id, leader_id),
                    )
                    conn.commit()

                    leader = conn.execute(
                        "SELECT id, full_name, gender, photo_filename FROM users WHERE id = ?",
                        (leader_id,),
                    ).fetchone()
                    member_rows = conn.execute(
                        "SELECT id, full_name, gender, photo_filename FROM users "
                        "WHERE leader_id = ? ORDER BY id ASC",
                        (leader_id,),
                    ).fetchall()
                    scores = scoring.get_scores(conn)

                payload = {
                    "leader": {
                        "id": leader["id"],
                        "full_name": leader["full_name"],
                        "gender": leader["gender"],
                        "photo_url": url_for("static", filename=f"uploads/{leader['photo_filename']}"),
                        "score": scores.get(leader["id"], 0),
                        "leader_id": None,
                    },
                    "members": [
                        {
                            "id": m["id"],
                            "full_name": m["full_name"],
                            "gender": m["gender"],
                            "photo_url": url_for("static", filename=f"uploads/{m['photo_filename']}"),
                            "score": scores.get(m["id"], 0),
                            "leader_id": leader["id"],
                        }
                        for m in member_rows
                    ],
                }
                socketio.emit("new_group", payload)

            session.pop("group_leader_id", None)
            return redirect(url_for("thanks", uid=leader_id))

        # action == "add": register the next teammate, then take their photo.
        full_name = request.form.get("full_name", "").strip()
        gender = request.form.get("gender", "")

        if not full_name or gender not in ("male", "female"):
            flash("Please enter the member's full name and select a gender.")
        else:
            with get_db() as conn:
                existing = conn.execute(
                    "SELECT id FROM users WHERE full_name = ?", (full_name,)
                ).fetchone()
            if existing:
                flash("That name is already registered.")
            else:
                session["full_name"] = full_name
                session["gender"] = gender
                session["pending_role"] = "member"
                return redirect(url_for("camera"))

    with get_db() as conn:
        members = conn.execute(
            "SELECT id, full_name, gender, photo_filename FROM users "
            "WHERE leader_id = ? ORDER BY id ASC",
            (leader_id,),
        ).fetchall()

    return render_template(
        "add_member.html",
        leader_full_name=leader_row["full_name"],
        leader_photo_url=url_for("static", filename=f"uploads/{leader_row['photo_filename']}"),
        members=[
            {
                "full_name": m["full_name"],
                "photo_url": url_for("static", filename=f"uploads/{m['photo_filename']}"),
            }
            for m in members
        ],
    )

@app.route("/thanks")
def thanks():
    user_id = request.args.get("uid", "")
    return render_template("thanks.html", user_id=user_id)


# ---------------------------------------------------------------------------
def open_host_screen():
    """Pop the host screen open in the default browser once the server is up."""
    webbrowser.open(f"https://127.0.0.1:{PORT}/")


if __name__ == "__main__":
    reset_event_data()
    init_db()
    scoring.init_scoring(get_db)

    # If not already provided via env vars (e.g. by setup.ps1/run.ps1),
    # ask here so running "python app.py" directly still offers the
    # optional WiFi-join QR flow.
    if not WIFI_SSID:
        try:
            wifi_input = input(
                "\nOptional: show a 'Join WiFi' QR code on the host screen.\n"
                "Hotspot WiFi name / SSID (leave blank to skip): "
            ).strip()
            if wifi_input:
                WIFI_SSID = wifi_input
                WIFI_PASSWORD = input(
                    "Hotspot WiFi password (leave blank if open network): "
                ).strip()
        except EOFError:
            pass

    if not _cert_matches_current_ip(LAN_IP):
        ensure_self_signed_cert(LAN_IP)

    print(f"\n  Host screen:      https://{LAN_IP}:{PORT}/")
    print(f"  Register (phone): https://{LAN_IP}:{PORT}/register")
    print(f"  Leaderboard:      https://{LAN_IP}:{PORT}/leaderboard")
    print(f"  Control panel:    https://{LAN_IP}:{PORT}/control  (yours only, don't share)")
    print(f"  Async mode:       {ASYNC_MODE}")
    print(
        "\n  NOTE: phones will see a 'connection not private' warning the "
        "first time (self-signed cert) -- tap Advanced > Proceed. This is "
        "expected and required for camera access to work.\n"
    )

    threading.Timer(1.2, open_host_screen).start()
    socketio.start_background_task(monitor_lan_ip)

    if ASYNC_MODE == "eventlet":
        ssl_kwargs = {"certfile": CERT_PATH, "keyfile": KEY_PATH}
    else:
        ssl_kwargs = {"ssl_context": (CERT_PATH, KEY_PATH)}

    socketio.run(app, host="0.0.0.0", port=PORT, debug=False, **ssl_kwargs)