import os
import sys

# Make `main` and `pipeline` importable the same way uvicorn runs them
# (working directory = backend/).
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Run Celery tasks inline — no Redis required for the test suite.
# Must be set before jobs.celery_app is imported.
os.environ.setdefault("BHUVAN_EAGER", "1")
