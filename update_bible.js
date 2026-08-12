const fs = require('fs');
let content = fs.readFileSync('character_bible.js', 'utf8');
const files = fs.readdirSync('assets');
const mapping = {};
files.forEach(f => {
  const name = f.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').toLowerCase();
  mapping[name] = 'assets/' + f;
});

const updated = content.replace(/\{([^}]+)\}/g, (match, inner) => {
  const nameMatch = inner.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameMatch) {
    const name = nameMatch[1].toLowerCase();
    let bestMatch = '';
    Object.keys(mapping).forEach(k => {
      if (name.includes(k) || k.includes(name)) bestMatch = mapping[k];
    });
    if (bestMatch) {
      return match.replace('}', '  "image": "' + bestMatch + '"\n    }');
    }
  }
  return match;
});
fs.writeFileSync('character_bible.js', updated);
