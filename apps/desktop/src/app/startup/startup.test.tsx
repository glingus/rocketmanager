import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FatalScreen } from './FatalScreen';
import { ErrorBoundary } from './ErrorBoundary';
import { startApp } from './startApp';
import { ConfigMissingError } from '../../lib/data/config';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('start-up with missing configuration', () => {
  it('importing the data layer rejects with ConfigMissingError and startApp shows the error screen (no unhandled rejection)', async () => {
    vi.stubEnv('VITE_BACKEND', 'mock');
    vi.stubEnv('VITE_DATA', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // the real chain: App -> Bootstrap -> lib/data (top-level await that throws)
    const container = document.createElement('div');
    document.body.append(container);
    const root = await startApp(container, { loadApp: () => import('../App'), canExport: false, onRetry: () => undefined });
    await act(async () => {});

    const screenEl = await screen.findByTestId('fatal-screen');
    expect(screenEl.getAttribute('data-kind')).toBe('config');
    expect(screenEl.textContent).toContain('Rocket Sync non è configurato');
    expect(screenEl.textContent).toContain('SUPABASE_URL');
    expect(screenEl.textContent).toContain('ConfigMissingError');
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Esporta diagnostica' })).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
    act(() => root.unmount());
    container.remove();
  });

  it('a generic start-up failure also gets the screen, with copyable detail and Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onRetry = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = await startApp(container, { loadApp: () => Promise.reject(new Error('boom')), onRetry, canExport: false });
    await act(async () => {});
    const el = await screen.findByTestId('fatal-screen');
    expect(el.getAttribute('data-kind')).toBe('startup');
    expect(el.textContent).toContain('Error: boom');
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
});

describe('FatalScreen', () => {
  it('offers "Esporta diagnostica" only when the Tauri backend is available and shows the result', async () => {
    const exportDiagnostics = vi.fn(async () => 'C:\\Temp\\diagnostica.zip');
    const { rerender } = render(<FatalScreen error={new Error('x')} phase="startup" canExport={false} />);
    expect(screen.queryByRole('button', { name: 'Esporta diagnostica' })).toBeNull();
    rerender(<FatalScreen error={new Error('x')} phase="startup" canExport exportDiagnostics={exportDiagnostics} />);
    await userEvent.click(screen.getByRole('button', { name: 'Esporta diagnostica' }));
    expect(exportDiagnostics).toHaveBeenCalled();
    expect((await screen.findByRole('status')).textContent).toContain('diagnostica.zip');
  });

  it('copies the technical detail to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<FatalScreen error={new ConfigMissingError(['a', 'b'])} phase="startup" canExport={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copia dettaglio' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('ConfigMissingError'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Fonti controllate: a; b'));
  });

  it('reports a failed diagnostics export instead of failing silently', async () => {
    render(<FatalScreen error={new Error('x')} phase="startup" canExport exportDiagnostics={async () => { throw new Error('disco pieno'); }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Esporta diagnostica' }));
    expect((await screen.findByRole('status')).textContent).toContain('disco pieno');
  });
});

describe('ErrorBoundary', () => {
  it('shows the error screen for a rendering error instead of an empty window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error('render fallito');
    };
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const el = screen.getByTestId('fatal-screen');
    expect(el.getAttribute('data-kind')).toBe('render');
    expect(el.textContent).toContain('Qualcosa è andato storto');
    expect(el.textContent).toContain('render fallito');
  });

  it('renders its children when nothing fails', () => {
    render(<ErrorBoundary><p>tutto bene</p></ErrorBoundary>);
    expect(screen.getByText('tutto bene')).toBeTruthy();
  });
});
