import { Button, EmptyState, TriangleAlert } from '../../ui';
import { errorMessage } from '../../app/errors';
import { it } from '../../i18n/it';

export function QueryErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <EmptyState
      compact
      icon={<TriangleAlert />}
      title={it.errors.loadFailed}
      description={errorMessage(error)}
      action={onRetry ? <Button size="sm" onClick={onRetry}>{it.common.retry}</Button> : undefined}
    />
  );
}
