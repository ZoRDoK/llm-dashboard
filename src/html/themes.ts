import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createLogger } from '../logger.js';

const log = createLogger('themes');

const __dirname = import.meta.dirname;

const THEMES_DIR = resolve(__dirname, '..', '..', 'design', 'themes');

const THEME_NAMES = [
  'ocean-depths',
  'sunset-boulevard',
  'forest-canopy',
  'neon-nights',
  'paper-ink',
  'arctic-frost',
  'desert-dunes',
  'cyberpunk',
  'zen-garden',
  'retro-wave',
];

let themeCSS = '';

for (const [idx, name] of THEME_NAMES.entries()) {
  const padded = String(idx + 1).padStart(2, '0');
  const path = resolve(THEMES_DIR, `theme-${padded}-${name}.css`);

  try {
    themeCSS += readFileSync(path, 'utf-8');
  } catch {
    log.warn({ path }, 'Theme file not found');
  }
}

// Prebuilt Tailwind bundle (see tailwind.config.js); serves instead of the CDN script.
const TAILWIND_CSS_PATH = resolve(__dirname, '..', '..', 'design', 'tailwind.css');

let tailwindCSS = '';

try {
  tailwindCSS = readFileSync(TAILWIND_CSS_PATH, 'utf-8');
} catch {
  log.warn({ path: TAILWIND_CSS_PATH }, 'Tailwind CSS not found; run: npm run tailwind');
}

export { THEME_NAMES, tailwindCSS, themeCSS };
