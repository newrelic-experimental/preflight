import { useState, useCallback } from 'react';
import type { JSX } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { Sidebar } from './components/Sidebar';
import { AlertBannerStack } from './components/AlertBannerStack';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShortcutOverlay } from './components/ShortcutOverlay';
import { useLiveEvents } from './hooks/useLiveEvents';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import { useLiveStore } from './store/liveStore';
import { Today } from './views/Today';
import { Sessions } from './views/Sessions';
import { History } from './views/History';
import { Audit } from './views/Audit';
import { GitEfficiency } from './views/GitEfficiency';
import { Settings } from './views/Settings';
import { Alerts } from './views/Alerts';

export function App(): JSX.Element {
  useLiveEvents();
  const connected = useLiveStore((s) => s.connected);
  const [location, navigate] = useLocation();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();

  const toggleHelp = useCallback(() => setShortcutHelpOpen((v) => !v), []);
  const closeHelp = useCallback(() => setShortcutHelpOpen(false), []);

  useKeyboardShortcuts({ navigate, onToggleHelp: toggleHelp, onToggleTheme: toggleTheme });

  return (
    <>
      <div className="flex flex-col h-full mesh-bg">
        <AlertBannerStack />
        <div className="flex flex-1 min-h-0">
          <Sidebar
            currentPath={location}
            onNavigate={navigate}
            connected={connected}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
          <main className="flex-1 overflow-auto p-6">
            <ErrorBoundary resetKey={location}>
              <Switch>
                <Route path="/sessions" component={Sessions} />
                <Route path="/history" component={History} />
                <Route path="/audit" component={Audit} />
                <Route path="/git" component={GitEfficiency} />
                <Route path="/settings" component={Settings} />
                <Route path="/alerts" component={Alerts} />
                <Route path="/" component={Today} />
                <Route>
                  <div className="text-ink-muted">Not found</div>
                </Route>
              </Switch>
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <ShortcutOverlay open={shortcutHelpOpen} onClose={closeHelp} />
    </>
  );
}
