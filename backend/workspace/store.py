"""Persistent workspace — analyses and reports survive restarts.

SQLite (stdlib, zero-install) keyed by job_id. Stores analysis metadata
plus the intelligence bundle; the heavy rasters stay in the artifact
files on disk. Reports are rendered markdown stored alongside.

Schema:
    analyses(job_id, name, source, body, created_at, meta_json, intel_json)
    reports(report_id, job_id, kind, created_at, markdown)
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path(os.environ.get(
    "ARES_WORKSPACE_DB",
    Path(__file__).resolve().parent.parent / "workspace.db",
))

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _lock, _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS analyses (
                job_id     TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                source     TEXT NOT NULL,
                body       TEXT NOT NULL DEFAULT 'unknown',
                created_at REAL NOT NULL,
                meta_json  TEXT NOT NULL,
                intel_json TEXT
            );
            CREATE TABLE IF NOT EXISTS reports (
                report_id  TEXT PRIMARY KEY,
                job_id     TEXT NOT NULL REFERENCES analyses(job_id),
                kind       TEXT NOT NULL,
                created_at REAL NOT NULL,
                markdown   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reports_job ON reports(job_id);
            """
        )


def save_analysis(payload) -> None:
    """Record an AnalysisPayload. Raster data is NOT stored (artifacts on disk)."""
    meta = payload.metadata
    intel = payload.intelligence
    with _lock, _connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO analyses
               (job_id, name, source, body, created_at, meta_json, intel_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                payload.job_id,
                meta.terrain_name,
                meta.source,
                getattr(meta, "body", None) or "unknown",
                time.time(),
                meta.model_dump_json(),
                intel.model_dump_json() if intel else None,
            ),
        )


def list_analyses(limit: int = 50) -> list[dict]:
    with _lock, _connect() as conn:
        rows = conn.execute(
            """SELECT job_id, name, source, body, created_at
               FROM analyses ORDER BY created_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_analysis(job_id: str) -> dict | None:
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT * FROM analyses WHERE job_id = ?", (job_id,)
        ).fetchone()
    if row is None:
        return None
    record = dict(row)
    record["metadata"] = json.loads(record.pop("meta_json"))
    intel = record.pop("intel_json")
    record["intelligence"] = json.loads(intel) if intel else None
    return record


def save_report(job_id: str, kind: str, markdown: str) -> str:
    report_id = uuid.uuid4().hex[:12]
    with _lock, _connect() as conn:
        conn.execute(
            """INSERT INTO reports (report_id, job_id, kind, created_at, markdown)
               VALUES (?, ?, ?, ?, ?)""",
            (report_id, job_id, kind, time.time(), markdown),
        )
    return report_id


def list_reports(job_id: str) -> list[dict]:
    with _lock, _connect() as conn:
        rows = conn.execute(
            """SELECT report_id, job_id, kind, created_at FROM reports
               WHERE job_id = ? ORDER BY created_at DESC""",
            (job_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_report(report_id: str) -> dict | None:
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT * FROM reports WHERE report_id = ?", (report_id,)
        ).fetchone()
    return dict(row) if row else None
