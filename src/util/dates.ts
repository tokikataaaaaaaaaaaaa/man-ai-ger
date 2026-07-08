/**
 * 日付ユーティリティ。すべて「マシンのローカル TZ」基準 (architecture.md §2)。
 * サーバーを持たないローカルファースト製品なので、ユーザーの体感時刻 = ローカル時刻。
 */

/** ローカル日付 YYYY-MM-DD。 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ローカル時刻 HH:MM。 */
export function localTime(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** ISO タイムスタンプ (ローカル TZ オフセット付き)。 */
export function isoNow(d: Date = new Date()): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${localDate(d)}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

/** "HH:MM" 形式か検証。 */
export function isHHMM(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** "HH:MM" を分に。比較用。 */
export function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 曜日の日本語表記。 */
export function jaWeekday(d: Date): string {
  return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] ?? "";
}
