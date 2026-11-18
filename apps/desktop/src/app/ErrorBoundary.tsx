import { Component, type ErrorInfo, type ReactNode } from 'react';
import { it } from '../i18n/it';
import { EmptyState, Button, TriangleAlert } from '../ui';

type Props = { children: ReactNode; resetKey?: string };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title={it.errors.boundaryTitle}
        description={it.errors.boundaryText}
        action={
          <Button
            variant="primary"
            onClick={() => {
              this.setState({ error: null });
              window.location.hash = '#/';
            }}
          >
            {it.errors.boundaryAction}
          </Button>
        }
      />
    );
  }
}
