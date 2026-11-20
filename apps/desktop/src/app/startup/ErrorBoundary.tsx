import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FatalScreen } from './FatalScreen';

/** Global boundary: a rendering error shows the error screen instead of an empty window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; failed: boolean }> {
  override state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Errore di rendering', error, info.componentStack);
  }

  override render() {
    if (this.state.failed) return <FatalScreen error={this.state.error} phase="render" />;
    return this.props.children;
  }
}
