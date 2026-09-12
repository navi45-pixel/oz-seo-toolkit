'use strict';
/**
 * Inlines CSS + JS into the HTML pages so they render correctly even in
 * sandboxed previews without network access (and in the live preview).
 */
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, 'public');

const css = fs.readFileSync(path.join(pub, 'css', 'styles.css'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
const blJs = fs.readFileSync(path.join(pub, 'js', 'backlinks.js'), 'utf8');

if (appJs.includes('</script>') || blJs.includes('</script>') || css.includes('</style>')) {
  console.error('Unsafe token found in assets — aborting inline build.');
  process.exit(1);
}

/* Replaces external tags OR previously-inlined blocks (idempotent rebuilds).
   Assets are guaranteed not to contain '</style>' / '</script>'. */
let index = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
index = index.replace(/<link rel="stylesheet" href="\/css\/styles\.css">/, '<style>' + css + '</style>')
             .replace(/<script src="\/js\/app\.js"><\/script>/, '<script>' + appJs + '</script>')
             .replace(/<style>[\s\S]*?<\/style>/, '<style>' + css + '</style>')
             .replace(/<script>[\s\S]*?<\/script>(\s*<\/body>)/, '<script>' + appJs + '</script>$1');
fs.writeFileSync(path.join(pub, 'index.html'), index);

let backlinks = fs.readFileSync(path.join(pub, 'backlinks.html'), 'utf8');
backlinks = backlinks.replace(/<link rel="stylesheet" href="\/css\/styles\.css">/, '<style>' + css + '</style>')
                     .replace(/<script src="\/js\/backlinks\.js"><\/script>/, '<script>' + blJs + '</script>')
                     .replace(/<style>[\s\S]*?<\/style>/, '<style>' + css + '</style>')
                     .replace(/<script>[\s\S]*?<\/script>(\s*<\/body>)/, '<script>' + blJs + '</script>$1');
fs.writeFileSync(path.join(pub, 'backlinks.html'), backlinks);

const skillsPath = path.join(pub, 'skills.html');
if (fs.existsSync(skillsPath)) {
  let skills = fs.readFileSync(skillsPath, 'utf8');
  skills = skills.replace(/<link rel="stylesheet" href="\/css\/styles\.css">/, '<style>' + css + '</style>')
                 .replace(/<style>[\s\S]*?<\/style>/, '<style>' + css + '</style>');
  fs.writeFileSync(skillsPath, skills);
}

console.log('Inlined OK:',
  'index.html', fs.statSync(path.join(pub, 'index.html')).size, 'bytes |',
  'backlinks.html', fs.statSync(path.join(pub, 'backlinks.html')).size, 'bytes |',
  'skills.html', fs.existsSync(skillsPath) ? fs.statSync(skillsPath).size : 0, 'bytes');
