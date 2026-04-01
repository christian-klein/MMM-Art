const sharp = require('sharp');
const path = require('path');

const files = [
    '/home/cdk2128/MagicMirror/modules/MMM-Art/public/cache/orig_Q151047.jpg',
    '/home/cdk2128/MagicMirror/modules/MMM-Art/public/cache/orig_Q208758.jpg'
];

async function check() {
    for (const file of files) {
        try {
            const meta = await sharp(file).metadata();
            console.log(`File: ${path.basename(file)}`);
            console.log(`  Dimensions: ${meta.width}x${meta.height}`);
            console.log(`  Format: ${meta.format}`);
            console.log(`  Space: ${meta.space}`);
            console.log('---');
        } catch (e) {
            console.error(`Error reading ${file}:`, e.message);
        }
    }
}

check();
