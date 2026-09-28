import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoScenes, demoVideo } from './demo-scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'public', 'demo');
await mkdir(destination, { recursive: true });

const assets = [
  ...demoScenes.map((scene) => ({
    file: scene.file,
    source: `https://images.unsplash.com/${scene.photo}?w=960&q=78&fit=crop&fm=jpg`,
  })),
  demoVideo,
];

// Limit downloads so regenerating the optional demo remains gentle on the source hosts.
for (let index = 0; index < assets.length; index += 4) {
  await Promise.all(assets.slice(index, index + 4).map(async ({ file, source }) => {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length < 1000) throw new Error(`${file}: unexpected empty asset`);
    await writeFile(path.join(destination, file), content);
    console.log(`Saved ${file} (${Math.round(content.length / 1024)} KB)`);
  }));
}
