/**
 * Official logos for AI coding platforms Preflight supports.
 *
 * Every entry was sourced from the platform's own GitHub repo, brand/press
 * page, or website SVG — never a third-party icon pack. See `source` for the
 * exact URL and `license` for the terms found there. Files live alongside
 * this module under `public/logos/`.
 *
 * Platforms with no official mark found (or whose only SVG exceeded the size
 * budget) are intentionally omitted: kiro's brand icon PNG was 1.3MB before a
 * 1.5KB SVG turned up at kiro.dev/icon.svg, but "Generic MCP" itself has no
 * logo — the `mcp` entry here is the Model Context Protocol mark, for use
 * only where MCP itself (not a specific platform) is being represented.
 *
 * `treatment` says how a mark survives both site themes. Marks that ship
 * their own background render as-is. Single-color marks shipped as black
 * fills are inlined with their colors replaced by currentColor. A dark mark
 * on a transparent raster is inverted under the dark theme.
 */

export type LogoTreatment = 'as-is' | 'current-color' | 'invert-on-dark';

export interface LogoEntry {
  readonly file: string;
  readonly source: string;
  readonly license: string;
  readonly treatment: LogoTreatment;
  /** Crop applied when inlining, for files whose mark sits inside a wider wordmark. */
  readonly viewBox?: string;
}

export const LOGOS = {
  'claude-code': {
    file: 'claude-code.svg',
    source: 'https://claude.com/favicon.svg',
    license: 'Anthropic brand asset (unwritten terms; used to represent Claude Code)',
    treatment: 'as-is',
  },
  kiro: {
    file: 'kiro.svg',
    source: 'https://kiro.dev/icon.svg',
    license: 'AWS/Kiro brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  'amazon-q': {
    file: 'amazon-q.svg',
    source:
      'https://aws.amazon.com/architecture/icons/ (Architecture-Service-Icons package, Arch_Artificial-Intelligence/64/Arch_Amazon-Q_64.svg)',
    license: 'AWS Architecture Icons terms (aws.amazon.com/architecture/icons)',
    treatment: 'as-is',
  },
  droid: {
    file: 'droid.svg',
    source: 'https://factory.ai/favicon.svg',
    license: 'Factory AI brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  codex: {
    file: 'codex.png',
    source:
      'https://marketplace.visualstudio.com/items?itemName=openai.chatgpt (published-by-OpenAI extension icon)',
    license: 'OpenAI brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  opencode: {
    file: 'opencode.png',
    source: 'https://opencode.ai/apple-touch-icon-v3.png',
    license: 'opencode (Anomaly Innovations / sst) brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  'kilo-code': {
    file: 'kilo-code.svg',
    source: 'https://kilocode.ai/favicon/favicon.svg',
    license: 'Kilo Code brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  pi: {
    file: 'pi.svg',
    source: 'https://pi.dev/logo-auto.svg',
    license: 'pi (earendil-works) brand asset (unwritten terms)',
    treatment: 'current-color',
  },
  'github-copilot': {
    file: 'github-copilot.svg',
    source: 'https://github.com/primer/octicons (icons/copilot-24.svg)',
    license: 'MIT (primer/octicons repo LICENSE)',
    treatment: 'current-color',
  },
  'gemini-cli': {
    file: 'gemini-cli.svg',
    source:
      'https://geminicli.com/brandassets/gemini-cli-icon_full-color.svg (Gemini CLI Brand Kit)',
    license: 'Google/Gemini CLI brand kit terms (geminicli.com/brand-kit)',
    treatment: 'as-is',
  },
  cursor: {
    file: 'cursor.svg',
    source: 'https://cursor.com/marketing-static/favicon.svg',
    license: 'Cursor brand asset (unwritten terms)',
    treatment: 'as-is',
  },
  windsurf: {
    file: 'windsurf.svg',
    source:
      'https://exafunction.github.io/public/brand/windsurf-black-symbol.svg (windsurf.com/brand)',
    license: 'Windsurf brand guidelines (windsurf.com/brand)',
    treatment: 'current-color',
  },
  antigravity: {
    file: 'antigravity.png',
    source:
      'https://antigravity.google/assets/image/brand/antigravity-icon__one-color.png (antigravity.google/press)',
    license: 'Google Antigravity press assets terms (antigravity.google/press)',
    treatment: 'invert-on-dark',
  },
  zed: {
    file: 'zed.svg',
    source: 'https://github.com/zed-industries/zed/blob/main/assets/images/zed_logo.svg',
    license: 'Zed brand guidelines (zed.dev/brand)',
    treatment: 'current-color',
  },
  continue: {
    file: 'continue.svg',
    source: 'https://continue.dev/continue-logo-black.svg',
    license: 'Continue.dev brand asset (unwritten terms)',
    treatment: 'current-color',
    viewBox: '28 26.5 50 50',
  },
  cline: {
    file: 'cline.svg',
    source: 'https://cline.bot/brand (assets/branding/brand/General Logos/Bot/SVG/BOT_LIGHT.svg)',
    license: 'Cline brand guidelines (cline.bot/brand)',
    treatment: 'current-color',
  },
  mcp: {
    file: 'mcp.svg',
    source: 'https://modelcontextprotocol.io/favicon.svg',
    license: 'MIT (modelcontextprotocol/docs repo LICENSE)',
    treatment: 'current-color',
  },
} as const satisfies Record<string, LogoEntry>;

export type LogoKey = keyof typeof LOGOS;
