import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const input = fileURLToPath(new URL('../styles/tailwind.css', import.meta.url));
const output = fileURLToPath(new URL('../public/tailwind.css', import.meta.url));
const result = await postcss([tailwindcss({ optimize: true })]).process(await readFile(input, 'utf8'), { from: input, to: output });
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(output, result.css);
console.log('Estilos generados en public/tailwind.css');
