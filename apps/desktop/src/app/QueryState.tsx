import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button, EmptyState, SkeletonLines, TriangleAlert } from '../ui';
import { errorMessage } from './errors';
import { it } from '../i18n/it';

/** Standard loading / error handling for a query. Renders children once data is there. */
export function QueryState<T>({ query, children, lines = 4 }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; lines?: number }) {
  if (query.isLoading) return <SkeletonLines lines={lines} />;
  if (query.isError || query.data === undefined) {
    return (
      <EmptyState
        compact
        icon={<TriangleAlert />}
        title={it.errors.loadFailed}
        description={query.error ? errorMessage(query.error) : undefined}
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            {it.common.retry}
          </Button>
        }
      />
    );
  }
  return <>{children(query.data)}</>;
}
