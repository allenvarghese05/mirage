import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one bad payload from blanking the whole app (e.g. during a recording). Reset by changing `resetKey`. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[mirage] page crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="console" style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
        <div className="c-panel" style={{ padding: 24, maxWidth: 520 }}>
          <span className="c-kicker">Something went wrong on this page</span>
          <p style={{ margin: '8px 0 16px', color: 'var(--c-dim)' }}>{this.state.error.message}</p>
          <button type="button" className="c-btn" onClick={() => this.setState({ error: null })}>Try again</button>{' '}
          <a className="c-btn c-btn--ghost" href="/">Home</a>
        </div>
      </div>
    );
  }
}
