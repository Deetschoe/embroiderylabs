# Embroidery Digitizer

Professional embroidery design tool for creating PES files compatible with Brother/Babylock machines.

## Features

- Vector drawing tools (shapes, lines, paths)
- Image tracing support
- Multiple stitch types (fill, satin, running)
- PES file export
- Dark/Light mode
- Modern, minimalist UI

## Deployment to Vercel

1. Install Vercel CLI (if not already installed):
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   vercel
   ```

3. The `vercel.json` file is already configured for:
   - Python backend API routes
   - Static file serving
   - Proper routing

## Local Development

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the server:
   ```bash
   python app.py
   ```

3. Open http://localhost:8000 in your browser

## File Structure

- `home.html` - Landing page
- `app.html` - Main tool interface
- `app.py` - Flask backend for PES export
- `vercel.json` - Vercel deployment configuration
- `emb.png` - Logo image (add your logo file)

## Notes

- Make sure to add your `emb.png` logo file to the root directory
- Update GitHub repository URL in `home.html` (line with `yourusername/embroidma`)
- The tool requires `pyembroidery` library for PES file generation
