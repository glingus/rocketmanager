import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from '../ui';
import { errorMessage } from './errors';

type Options<TArgs, TRes> = {
  invalidate?: QueryKey[] | ((res: TRes, args: TArgs) => QueryKey[]);
  successToast?: string | ((res: TRes, args: TArgs) => string | null);
  errorTitle?: string;
  onSuccess?: (res: TRes, args: TArgs) => void;
  /** When true the caller handles errors itself. */
  silent?: boolean;
};

/** useMutation that shows Italian error toasts (from `AppError.message`) and invalidates queries. */
export function useApiMutation<TArgs, TRes>(fn: (args: TArgs) => Promise<TRes>, opts: Options<TArgs, TRes> = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, unknown, TArgs>({
    mutationFn: fn,
    onSuccess: (res, args) => {
      const keys = typeof opts.invalidate === 'function' ? opts.invalidate(res, args) : opts.invalidate;
      keys?.forEach((k) => void qc.invalidateQueries({ queryKey: k }));
      const msg = typeof opts.successToast === 'function' ? opts.successToast(res, args) : opts.successToast;
      if (msg) toast.success(msg);
      opts.onSuccess?.(res, args);
    },
    onError: (e) => {
      if (opts.silent) return;
      toast.error(opts.errorTitle ?? 'Operazione non riuscita', { message: errorMessage(e) });
    },
  });
}
