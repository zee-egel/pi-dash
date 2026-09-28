let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({ error: 'Backend unavailable' })) as T & { error?: string };
  if (!response.ok) { if (response.status === 401 && path !== '/login') window.dispatchEvent(new Event('session-expired')); throw new Error(data.error ?? 'Request failed'); }
  return data;
}
export const bytes = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const index = Math.min(Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)), 4);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
};
export const duration = (seconds: number) => `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
export const relative = (date: string | null) => { if (!date) return 'Never'; const seconds = Math.max(0, (Date.now() - Date.parse(date)) / 1000); return seconds < 60 ? 'Just now' : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`; };
