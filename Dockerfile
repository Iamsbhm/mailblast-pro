# ── Python backend ──────────────────────────────────────────────────────────
FROM python:3.11-slim

# Install FFmpeg (required for video processing)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        && apt-get clean && \
        rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first (for Docker layer caching)
COPY clipper_api/requirements.txt ./requirements.txt

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy all API source files
COPY clipper_api/ ./

# Create temp directories
RUN mkdir -p uploads clips jobs

# Expose Flask port
EXPOSE 5000

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV FLASK_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:5000/api/health || exit 1

# Run the Flask app
CMD ["python", "app.py"]
