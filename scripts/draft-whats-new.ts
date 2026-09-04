import { readFileSync } from 'node:fs';

const versionPattern = /\b(\d+)\.(\d+)\.(\d+)\b/g;

function highestVersion(text: string): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  for (const m of text.matchAll(versionPattern)) {
    const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (compare(v, best) > 0) best = v;
  }
  return best;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const covered = highestVersion(readFileSync('docs/WHATS_NEW.md', 'utf8'));
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const sections = changelog.split(/^(?=## \[)/m).slice(1);
const pending = sections.filter((s) => {
  const m = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(s);
  return m !== null && compare([Number(m[1]), Number(m[2]), Number(m[3])], covered) > 0;
});

if (pending.length === 0) {
  console.log(`What's New already covers everything through ${covered.join('.')}.`);
} else {
  console.log(
    `${pending.length} release(s) newer than ${covered.join('.')} are not in docs/WHATS_NEW.md yet:\n`,
  );
  console.log(pending.join('\n'));
}
