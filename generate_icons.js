const sharp = require('sharp');
const path = require('path');

const SOURCE = 'C:\\Users\\91830\\.gemini\\antigravity\\brain\\c4895718-7807-4baf-81a9-220b5ea7a0c9\\media__1786547842117.png';
const ICONS_DIR = path.join(__dirname, 'icons');
const sizes = [16, 32, 48, 128];

(async () => {
  // Load and remove white background
  const raw = sharp(SOURCE);
  const { width, height } = await raw.metadata();
  
  // Convert white-ish pixels to transparent
  const buffer = await raw.ensureAlpha().raw().toBuffer();
  const channels = 4;
  for (let i = 0; i < buffer.length; i += channels) {
    const r = buffer[i], g = buffer[i+1], b = buffer[i+2];
    // If pixel is white-ish (all channels > 240), make transparent
    if (r > 240 && g > 240 && b > 240) {
      buffer[i+3] = 0; // alpha = 0
    }
  }
  
  const cleaned = sharp(buffer, { raw: { width, height, channels } }).png();
  
  for (const size of sizes) {
    const outPath = path.join(ICONS_DIR, `icon${size}.png`);
    await cleaned.clone().resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFile(outPath);
    console.log(`✓ icon${size}.png`);
  }
  
  // Also save the full-size transparent logo
  await cleaned.clone().resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFile(path.join(ICONS_DIR, 'logo.png'));
  console.log('✓ logo.png (256px)');
  console.log('Done!');
})();
