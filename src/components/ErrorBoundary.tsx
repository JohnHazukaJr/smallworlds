import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logAppError } from '../errors';

interface Props {
  /** Changing this clears the error, e.g. when the screen changes. */
  resetKey: string;
  onHome: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** A screen that crashes shows a way out instead of a blank page. Nothing is deleted. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logAppError(error, `render ${info.componentStack?.split('\n')[1]?.trim() ?? ''}`);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ padding: '48px 24px', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="serif" style={{ fontSize: 26, fontWeight: 300, color: 'var(--ink-heading)' }}>Something went wrong on this screen.</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-muted)' }}>
          Your worlds are safe — nothing was deleted. Go back to your worlds, or reload the app.
        </div>
        <pre style={{
          fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
          padding: 10, borderRadius: 8, border: '1px solid var(--rule)', color: 'var(--ink-muted)'
        }}>{error.message}</pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={() => { this.setState({ error: null }); this.props.onHome(); }}>Back to worlds</button>
          <button className="btn-ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
