#!/bin/bash
set -e

# Get port from environment variable or use default
PORT=${PORT:-8000}

echo "Starting Embroidery Digitizer on port $PORT"

# Start gunicorn
exec gunicorn \
    --bind "0.0.0.0:${PORT}" \
    --workers 2 \
    --timeout 120 \
    --access-logfile - \
    --error-logfile - \
    --preload \
    app:app
