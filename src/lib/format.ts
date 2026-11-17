const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const datetime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
export function formatCompact(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'N/A' : compact.format(value); }
export function formatNumber(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'N/A' : number.format(value); }
export function formatPercent(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(2)}%`; }
export function formatScore(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(1)}x`; }
export function formatDate(value: string | null | undefined): string { return !value || !Number.isFinite(Date.parse(value)) ? 'Not fetched' : date.format(new Date(value)); }
export function formatDateTime(value: string | null | undefined): string { return !value || !Number.isFinite(Date.parse(value)) ? 'Not fetched' : `${datetime.format(new Date(value))} IST`; }
export function formatDuration(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const seconds = Math.round(value);
  if (!Number.isSafeInteger(seconds)) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function formatUsd(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? 'N/A' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value); }
