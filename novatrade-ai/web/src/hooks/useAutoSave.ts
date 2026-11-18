import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface UseAutoSaveOptions<T> {
  /** Initial / server-confirmed baseline value */
  baseline: T | null;
  /** Serialize for reliable equality & duplicate-write prevention */
  serialize?: (value: T) => string;
  /** Return error message string if incomplete/invalid (blocks save), or null if valid */
  validate?: (value: T) => string | null;
  /** Persist function — must throw on failure so error & retry state triggers */
  onSave: (value: T) => Promise<void>;
  /** Short debounce window for interactive changes (ms) */
  debounceMs?: number;
}

export interface UseAutoSaveReturn<T> {
  status: AutoSaveStatus;
  validationError: string | null;
  lastError: string | null;
  /** Schedule debounced save for continuous/toggle changes */
  scheduleSave: (nextValue: T, immediate?: boolean) => void;
  /** Flush pending text/number edits immediately when user leaves a field */
  flushOnBlur: (currentValue: T) => void;
  /** Retry saving latest edited value after a failure */
  retry: () => void;
  /** Update baseline when external data loads (skipped automatically if dirty/saving); returns true if caller should sync UI draft */
  syncBaseline: (nextBaseline: T | null, force?: boolean) => boolean;
}

/**
 * Race-safe, serialized automatic settings persistence hook.
 * - Prevents duplicate writes when value matches last saved snapshot
 * - Blocks incomplete/invalid inputs from being sent to backend or Supabase
 * - Uses monotonic sequence tokens + sequential queue so older requests never overwrite newer edits
 */
export function useAutoSave<T>({
  baseline,
  serialize = (val) => JSON.stringify(val),
  validate,
  onSave,
  debounceMs = 550,
}: UseAutoSaveOptions<T>): UseAutoSaveReturn<T> {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const baselineJsonRef = useRef<string>(baseline != null ? serialize(baseline) : '');
  const latestValueRef = useRef<T | null>(baseline);
  const latestRevisionRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const commitValue = useCallback((value: T, targetRev: number) => {
    const serialized = serializeRef.current(value);
    if (serialized === baselineJsonRef.current) {
      if (mountedRef.current && targetRev === latestRevisionRef.current) {
        setStatus((prev) => (prev === 'saving' ? 'saved' : prev));
        setLastError(null);
      }
      return;
    }

    const invalidReason = validateRef.current ? validateRef.current(value) : null;
    if (invalidReason) {
      if (mountedRef.current && targetRev === latestRevisionRef.current) {
        setValidationError(invalidReason);
        setStatus('idle');
      }
      return;
    }

    if (mountedRef.current) {
      setValidationError(null);
      setLastError(null);
      setStatus('saving');
    }

    // Serialize all writes sequentially so earlier in-flight requests can never land after newer edits
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        // If user edited again while this request waited in queue, skip stale intermediate payload
        if (targetRev < latestRevisionRef.current && latestValueRef.current !== null) {
          return;
        }
        try {
          await onSaveRef.current(value);
          baselineJsonRef.current = serialized;
          if (mountedRef.current && targetRev === latestRevisionRef.current) {
            setStatus('saved');
            setLastError(null);
          }
        } catch (err) {
          if (mountedRef.current && targetRev === latestRevisionRef.current) {
            setStatus('error');
            setLastError(err instanceof Error ? err.message : 'Unable to save changes.');
          }
        }
      });
  }, []);

  const scheduleSave = useCallback(
    (nextValue: T, immediate = false) => {
      latestValueRef.current = nextValue;
      latestRevisionRef.current += 1;
      const rev = latestRevisionRef.current;

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const invalidReason = validateRef.current ? validateRef.current(nextValue) : null;
      if (invalidReason) {
        setValidationError(invalidReason);
        setLastError(null);
        setStatus('idle');
        return;
      }
      setValidationError(null);

      const serialized = serializeRef.current(nextValue);
      if (serialized === baselineJsonRef.current) {
        setLastError(null);
        if (status === 'error' || status === 'saving') {
          setStatus('saved');
        }
        return;
      }

      setStatus('saving');
      setLastError(null);

      if (immediate) {
        commitValue(nextValue, rev);
      } else {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (latestValueRef.current !== null && rev === latestRevisionRef.current) {
            commitValue(latestValueRef.current, rev);
          }
        }, debounceMs);
      }
    },
    [commitValue, debounceMs, status]
  );

  const flushOnBlur = useCallback(
    (currentValue: T) => {
      latestValueRef.current = currentValue;
      const serialized = serializeRef.current(currentValue);
      if (serialized === baselineJsonRef.current) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        const invalidReason = validateRef.current ? validateRef.current(currentValue) : null;
        setValidationError(invalidReason);
        return;
      }

      const invalidReason = validateRef.current ? validateRef.current(currentValue) : null;
      if (invalidReason) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        setValidationError(invalidReason);
        setStatus('idle');
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      latestRevisionRef.current += 1;
      const rev = latestRevisionRef.current;
      commitValue(currentValue, rev);
    },
    [commitValue]
  );

  const retry = useCallback(() => {
    if (latestValueRef.current === null) return;
    latestRevisionRef.current += 1;
    const rev = latestRevisionRef.current;
    commitValue(latestValueRef.current, rev);
  }, [commitValue]);

  const syncBaseline = useCallback(
    (nextBaseline: T | null, force = false): boolean => {
      if (nextBaseline === null) return false;
      const nextJson = serializeRef.current(nextBaseline);
      if (nextJson === baselineJsonRef.current) return false;
      if (!force && (timerRef.current !== null || status === 'saving' || status === 'error')) {
        return false;
      }
      if (!force && latestValueRef.current !== null) {
        const currentJson = serializeRef.current(latestValueRef.current);
        if (currentJson !== baselineJsonRef.current) {
          return false;
        }
      }
      baselineJsonRef.current = nextJson;
      latestValueRef.current = nextBaseline;
      return true;
    },
    [status]
  );

  return {
    status,
    validationError,
    lastError,
    scheduleSave,
    flushOnBlur,
    retry,
    syncBaseline,
  };
}
