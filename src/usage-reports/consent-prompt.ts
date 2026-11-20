/**
 * A Clack-styled single choice with no default answer. Focus starts on the
 * first option, but nothing is chosen until Space picks the focused option,
 * or an option's shortcut key picks it, so Enter alone can't answer. Clack's
 * `select` can't do this: its focused option is always its value.
 */

import { styleText } from 'node:util';
import { Prompt } from '@clack/core';
import { S_BAR, S_BAR_END, S_RADIO_ACTIVE, S_RADIO_INACTIVE, symbol } from '@clack/prompts';

export interface ConsentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  /** A letter that chooses this option, shown after the label as "(y)". */
  readonly key?: string;
}

export interface ConsentPromptOptions<T extends string> {
  readonly message: string;
  readonly options: readonly ConsentOption<T>[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

export const NOTHING_CHOSEN_HINT = 'Choose an answer with Space or its letter, then press Enter.';

class ConsentPrompt<T extends string> extends Prompt<T> {
  focus = 0;

  constructor(opts: ConsentPromptOptions<T>) {
    super(
      {
        input: opts.input as never,
        output: opts.output as never,
        validate: (value) => (value === undefined ? NOTHING_CHOSEN_HINT : undefined),
        render() {
          return render(this as unknown as ConsentPrompt<T>, opts);
        },
      },
      false,
    );
    const count = opts.options.length;
    this.on('cursor', (key) => {
      if (key === 'up' || key === 'left') this.focus = (this.focus - 1 + count) % count;
      else if (key === 'down' || key === 'right') this.focus = (this.focus + 1) % count;
      else if (key === 'space') this._setValue(opts.options[this.focus]?.value);
    });
    this.on('key', (char, key) => {
      if (key?.name === 'tab') {
        this.focus = (this.focus + (key.shift ? count - 1 : 1)) % count;
        return;
      }
      const i = opts.options.findIndex((o) => o.key && o.key === char?.toLowerCase());
      if (i < 0) return;
      this.focus = i;
      this._setValue(opts.options[i]?.value);
    });
  }
}

function render<T extends string>(p: ConsentPrompt<T>, opts: ConsentPromptOptions<T>): string {
  const title = `${styleText('gray', S_BAR)}\n${symbol(p.state)}  ${opts.message}\n`;
  const chosen = opts.options.find((o) => o.value === p.value);
  if (p.state === 'submit') {
    return `${title}${styleText('gray', S_BAR)}  ${styleText('dim', chosen?.label ?? '')}`;
  }
  if (p.state === 'cancel') {
    return `${title}${styleText('gray', S_BAR)}  ${styleText(['strikethrough', 'dim'], 'Cancelled')}`;
  }
  const color = p.state === 'error' ? 'yellow' : 'cyan';
  const bar = styleText(color, S_BAR);
  const rows = opts.options.map((o, i) => {
    const focused = i === p.focus;
    const radio =
      o.value === p.value
        ? styleText('green', S_RADIO_ACTIVE)
        : styleText(focused ? 'cyan' : 'dim', S_RADIO_INACTIVE);
    const text = o.key ? `${o.label} (${o.key})` : o.label;
    const label = focused ? styleText('underline', text) : styleText('dim', text);
    const hint = o.hint && focused ? ` ${styleText('dim', `(${o.hint})`)}` : '';
    // The pointer shows focus without color, for NO_COLOR terminals.
    return `${bar} ${focused ? styleText('cyan', '›') : ' '} ${radio} ${label}${hint}`;
  });
  const footer =
    p.state === 'error'
      ? styleText('yellow', p.error)
      : styleText('dim', '↑/↓ or Tab to move • Space or letter: choose • Enter: confirm');
  return `${title}${rows.join('\n')}\n${bar}  ${footer}\n${styleText(color, S_BAR_END)}\n`;
}

/** Resolves to the chosen value, or Clack's cancel symbol on Ctrl-C. */
export function consentSelect<T extends string>(
  opts: ConsentPromptOptions<T>,
): Promise<T | symbol | undefined> {
  return new ConsentPrompt(opts).prompt();
}
