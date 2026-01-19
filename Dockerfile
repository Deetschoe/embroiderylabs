FROM python:3.10-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Test that the app can be imported (catch errors early)
RUN python -c "import app; print('✓ App imports successfully')" || (echo "✗ App import failed" && exit 1)

# Expose port
EXPOSE 8000

# Set environment variables
ENV FLASK_APP=app.py
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Run gunicorn directly - use shell form to allow PORT variable expansion
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-8000} --workers 2 --timeout 120 --access-logfile - --error-logfile - --log-level info app:app"]