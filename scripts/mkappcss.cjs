const fs = require('fs');
const src = fs.readFileSync('web/studio.css', 'utf8');
const css = src.replace(/^@import "tailwindcss";\s*/, '');
const head = '/* @heroui/styles 已 @import tailwindcss；这里只补组件类 */\n@import "@heroui/styles";\n\n';
fs.writeFileSync('web/src/app.css', head + css, 'utf8');
console.log('app.css bytes', fs.statSync('web/src/app.css').size);
