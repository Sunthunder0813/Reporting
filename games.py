"""
Host-triggered live effects: spin the wheel and red light.

Wheel fairness + sync:
  * The winner AND the exact landing spot are chosen here, once, on the server.
  * The event carries a shared start time (server clock) and the spin length,
    so every screen runs the same timeline and stops at the same moment.
  * A second spin is refused while one is still running.
  * A screen that connects/reloads mid-spin asks for the current wheel and
    gets the same one (same winner, same timeline), not a new draw.

Put this file next to app.py.
"""

import random
import time
import uuid

from flask import jsonify, request, url_for
from flask_socketio import emit

SPIN_MS = 5000            # how long the wheel spins. The one number to change.
LEAD_MS = 1200            # screens show the wheel, then all start together after this
REVEAL_BUFFER_MS = 2500   # extra time after the spin before a new spin is allowed
REPLAY_WINDOW_MS = 60000  # late joiners still see the wheel for this long after it lands

# Red light state. `on` = alert EVERYONE. `users` = individual attendees being alerted
# on their own. It stays on until the host turns it off.
# Every change bumps `seq`, and `boot` is new on every server start, so a screen can
# tell a fresh state from a stale one (see the polling fallback in the client).
_red = {"on": False, "users": set(), "seq": 0, "boot": uuid.uuid4().hex[:8]}

# The current/last wheel. Only ever one at a time.
_wheel = {"payload": None, "closed": True, "next_id": 1}


def _now_ms():
    return int(time.time() * 1000)


def register_games(app, socketio, get_db):
    """Register the game routes. Call after get_db is defined."""

    # ---- Spin the wheel ----------------------------------------------
    @app.route("/trigger-wheel", methods=["POST"])
    def trigger_wheel():
        now = _now_ms()
        current = _wheel["payload"]
        if (
            current
            and not _wheel["closed"]
            and now < current["start_at"] + current["spin_ms"] + REVEAL_BUFFER_MS
        ):
            return jsonify({"ok": False, "error": "busy"}), 409

        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, full_name, photo_filename FROM users ORDER BY id ASC"
            ).fetchall()

        if not rows:
            return jsonify({"ok": False, "error": "no_attendees"}), 400

        candidates = [
            {
                "id": r["id"],
                "full_name": r["full_name"],
                "photo_url": url_for("static", filename=f"uploads/{r['photo_filename']}"),
            }
            for r in rows
        ]
        winner = random.choice(candidates)

        payload = {
            "spin_id": _wheel["next_id"],
            "candidates": candidates,
            "winner_id": winner["id"],
            # Where inside the winner's slice the pointer stops (-0.35..+0.35 of a slice)
            "jitter": random.uniform(-0.35, 0.35),
            "spin_ms": SPIN_MS,
            "start_at": now + LEAD_MS,   # server clock, ms
            "server_time": now,
        }
        _wheel["next_id"] += 1
        _wheel["payload"] = payload
        _wheel["closed"] = False

        socketio.emit("wheel_spin", payload)
        return jsonify(
            {"ok": True, "winner": winner, "spin_ms": SPIN_MS, "lead_ms": LEAD_MS}
        )

    @socketio.on("wheel_state_request")
    def wheel_state_request():
        """A screen just (re)connected: give it the wheel that is currently active."""
        payload = _wheel["payload"]
        if payload is None or _wheel["closed"]:
            return
        now = _now_ms()
        if now > payload["start_at"] + payload["spin_ms"] + REPLAY_WINDOW_MS:
            return
        emit("wheel_spin", dict(payload, server_time=now))

    @app.route("/close-wheel", methods=["POST"])
    def close_wheel():
        _wheel["closed"] = True
        socketio.emit("wheel_close", {})
        return jsonify({"ok": True})

    # ---- Red light: alert everyone, or one attendee ---------------------
    def _red_payload():
        return {
            "on": _red["on"],
            "users": sorted(_red["users"]),
            "seq": _red["seq"],
            "boot": _red["boot"],
        }

    def _broadcast_red():
        _red["seq"] += 1
        socketio.emit("red_state", _red_payload())

    @app.route("/trigger-red-light", methods=["POST"])
    def trigger_red_light():
        """Alert EVERYONE."""
        _red["on"] = True
        _broadcast_red()
        return jsonify(dict(_red_payload(), ok=True))

    @app.route("/stop-red-light", methods=["POST"])
    def stop_red_light():
        """Stop ALL alerts (everyone and any individual ones)."""
        _red["on"] = False
        _red["users"].clear()
        _broadcast_red()
        return jsonify(dict(_red_payload(), ok=True))

    @app.route("/api/red-user", methods=["POST"])
    def red_user():
        """Body: {"id": 3, "on": true}. Alert (or stop alerting) ONE attendee."""
        data = request.get_json(silent=True) or {}
        try:
            uid = int(data.get("id"))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "bad_id"}), 400
        turn_on = bool(data.get("on"))

        if turn_on:
            with get_db() as conn:
                exists = conn.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone()
            if not exists:
                return jsonify({"ok": False, "error": "no_such_user"}), 404
            _red["users"].add(uid)
        else:
            _red["users"].discard(uid)

        _broadcast_red()
        return jsonify(dict(_red_payload(), ok=True))

    @app.route("/api/red-state")
    def red_state():
        """Plain HTTP snapshot. Screens poll this as a safety net in case a
        live socket message is missed (phone asleep, weak Wi-Fi, dead socket)."""
        resp = jsonify(_red_payload())
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @socketio.on("red_state_request")
    def red_state_request():
        """A screen (re)connected or woke up: make it match the real state."""
        emit("red_state", _red_payload())