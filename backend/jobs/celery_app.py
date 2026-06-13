"""Celery application for async terrain analysis jobs.

Broker/result backend: Redis (``BHUVAN_REDIS_URL``, default local).
Dev/test mode: set ``BHUVAN_EAGER=1`` to run tasks inline without Redis —
terminal job state is persisted to disk (result.json / error.json), so the
status endpoint works identically in both modes.

Run a worker (Windows needs --pool=solo):
    celery -A jobs.celery_app.celery_app worker --loglevel=info --pool=solo
"""

from __future__ import annotations

import os

from celery import Celery

REDIS_URL = os.environ.get("BHUVAN_REDIS_URL", "redis://127.0.0.1:6379/0")
EAGER = os.environ.get("BHUVAN_EAGER", "0") == "1"

celery_app = Celery("bhuvan", broker=REDIS_URL, backend=REDIS_URL, include=["jobs.tasks"])
celery_app.conf.update(
    task_track_started=True,
    result_expires=3600,
    broker_connection_retry_on_startup=True,
    task_always_eager=EAGER,
    # Propagate in eager mode so the API route can capture the failure and
    # persist it to disk (mirrors the worker's error.json path).
    task_eager_propagates=True,
)
