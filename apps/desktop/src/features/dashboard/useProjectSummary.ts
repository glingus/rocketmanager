import { useQueries } from '@tanstack/react-query';
import { data } from '../../lib/data';
import { qk } from '../../app/queryClient';
import { countOpenProblems } from '../../lib/utils/cards';

/** Everything a dashboard project card shows besides the sync status. */
export function useProjectSummary(projectId: string) {
  const [versions, activity, cards, categories] = useQueries({
    queries: [
      { queryKey: [...qk.versions(projectId), 'index', 1], queryFn: () => data.listIndexedVersions(projectId, 1) },
      { queryKey: qk.activity(projectId, { limit: 1 }), queryFn: () => data.listActivity(projectId, { limit: 1 }) },
      { queryKey: qk.cards(projectId), queryFn: () => data.listCards(projectId) },
      { queryKey: qk.categories(projectId), queryFn: () => data.listCategories(projectId) },
    ],
  });
  const lastVersion = versions.data?.[0] ?? null;
  const lastActivity = activity.data?.[0] ?? null;
  const problemCards = cards.data && categories.data ? countOpenProblems(cards.data, categories.data) : 0;
  return { lastVersion, lastActivity, problemCards, isLoading: versions.isLoading || cards.isLoading };
}
