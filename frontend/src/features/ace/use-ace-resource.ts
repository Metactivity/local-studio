"use client";

import { useCallback, useState, type DependencyList } from "react";
import { useMountSubscription } from "@/hooks/use-mount-subscription";

export type AceResource<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/** One fetched value per dependency set; `load` null means "nothing to show yet". */
export function useAceResource<T>(
  load: (() => Promise<T>) | null,
  deps: DependencyList,
): AceResource<T> {
  const [state, setState] = useState<{
    data: T | null;
    error: string | null;
    loading: boolean;
    nonce: number;
  }>({
    data: null,
    error: null,
    loading: load !== null,
    nonce: 0,
  });
  const reload = useCallback(
    () => setState((current) => ({ ...current, nonce: current.nonce + 1 })),
    [],
  );

  useMountSubscription(() => {
    if (!load) {
      setState((current) =>
        current.data === null && !current.error && !current.loading
          ? current
          : { ...current, data: null, error: null, loading: false },
      );
      return;
    }
    let cancelled = false;
    setState((current) => (current.loading ? current : { ...current, loading: true }));
    load().then(
      (data) => {
        if (!cancelled) setState((current) => ({ ...current, data, error: null, loading: false }));
      },
      (error: unknown) => {
        if (!cancelled)
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
            loading: false,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, state.nonce]);

  return { data: state.data, error: state.error, loading: state.loading, reload };
}
