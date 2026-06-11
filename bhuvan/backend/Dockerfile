# BHUVAN backend image — serves both the FastAPI gateway and the Celery worker.
# Build context is the repo root (see docker-compose.yml).
FROM python:3.10-slim

WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend

EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
