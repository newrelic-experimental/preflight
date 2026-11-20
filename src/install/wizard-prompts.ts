/**
 * The setup wizard's questions, asked with @clack/prompts. Ctrl-C at any
 * question throws `WizardCancelled`, which `runSetupWizard` reports and exits on.
 */

import { styleText } from 'node:util';
import { confirm, isCancel, password, S_BAR, select, text } from '@clack/prompts';

export class WizardCancelled extends Error {
  constructor() {
    super('Setup cancelled');
    this.name = 'WizardCancelled';
  }
}

export interface TextQuestion {
  readonly message: string;
  /** Shown dimmed while the answer is empty. */
  readonly placeholder?: string;
  /** Returned when the answer is left empty. */
  readonly defaultValue?: string;
  /** Returns an error message, or undefined to accept. Receives the typed answer, '' when empty. */
  readonly validate?: (value: string) => string | undefined;
}

export interface SelectQuestion<T extends string> {
  readonly message: string;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly hint?: string;
  }[];
  readonly initialValue: T;
}

export interface WizardPrompts {
  /** The trimmed answer, or `defaultValue` (or '') when left empty. */
  text(q: TextQuestion): Promise<string>;
  /** Like `text`, with the typed characters masked. */
  password(q: TextQuestion): Promise<string>;
  confirm(q: { readonly message: string; readonly initialValue: boolean }): Promise<boolean>;
  select<T extends string>(q: SelectQuestion<T>): Promise<T>;
}

function answered<T>(value: T | symbol): Exclude<T, symbol> {
  if (isCancel(value)) throw new WizardCancelled();
  return value as Exclude<T, symbol>;
}

export function createWizardPrompts(): WizardPrompts {
  return {
    async text(q) {
      const value = answered(
        await text({
          message: q.message,
          placeholder: q.placeholder,
          validate: q.validate ? (v) => q.validate?.((v ?? '').trim()) : undefined,
        }),
      );
      return value.trim() || (q.defaultValue ?? '');
    },
    async password(q) {
      const value = answered(
        await password({
          message: q.message,
          validate: q.validate ? (v) => q.validate?.((v ?? '').trim()) : undefined,
        }),
      );
      return value.trim() || (q.defaultValue ?? '');
    },
    async confirm(q) {
      return answered(await confirm({ message: q.message, initialValue: q.initialValue }));
    },
    async select(q) {
      const value = await select<string>({
        message: q.message,
        options: q.options.map((o) => ({ ...o })),
        initialValue: q.initialValue,
      });
      return answered(value) as typeof q.initialValue;
    },
  };
}

/**
 * Writes a line on Clack's guide rail, so plain output lines up with the
 * questions. Leading newlines are dropped: each question already ends with a
 * spacer line.
 */
export function printOnRail(msg = ''): void {
  const bar = styleText('gray', S_BAR);
  for (const line of msg.replace(/^\n+/, '').split('\n')) {
    process.stdout.write(line ? `${bar}  ${line}\n` : `${bar}\n`);
  }
}
