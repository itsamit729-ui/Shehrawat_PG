/** Today's calendar date for business rules, which run on Indian time rather than UTC. */
export function businessToday(now = new Date(), timeZone = "Asia/Kolkata") {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export function addDays(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True only for a real YYYY-MM-DD date, which rejects values such as 2026-02-31. */
export function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
