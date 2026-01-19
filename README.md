# Embroidery Digitizer

Professional embroidery design tool for creating PES files compatible with Brother/Babylock machines.

## Features

- Vector drawing tools (shapes, lines, paths)
- Image tracing support
- Multiple stitch types (fill, satin, running)
- PES file export
- Dark/Light mode
- Modern, minimalist UI

## Deployment to Coolify (Recommended)

Coolify is the recommended deployment platform as it supports native dependencies (C extensions) required by `pyembroidery`.

### Step 1: Connect Your Repository

1. Log into your Coolify dashboard
2. Click **"New Resource"** → **"Application"**
3. Select **"GitHub"** or **"Git"** as your source
4. Connect your repository: `https://github.com/Deetschoe/embroiderylabs`
5. Select the **`main`** branch

### Step 2: Configure the Application

1. **Build Pack**: Select **"Dockerfile"** (Coolify will auto-detect it)
2. **Port**: Set to **`8000`** (already configured in Dockerfile)
3. **Environment Variables** (optional):
   - `PORT=8000` (usually auto-set by Coolify)
   - `FLASK_DEBUG=False` (for production)

### Step 3: Add Custom Domain

1. In your Coolify application settings, go to **"Domains"** section
2. Click **"Add Domain"**
3. Enter your custom domain (e.g., `embroiderylabs.com` or `app.embroiderylabs.com`)
4. Coolify will show you DNS records to add:
   - **Type**: `A` or `CNAME`
   - **Name**: `@` (for root) or `app` (for subdomain)
   - **Value**: Your Coolify server's IP address or domain
5. Add these DNS records in your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)
6. Wait for DNS propagation (usually 5-30 minutes)
7. Coolify will automatically provision SSL certificate via Let's Encrypt

### Step 4: Deploy

1. Click **"Deploy"** or **"Save & Deploy"**
2. Coolify will:
   - Build your Docker image
   - Install all dependencies (including `pyembroidery` with C extensions)
   - Start your Flask application
   - Set up reverse proxy with SSL

### Troubleshooting

- **Build fails**: Check that `gcc` is installed (already in Dockerfile)
- **Port issues**: Ensure port is set to `8000` in Coolify settings
- **Domain not working**: Verify DNS records are correct and propagated (use `dig yourdomain.com`)

## Deployment to Vercel (Alternative)

Note: Vercel may have issues with `pyembroidery`'s native dependencies. Use Coolify if possible.

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
