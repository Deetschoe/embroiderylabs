# Deployment Guide

This application is ready for deployment on Coolify, Vercel, or any Python hosting platform.

## Quick Start for Coolify

1. **Push your code to a Git repository** (GitHub, GitLab, etc.)

2. **In Coolify:**
   - Create a new application
   - Connect your Git repository
   - Select "Dockerfile" as build method
   - Coolify will auto-detect the Dockerfile

3. **Environment Variables** (optional):
   - `PORT`: Server port (default: 8000)
   - `FLASK_DEBUG`: Set to `true` for development mode

4. **Deploy!** Coolify will:
   - Build the Docker image
   - Install dependencies
   - Start the Flask server
   - Set up reverse proxy automatically

## File Structure

```
.
├── app.py              # Flask application (main server)
├── home.html           # Landing page
├── app.html            # Main tool interface
├── emb.png             # Logo file
├── requirements.txt    # Python dependencies
├── Dockerfile          # Docker configuration
├── .dockerignore       # Files to exclude from Docker build
├── .gitignore          # Files to exclude from Git
└── vercel.json         # (Optional) For Vercel deployment
```

## Dependencies

- **Flask 3.0.0**: Web framework
- **pyembroidery 1.5.0+**: PES file generation

## Routes

- `/` - Home page (landing)
- `/home.html` - Home page (alternative)
- `/app.html` - Main embroidery tool
- `/api/export-pes` - POST endpoint for PES file generation
- `/api/check` - GET endpoint to check API status
- `/emb.png` - Logo image

## Production Notes

- The app runs on port 8000 by default (configurable via PORT env var)
- Static files are served from the root directory
- Python files and hidden files are protected from being served
- Debug mode is disabled by default in production

## Testing Locally

```bash
# Install dependencies
pip install -r requirements.txt

# Run server
python app.py

# Or with custom port
PORT=3000 python app.py
```

## Troubleshooting

- **PES export not working**: Make sure `pyembroidery` is installed
- **Static files not loading**: Check file paths and permissions
- **Port conflicts**: Change PORT environment variable
