import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { data } from '../../lib/data';
import type { Card, CardCategory, CardInput, Member } from '../../lib/types/data';
import { qk } from '../../app/queryClient';
import { toast } from '../../ui';
import { errorMessage } from '../../app/errors';
import { emitCardCreated, emitCardUpdated } from './cardEvents';
import { useProfiles } from '../../app/hooks';
import { useSession } from '../../app/session';
import { it } from '../../i18n/it';

export function useNotesData(projectId: string) {
  const qc = useQueryClient();
  const { profiles } = useProfiles();
  const myLogin = useSession((s) => s.auth?.user?.githubLogin);
  const myId = profiles.find((p) => p.githubLogin === myLogin)?.id ?? null;

  const cards = useQuery({ queryKey: qk.cards(projectId), queryFn: () => data.listCards(projectId) });
  const categories = useQuery({ queryKey: qk.categories(projectId), queryFn: () => data.listCategories(projectId) });
  const members = useQuery({ queryKey: qk.members(projectId), queryFn: () => data.listMembers(projectId) });

  const cats = useMemo<CardCategory[]>(() => categories.data ?? [], [categories.data]);

  const onError = (e: unknown) => toast.error(it.notes.errorCreate, { message: errorMessage(e) });

  const create = useMutation({
    mutationFn: async (input: CardInput & { title: string }) => {
      const card = await data.createCard(projectId, input);
      void emitCardCreated(projectId, card, cats, myId);
      return card;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.cards(projectId) });
      void qc.invalidateQueries({ queryKey: ['activity', projectId] });
    },
    onError,
  });

  const update = useMutation({
    mutationFn: async ({ card, patch }: { card: Card; patch: CardInput }) => {
      const next = await data.updateCard(card.id, patch);
      void emitCardUpdated(projectId, card, next, cats, myId);
      return next;
    },
    onMutate: async ({ card, patch }) => {
      await qc.cancelQueries({ queryKey: qk.cards(projectId) });
      const previous = qc.getQueryData<Card[]>(qk.cards(projectId));
      qc.setQueryData<Card[]>(qk.cards(projectId), (list) => list?.map((c) => (c.id === card.id ? { ...c, ...patch } as Card : c)));
      return { previous };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.cards(projectId), ctx.previous);
      toast.error(it.notes.errorCreate, { message: errorMessage(e) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.cards(projectId) });
      void qc.invalidateQueries({ queryKey: ['activity', projectId] });
    },
  });

  const remove = useMutation({
    mutationFn: (card: Card) => data.deleteCard(card.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.cards(projectId) }),
    onError: (e) => toast.error(it.notes.detail.delete, { message: errorMessage(e) }),
  });

  const memberList: Member[] = members.data ?? [];

  return { cards, categories, members, cats, memberList, create, update, remove, myId };
}
