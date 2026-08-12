const fs = require('fs');
let c = fs.readFileSync('character_bible.js', 'utf8');
c = c.replace(/\]\r?\n\s+"image"/g, '],\n    "image"');
fs.writeFileSync('character_bible.js', c);
