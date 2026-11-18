import { getActiveSession } from './supabase';

const API_BASE = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');

export function isHtmlPayload(text: string, contentType = ''): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  return /^(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]|<meta[\s>]|<script[\s>]|<style[\s>]|<div[\s>])/i.test(
    trimmed
  );
}

export function sanitizeErrorMessage(raw: unknown, fallback = 'Request failed. Please try again.'): string {
  const str = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
  const trimmed = str.trim();
  if (!trimmed) return fallback;

  if (isHtmlPayload(trimmed) || /<\/(?:html|body|head|div|p|h1|script|title)>/i.test(trimmed)) {
    return fallback;
  }

  // Strip stack trace lines if a server/runtime error slipped through
  const withoutStack = trimmed
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+\S+/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!withoutStack) return fallback;

  if (withoutStack.length > 180) {
    return `${withoutStack.slice(0, 177).trimEnd()}...`;
  }
  return withoutStack;
}

function formatHtmlHttpError(status: number, ok: boolean): string {
  if (ok) {
    return 'API returned HTML instead of JSON. Please verify the backend service is running.';
  }
  if (status === 404) {
    return 'API endpoint unavailable (HTTP 404).';
  }
  if (status === 502 || status === 503 || status === 504) {
    return `Broker gateway or backend service is unavailable (HTTP ${status}).`;
  }
  return `Server returned an unexpected error (HTTP ${status}).`;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await getActiveSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });

  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();

  if (isHtmlPayload(text, contentType)) {
    throw new Error(formatHtmlHttpError(res.status, res.ok));
  }

  let json: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        json = parsed as Record<string, unknown>;
      } else {
        throw new Error('Unexpected JSON response format.');
      }
    } catch {
      if (!res.ok) {
        throw new Error(sanitizeErrorMessage(text, `Request failed (HTTP ${res.status}).`));
      }
      throw new Error('Server returned a non-JSON API response.');
    }
  }

  if (!res.ok) {
    const rawMsg = json.error ?? json.reason ?? json.message ?? json.detail;
    throw new Error(sanitizeErrorMessage(rawMsg, `Request failed (HTTP ${res.status}).`));
  }

  return json as T;
}
