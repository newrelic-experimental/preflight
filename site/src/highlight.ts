export interface Segment {
  readonly text: string;
  readonly figure: boolean;
}

const FIGURE = /\$?\d(?:[\d,.]*\d)?[%KM]?/g;

export function emphasizeNumbers(text: string): readonly Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(FIGURE)) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index), figure: false });
    segments.push({ text: m[0], figure: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), figure: false });
  return segments;
}
