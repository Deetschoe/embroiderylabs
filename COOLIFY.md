# Coolify Deployment Guide

This application is ready to deploy on Coolify.

## Quick Setup

1. **Create a new application in Coolify**
   - Choose "Dockerfile" as the build method
   - Point to this repository

2. **Environment Variables** (optional)
   - `PORT`: Server port (default: 8000)
   - `FLASK_DEBUG`: Set to `true` for development (default: `false`)

3. **Build Settings**
   - Build Command: (auto-detected from Dockerfile)
   - Start Command: (auto-detected from Dockerfile)

4. **Port Configuration**
   - Exposed Port: 8000
   - Coolify will handle the reverse proxy automatically

## What's Included

- Flask backend for PES file generation
- Static file serving for HTML/CSS/JS
- API endpoints for embroidery export
- Production-ready configuration

## Dependencies

All dependencies are listed in `requirements.txt`:
- Flask 3.0.0
- pyembroidery 1.5.0+

The Dockerfile handles all installation automatically.

## File Structure

```
.
├── app.py              # Flask application
├── home.html           # Landing page
├── app.html            # Main tool interface
├── emb.png             # Logo file
├── requirements.txt    # Python dependencies
├── Dockerfile         # Docker configuration
└── vercel.json        # (Optional) For Vercel deployment
```

## Notes

- Make sure `emb.png` is in the root directory
- The app serves static files from the root directory
- API routes are under `/api/`
- Main pages: `/` (home), `/app.html` (tool), `/home.html` (home)
