import { StrictMode, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';
import { FatalScreen } from './FatalScreen';

export type StartOptions = {
  /** Loads the application. Importing it creates the backend and the data layer (top-level await), which may throw. */
  loadApp: () => Promise<{ App: ComponentType }>;
  onRetry?: () => void;
  exportDiagnostics?: () => Promise<string>;
  canExport?: boolean;
};

/** Mounts the app, or - whatever goes wrong while starting - the error screen. Never leaves the window empty. */
export async function startApp(container: HTMLElement, opts: StartOptions): Promise<Root> {
  const root = createRoot(container);
  try {
    const { App } = await opts.loadApp();
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (error) {
    console.error('Avvio non riuscito', error);
    root.render(
      <FatalScreen error={error} phase="startup" onRetry={opts.onRetry} exportDiagnostics={opts.exportDiagnostics} canExport={opts.canExport} />,
    );
  }
  return root;
}
