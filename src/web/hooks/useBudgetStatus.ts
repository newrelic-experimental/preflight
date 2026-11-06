import { useQuery } from '@tanstack/react-query';

import { fetchBudget, qk, type BudgetStatus } from '../api/client';

export function useBudgetStatus() {
  return useQuery<BudgetStatus>({
    queryKey: qk.budget,
    queryFn: ({ signal }) => fetchBudget(signal),
    refetchInterval: 10_000,
  });
}
