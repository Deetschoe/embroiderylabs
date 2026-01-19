#!/bin/bash

# Get port from environment variable or use default
PORT=${PORT:-8000}

echo "=========================================="
echo "Starting Embroidery Digitizer"
echo "Port: $PORT"
echo "Working directory: $(pwd)"
echo "Python version: $(python --version)"
echo "=========================================="

# Test if app.py exists and can be imported
echo "Testing app import..."
python -c "import app; print('✓ App imported successfully')" || {
    echo "✗ Failed to import app"
    exit 1
}

echo "Starting gunicorn..."

# Start gunicorn with error handling
exec gunicorn \
    --bind "0.0.0.0:${PORT}" \
    --workers 2 \
    --timeout 120 \
    --access-logfile - \
    --error-logfile - \
    --log-level info \
    --capture-output \
    app:app
