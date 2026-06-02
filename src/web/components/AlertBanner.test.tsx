import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AlertBanner } from './AlertBanner';
import type { AlertEvent } from '../store/liveStore';

function makeAlert(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    id: 'rule-1',
    state: 'firing',
    severity: 'warning',
    title: 'Session cost spike',
    description: 'Spent 12.34 in the last hour',
    value: 12.34,
    threshold: 10,
    firedAt: 1_000_000,
    ...overrides,
  };
}

describe('AlertBanner', () => {
  it('renders title, description, value, and threshold', () => {
    render(<AlertBanner alert={makeAlert()} onDismiss={() => {}} />);
    expect(screen.getByText('Session cost spike')).toBeInTheDocument();
    expect(screen.getByText(/Spent 12\.34/)).toBeInTheDocument();
    expect(screen.getByText(/12\.34 \/ 10/)).toBeInTheDocument();
  });

  it('shows the severity label', () => {
    render(<AlertBanner alert={makeAlert({ severity: 'critical' })} onDismiss={() => {}} />);
    expect(screen.getByText(/CRIT/)).toBeInTheDocument();
  });

  it('uses role="alert" for critical severity (assertive)', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ severity: 'critical' })} onDismiss={() => {}} />,
    );
    const root = container.firstElementChild!;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.getAttribute('aria-live')).toBe('assertive');
  });

  it('uses role="status" for warning severity (polite)', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ severity: 'warning' })} onDismiss={() => {}} />,
    );
    const root = container.firstElementChild!;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-live')).toBe('polite');
  });

  it('uses role="status" for info severity', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ severity: 'info' })} onDismiss={() => {}} />,
    );
    expect(container.firstElementChild!.getAttribute('role')).toBe('status');
  });

  it('applies the warning tone class for warning severity', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ severity: 'warning' })} onDismiss={() => {}} />,
    );
    expect(container.firstElementChild!.className).toContain('border-accent-amber');
    // Severity prefix uses the matching text tone.
    expect(screen.getByText(/WARN/).className).toContain('text-accent-amber');
  });

  it('applies the critical tone class for critical severity', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ severity: 'critical' })} onDismiss={() => {}} />,
    );
    expect(container.firstElementChild!.className).toContain('border-accent-red');
    expect(screen.getByText(/CRIT/).className).toContain('text-accent-red');
  });

  it('applies a neutral tone class for info severity', () => {
    render(<AlertBanner alert={makeAlert({ severity: 'info' })} onDismiss={() => {}} />);
    expect(screen.getByText(/INFO/).className).toContain('text-ink-muted');
  });

  it('exposes a dismiss button labeled "Dismiss alert"', () => {
    render(<AlertBanner alert={makeAlert()} onDismiss={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Dismiss alert' });
    expect(btn).toBeInTheDocument();
  });

  it('calls onDismiss with the alert id when the button is clicked', () => {
    const onDismiss = vi.fn();
    render(<AlertBanner alert={makeAlert({ id: 'r-42' })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss alert' }));
    expect(onDismiss).toHaveBeenCalledWith('r-42');
  });

  it('dismisses when ESC is pressed while the dismiss button is focused', () => {
    const onDismiss = vi.fn();
    render(<AlertBanner alert={makeAlert({ id: 'r-99' })} onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Dismiss alert' });
    btn.focus();
    // ESC fires on the button and bubbles to the outer banner div, where
    // the handler now lives so any descendant focus dismisses.
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('r-99');
  });

  it('dismisses when ESC is pressed anywhere within the banner', () => {
    const onDismiss = vi.fn();
    render(<AlertBanner alert={makeAlert({ id: 'r-7' })} onDismiss={onDismiss} />);
    // Pressing ESC on the title element (a non-button descendant) still
    // fires the dismiss because the keydown handler is on the outer div.
    const title = screen.getByText(makeAlert().title);
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('r-7');
  });

  it('ignores other keys', () => {
    const onDismiss = vi.fn();
    render(<AlertBanner alert={makeAlert()} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss alert' }), { key: 'Enter' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('marks the icon as decorative (aria-hidden) so screen readers skip it', () => {
    const { container } = render(<AlertBanner alert={makeAlert()} onDismiss={() => {}} />);
    const icon = container.querySelector('button svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes the alert id as a data attribute for tests/debugging', () => {
    const { container } = render(
      <AlertBanner alert={makeAlert({ id: 'rule-x' })} onDismiss={() => {}} />,
    );
    expect(container.firstElementChild!.getAttribute('data-alert-id')).toBe('rule-x');
    expect(container.firstElementChild!.getAttribute('data-severity')).toBe('warning');
  });
});
