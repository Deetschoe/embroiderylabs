#!/usr/bin/env python3
"""
Embroidery Digitizer - Creative Tools for Future Makers
Flask backend with proper PES file generation for Brother/Babylock machines
Uses pyembroidery library for reliable PES file generation
"""

from flask import Flask, send_from_directory, request, jsonify, send_file
import json
import io
import os

app = Flask(__name__, static_folder='.', static_url_path='')

# Check if pyembroidery is available
try:
    import pyembroidery
    from pyembroidery.EmbConstant import *
    HAS_PYEMBROIDERY = True
    print("✓ pyembroidery loaded successfully")
except (ImportError, Exception) as e:
    HAS_PYEMBROIDERY = False
    print(f"✗ pyembroidery not available: {e}")
    print("  Install with: pip install pyembroidery")
    print("  App will continue without PES export functionality")

@app.route('/')
def index():
    return send_from_directory('.', 'home.html')

@app.route('/app.html')
def app_page():
    return send_from_directory('.', 'app.html')

@app.route('/home.html')
def home_page():
    return send_from_directory('.', 'home.html')

# Serve static files (images, etc.)
@app.route('/emb.png')
def logo():
    return send_from_directory('.', 'emb.png')

@app.route('/<path:path>')
def static_files(path):
    # Don't serve Python files or sensitive files
    if path.endswith('.py') or path.startswith('.'):
        return "Not found", 404
    try:
        return send_from_directory('.', path)
    except:
        return "Not found", 404

@app.route('/api/export-pes', methods=['POST'])
def export_pes():
    """Generate PES file using pyembroidery for proper machine compatibility"""
    if not HAS_PYEMBROIDERY:
        return jsonify({'error': 'pyembroidery not available. Install with: pip install pyembroidery'}), 500
    
    try:
        data = request.get_json()
        stitches = data.get('stitches', [])
        
        if not stitches:
            return jsonify({'error': 'No stitches provided'}), 400
        
        print(f"Received {len(stitches)} stitches for export")
        
        # Create embroidery pattern
        pattern = pyembroidery.EmbPattern()
        
        # Set metadata
        pattern.set_metadata("name", "Embroidma Design")
        pattern.set_metadata("author", "Embroidma")
        
        # Add default thread color (Blue - Brother color #7)
        thread = pyembroidery.EmbThread()
        thread.set_color((59, 130, 246))  # #3b82f6 RGB
        thread.description = "Blue"
        thread.catalog_number = ""
        thread.brand = "Brother"
        thread.chart = "7"  # Brother color chart index
        pattern.add_thread(thread)
        
        # Process stitches
        # Stitches from JS are in 0.1mm units (10 units = 1mm)
        # pyembroidery also uses 0.1mm units, so we can use them directly
        if stitches:
            # Calculate bounds
            min_x = min(s['x'] for s in stitches)
            max_x = max(s['x'] for s in stitches)
            min_y = min(s['y'] for s in stitches)
            max_y = max(s['y'] for s in stitches)
            
            center_x = (min_x + max_x) / 2.0
            center_y = (min_y + max_y) / 2.0
            
            width = max_x - min_x
            height = max_y - min_y
            
            print(f"Raw bounds: ({min_x}, {min_y}) to ({max_x}, {max_y})")
            print(f"Design size: {width/10:.1f}mm x {height/10:.1f}mm")
            print(f"Center: ({center_x/10:.1f}mm, {center_y/10:.1f}mm)")
            
            # Convert stitches to pattern format
            # Center design at origin (0,0)
            last_x, last_y = None, None
            stitch_count = 0
            jump_count = 0
            
            for i, stitch in enumerate(stitches):
                # Center coordinates (convert to int for pyembroidery)
                x = int(round(stitch['x'] - center_x))
                y = int(round(stitch['y'] - center_y))
                
                if last_x is None:
                    # First stitch - move to starting position (no thread)
                    pattern.add_stitch_absolute(MOVE, x, y)
                    last_x, last_y = x, y
                    stitch_count += 1
                else:
                    # Calculate distance in 0.1mm units
                    dx = x - last_x
                    dy = y - last_y
                    dist = (dx * dx + dy * dy) ** 0.5
                    
                    # PES format max stitch distance is 12.7mm = 127 units
                    # If distance is too large, we need to split it
                    if dist > 127:
                        # Split large movement into smaller jumps
                        steps = int(dist / 127) + 1
                        for step in range(1, steps + 1):
                            step_x = int(last_x + (dx * step / steps))
                            step_y = int(last_y + (dy * step / steps))
                            
                            if step == 1:
                                # First step: trim and move
                                pattern.add_stitch_absolute(TRIM, last_x, last_y)
                                pattern.add_stitch_absolute(MOVE, step_x, step_y)
                            else:
                                # Subsequent steps: just move
                                pattern.add_stitch_absolute(MOVE, step_x, step_y)
                        
                        last_x, last_y = x, y
                        jump_count += 1
                    else:
                        # Normal stitch (within max distance)
                        pattern.add_stitch_absolute(STITCH, x, y)
                        stitch_count += 1
                        last_x, last_y = x, y
            
            # End pattern
            if last_x is not None:
                pattern.add_stitch_absolute(END, last_x, last_y)
        
        print(f"Pattern created: {stitch_count} stitches, {jump_count} jumps")
        
        # Get pattern bounds
        bounds = pattern.bounds()
        if bounds:
            print(f"Pattern bounds: {bounds}")
        
        # Generate PES file using pyembroidery
        output = io.BytesIO()
        
        # Use PES version 1 (most compatible)
        settings = {
            "version": 1.0,  # PES version 1
            "truncated": False
        }
        
        pyembroidery.write_pes(pattern, output, settings)
        output.seek(0)
        pes_data = output.read()
        
        print(f"PES file generated: {len(pes_data)} bytes")
        
        if not pes_data:
            return jsonify({'error': 'Failed to generate PES file'}), 500
        
        # Return file
        return send_file(
            io.BytesIO(pes_data),
            mimetype='application/octet-stream',
            as_attachment=True,
            download_name='embroidery.pes'
        )
        
    except Exception as e:
        print(f"PES Export Error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/check')
def check_api():
    """Check if the API and pyembroidery are available"""
    version = None
    if HAS_PYEMBROIDERY:
        try:
            version = getattr(pyembroidery, '__version__', 'unknown')
        except:
            version = 'installed'
    return jsonify({
        'status': 'ok',
        'pyembroidery': HAS_PYEMBROIDERY,
        'version': version
    })

@app.route('/health')
def health():
    """Health check endpoint for Coolify"""
    return jsonify({'status': 'healthy'}), 200

# Print startup info
print("Embroidery Digitizer - Creative Tools")
if HAS_PYEMBROIDERY:
    print("   ✓ Server-side PES export available (pyembroidery)")
else:
    print("   ✗ Install pyembroidery for PES support:")
    print("     pip install pyembroidery")
print("")

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    debug = os.environ.get('FLASK_DEBUG', 'False').lower() == 'true'
    
    print(f"   Server starting on port {port}")
    app.run(debug=debug, host='0.0.0.0', port=port)
