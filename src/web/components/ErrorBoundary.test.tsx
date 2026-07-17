import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, type MockInstance } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

// Throws until the test explicitly flips it off — lets a test drive the
// boundary into its error state and then observe recovery without needing
// resetKey to change. The throw condition is controlled externally (not by a
// side effect inside render) so it's unaffected by React re-invoking a
// failing render to build a component stack in dev mode.
function makeFlaky(): { Flaky: () => JSX.Element; setShouldThrow: (v: boolean) => void } {
  let shouldThrow = true;
  function Flaky(): JSX.Element {
    if (shouldThrow) throw new Error('flaky');
    return <div>recovered</div>;
  }
  return {
    Flaky,
    setShouldThrow: (v: boolean) => {
      shouldThrow = v;
    },
  };
}

describe('ErrorBoundary', () => {
  let consoleSpy: MockInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders the fallback UI with the error message when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  it('resets when resetKey changes (e.g. route change)', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom message="route-a-error" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('route-a-error')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/b">
        <div>route-b-content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('route-b-content')).toBeInTheDocument();
    expect(screen.queryByText('route-a-error')).not.toBeInTheDocument();
  });

  it('logs the caught error via componentDidCatch with our specific message', () => {
    // React itself calls console.error on uncaught render errors in dev mode,
    // so a bare `toHaveBeenCalled()` would pass vacuously. Assert on the
    // exact message string we emit from componentDidCatch.
    render(
      <ErrorBoundary>
        <Boom message="logged-error" />
      </ErrorBoundary>,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'ErrorBoundary caught a render error',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('clears the error and re-renders children when the Dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const { Flaky, setShouldThrow } = makeFlaky();

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    setShouldThrow(false);
    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});
