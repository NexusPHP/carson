import fs from 'node:fs';

interface Day {
  count: number;
  uniques: number;
}

interface TrafficWindow {
  clones: (Day & { timestamp: string })[];
}

interface Store {
  total?: number;
  since?: string;
  days?: Record<string, Day>;
}

const [windowPath, storePath, badgePath] = process.argv.slice(2) as [string, string, string];
const window_ = JSON.parse(fs.readFileSync(windowPath, 'utf8')) as TrafficWindow;
const store = (fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : {}) as Store;

const days: Record<string, Day> = { ...store.days };

for (const { timestamp, count, uniques } of window_.clones) {
  days[timestamp.slice(0, 10)] = { count, uniques };
}

const dates = Object.keys(days).sort();
const oldestRevisable = window_.clones.map((day) => day.timestamp.slice(0, 10)).sort()[0];
const since = [store.since, dates[0]].filter((d): d is string => d !== undefined).sort()[0] ?? null;
let total = store.total ?? 0;
const kept: Record<string, Day> = {};

for (const date of dates) {
  const day = days[date] as Day;

  if (oldestRevisable !== undefined && date < oldestRevisable) {
    total += day.count;
  } else {
    kept[date] = day;
  }
}

const grand = total + Object.values(kept).reduce((sum, { count }) => sum + count, 0);
const message = grand >= 1_000_000
  ? `${(grand / 1_000_000).toFixed(2)}M`
  : grand >= 1_000
    ? `${(grand / 1_000).toFixed(2)}k`
    : String(grand);

fs.writeFileSync(storePath, `${JSON.stringify({ total, since, days: kept }, null, 2)}\n`);
fs.writeFileSync(badgePath, `${JSON.stringify({
  schemaVersion: 1,
  label: 'action runs',
  message,
  color: 'blue',
}, null, 2)}\n`);
