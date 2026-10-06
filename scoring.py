"""
Scoring for the reporting app.

Points are stored as an event log (score_events), never as a single
running total, so mistakes can be undone with a negative award and the
leaderboard can show "+150" popups. A player's score is always
SUM(points) over their events.

Put this file next to app.py. See the 5 small edits to app.py.
"""

from datetime import datetime

from flask import jsonify, request

REGISTER_BONUS = 50   # points for finishing registration (set to 0 to disable)
MAX_POINTS = 10000    # sanity cap on a single award, positive or negative


def init_scoring(get_db):
    """Create the score table. Call right after init_db()."""
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS score_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                reason TEXT NOT NULL,
                points INTEGER NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_score_events_user "
            "ON score_events(user_id)"
        )
        conn.commit()


def get_scores(conn):
    """Return {user_id: total_points} for everyone who has any events."""
    rows = conn.execute(
        "SELECT user_id, SUM(points) AS total FROM score_events GROUP BY user_id"
    ).fetchall()
    return {r["user_id"]: r["total"] for r in rows}


def get_score(conn, user_id):
    row = conn.execute(
        "SELECT COALESCE(SUM(points), 0) AS total FROM score_events WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    return row["total"]


def award(conn, user_id, points, reason):
    """
    Add one score event and return the player's new total.
    Does NOT commit -- the caller commits (so it can be part of a larger
    transaction, e.g. registration).
    """
    conn.execute(
        "INSERT INTO score_events (user_id, reason, points, created_at) "
        "VALUES (?, ?, ?, ?)",
        (user_id, reason, points, datetime.now().isoformat(timespec="seconds")),
    )
    return get_score(conn, user_id)


def delete_for_users(conn, ids):
    """Drop score history for removed attendees. Caller commits."""
    if not ids:
        return
    placeholders = ",".join("?" * len(ids))
    conn.execute(f"DELETE FROM score_events WHERE user_id IN ({placeholders})", ids)


def register_scoring(app, socketio, get_db):
    """Register the score routes. Call after get_db is defined."""

    @app.route("/api/score/award", methods=["POST"])
    def award_points():
        """
        Body: {"ids": [1, 2], "points": 150, "reason": "manual"}
        Negative points subtract. Broadcasts score_update to every screen.
        """
        data = request.get_json(silent=True) or {}
        ids = data.get("ids", [])
        reason = str(data.get("reason") or "manual")[:40]

        if not isinstance(ids, list) or not ids:
            return jsonify({"ok": False, "error": "no_ids"}), 400
        try:
            ids = [int(i) for i in ids]
            points = int(data.get("points"))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "bad_input"}), 400
        if points == 0 or abs(points) > MAX_POINTS:
            return jsonify({"ok": False, "error": "bad_points"}), 400

        updates = []
        with get_db() as conn:
            placeholders = ",".join("?" * len(ids))
            valid = [
                r["id"]
                for r in conn.execute(
                    f"SELECT id FROM users WHERE id IN ({placeholders})", ids
                ).fetchall()
            ]
            for uid in valid:
                new_score = award(conn, uid, points, reason)
                updates.append({"id": uid, "score": new_score, "delta": points})
            conn.commit()

        if updates:
            socketio.emit("score_update", updates)
        return jsonify({"ok": True, "updates": updates})

    @app.route("/api/score/reset", methods=["POST"])
    def reset_scores():
        """Wipe all points (players stay). Everyone goes back to 0."""
        with get_db() as conn:
            conn.execute("DELETE FROM score_events")
            ids = [r["id"] for r in conn.execute("SELECT id FROM users").fetchall()]
            conn.commit()
        socketio.emit(
            "score_update", [{"id": i, "score": 0, "delta": 0} for i in ids]
        )
        return jsonify({"ok": True})