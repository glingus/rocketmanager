import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { StatusLamp, SyncStateLamp } from './StatusLamp';
import { Switch, SegmentedControl, Chip } from './Controls';
import { ConfirmDialog } from './Dialog';
import { EmptyState } from './EmptyState';
import { ColorPicker } from './ColorPicker';
import { Field, Input } from './Field';

describe('Button', () => {
  it('fires onClick and is disabled while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Pubblica</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Pubblica' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button onClick={onClick} loading>Pubblica</Button>);
    expect(screen.getByRole('button', { name: 'Pubblica' })).toBeDisabled();
  });
});

describe('StatusLamp', () => {
  it('always writes the status next to the lamp', () => {
    render(<SyncStateLamp state="conflict" />);
    expect(screen.getByText('Conflitto')).toBeVisible();
  });
  it('keeps an accessible text when the label is hidden', () => {
    render(<StatusLamp tone="green" icon="check" label="Sincronizzato" showLabel={false} />);
    expect(screen.getByText('Sincronizzato')).toHaveClass('visually-hidden');
  });
  it('shows the offline count', () => {
    render(<SyncStateLamp state="offline" detail="(2 versioni in attesa)" />);
    expect(screen.getByText('Offline (2 versioni in attesa)')).toBeVisible();
  });
});

describe('controls', () => {
  it('toggles a switch with the keyboard', async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Avvia con Windows" description="Resta nella barra" />);
    const sw = screen.getByRole('switch', { name: 'Avvia con Windows' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    sw.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('selects a segment', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Vista" value="board" onChange={onChange} options={[{ value: 'board', label: 'Bacheca' }, { value: 'columns', label: 'Per stato' }]} />);
    expect(screen.getByRole('radio', { name: 'Bacheca' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Per stato' }));
    expect(onChange).toHaveBeenCalledWith('columns');
  });

  it('chips report their pressed state', async () => {
    const onClick = vi.fn();
    render(<Chip active onClick={onClick} count={3}>Alta</Chip>);
    const chip = screen.getByRole('button', { name: /Alta/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });

  it('picks a card colour from the palette', async () => {
    const onChange = vi.fn();
    render(<ColorPicker value="crema" onChange={onChange} />);
    expect(screen.getAllByRole('radio')).toHaveLength(10);
    expect(screen.getByRole('radio', { name: 'Crema' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Ruggine' }));
    expect(onChange).toHaveBeenCalledWith('ruggine');
  });

  it('wires labels, hints and errors', () => {
    render(<Field label="Titolo" hint="Suggerimento" error="Obbligatorio">{(p) => <Input {...p} />}</Field>);
    const input = screen.getByLabelText('Titolo');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Obbligatorio');
  });
});

describe('ConfirmDialog', () => {
  it('confirms, cancels with Escape and traps focus inside', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<ConfirmDialog open onClose={onClose} onConfirm={onConfirm} title="Ripristinare la versione 5?" description="Crea una nuova versione." confirmLabel="Ripristina" />);
    const dialog = screen.getByRole('dialog', { name: 'Ripristinare la versione 5?' });
    expect(dialog).toHaveAccessibleDescription('Crea una nuova versione.');
    await userEvent.click(screen.getByRole('button', { name: 'Ripristina' }));
    expect(onConfirm).toHaveBeenCalled();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when closed', () => {
    render(<ConfirmDialog open={false} onClose={() => undefined} onConfirm={() => undefined} title="x" confirmLabel="ok" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('EmptyState', () => {
  it('shows title, description and action', () => {
    render(<EmptyState title="Nessuna card" description="Scrivi un titolo" action={<button>Crea</button>} />);
    expect(screen.getByRole('heading', { name: 'Nessuna card' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crea' })).toBeVisible();
  });
});
