import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');
const TEST_FILE = join(SOURCE_ROOT, 'encoding.mojibake.test.ts');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MOJIBAKE_MARKERS = [
  '娴嬮',
  '婵炴垶',
  '浠婂ぉ宸茬粡',
  '鏃犳潈杩涜',
  '閺冪姵娼堟潻',
];

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    const extension = fullPath.slice(fullPath.lastIndexOf('.'));
    if (SOURCE_EXTENSIONS.has(extension)) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('source text integrity', () => {
  it('does not contain known mojibake markers', () => {
    const hits: string[] = [];

    for (const file of collectSourceFiles(SOURCE_ROOT)) {
      if (file === TEST_FILE) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/u);

      lines.forEach((line, index) => {
        for (const marker of MOJIBAKE_MARKERS) {
          if (!line.includes(marker)) continue;
          hits.push(`${relative(process.cwd(), file)}:${index + 1} contains "${marker}"`);
        }
      });
    }

    expect(hits).toEqual([]);
  });
});
