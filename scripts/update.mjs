import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "FairStash";
const SOURCE_URL = "https://fairstash.app/data/supply.csv";
const MIN_ITEMS = 50;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const currentPath = join(root, "current.json");
const summaryPath = join(root, "summary.json");
const activityHistoryPath = join(root, "activity-history.json");
const historyDir = join(root, "history");
const MAX_HISTORY_DAYS = 90;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  row.push(cell);
  if (row.some((value) => value.length)) rows.push(row);
  return rows;
}

function countOrNull(value, field, line) {
  if (String(value ?? "").trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || !Number.isInteger(number)) throw new Error(`Invalid ${field} count on CSV line ${line}`);
  return number;
}

function stableSlug(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function datasetHash(snapshot) {
  return createHash("sha256").update(JSON.stringify({ sourceLatestDay: snapshot.sourceLatestDay, items: snapshot.items })).digest("hex");
}

async function readCurrent() {
  try {
    const parsed = JSON.parse(await readFile(currentPath, "utf8"));
    return parsed && Array.isArray(parsed.items) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Existing current.json is invalid: ${error.message}`);
  }
}

async function readActivityHistory() {
  try {
    const parsed = JSON.parse(await readFile(activityHistoryPath, "utf8"));
    return parsed && Array.isArray(parsed.snapshots) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Existing activity-history.json is invalid: ${error.message}`);
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function main() {
  const response = await fetch(SOURCE_URL, { headers: { Accept: "text/csv", "User-Agent": "PetlioMarketData/1.0 (+https://github.com/petlioam/petlio-market-data)" } });
  if (!response.ok) throw new Error(`FairStash request failed: HTTP ${response.status}`);
  const csv = await response.text();
  if (!csv.trim()) throw new Error("FairStash returned an empty CSV");

  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex((row) => row[0]?.trim().toLowerCase() === "game");
  if (headerIndex < 0) throw new Error("CSV header was not found");
  const headers = rows[headerIndex].map((value) => value.trim().toLowerCase());
  const required = ["game", "item", "slug", "day", "selling", "buying"];
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
  const column = Object.fromEntries(headers.map((name, index) => [name, index]));
  const adoptMe = rows.slice(headerIndex + 1).map((values, offset) => ({ values, line: headerIndex + offset + 2 })).filter(({ values }) => values[column.game]?.trim().toLowerCase() === "adopt-me");
  if (!adoptMe.length) throw new Error("CSV contains no Adopt Me records");

  const days = adoptMe.map(({ values }) => values[column.day]?.trim()).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)));
  if (!days.length) throw new Error("Adopt Me records contain no valid day");
  const latestDay = days.sort().at(-1);
  const latest = adoptMe.filter(({ values }) => values[column.day]?.trim() === latestDay);
  const bySlug = new Map();

  for (const { values, line } of latest) {
    const name = values[column.item]?.trim();
    const slug = stableSlug(values[column.slug]?.trim() || name);
    if (!name) throw new Error(`Missing item name on CSV line ${line}`);
    if (!slug) throw new Error(`Missing item slug on CSV line ${line}`);
    const selling = countOrNull(values[column.selling], "selling", line);
    const buying = countOrNull(values[column.buying], "buying", line);
    if (selling === null) throw new Error(`Missing selling count on CSV line ${line}`);
    const existing = bySlug.get(slug);
    if (existing && existing.name !== name) throw new Error(`Conflicting names share slug ${slug}`);
    if (existing) {
      existing.selling += selling;
      existing.buying = existing.buying === null || buying === null ? null : existing.buying + buying;
      existing.activity = existing.buying === null ? existing.selling : existing.selling + existing.buying;
    } else {
      bySlug.set(slug, { id: slug, name, slug, day: latestDay, selling, buying, activity: selling + (buying ?? 0) });
    }
  }

  const items = [...bySlug.values()].sort((a, b) => b.activity - a.activity || b.selling - a.selling || a.name.localeCompare(b.name));
  if (items.length < MIN_ITEMS) throw new Error(`Refusing suspiciously small dataset: ${items.length} items (minimum ${MIN_ITEMS})`);
  const updatedAt = new Date().toISOString();
  const next = { schemaVersion: 1, updatedAt, source: SOURCE, sourceUrl: SOURCE_URL, sourceLatestDay: latestDay, itemCount: items.length, items };
  const previous = await readCurrent();
  const changed = !previous || datasetHash(previous) !== datasetHash(next);
  await mkdir(historyDir, { recursive: true });

  if (changed && previous?.itemCount > 0) {
    const stamp = updatedAt.replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
    await atomicJson(join(historyDir, `${stamp}.json`), previous);
  }
  if (changed || !previous?.updatedAt) await atomicJson(currentPath, next);
  const current = changed || !previous?.updatedAt ? next : previous;
  const existingHistory = await readActivityHistory();
  const snapshotsByDay = new Map((existingHistory?.snapshots || []).map((snapshot) => [snapshot.day, snapshot]));
  snapshotsByDay.set(current.sourceLatestDay, { day: current.sourceLatestDay, updatedAt: current.updatedAt, items: current.items.map(({ id, selling, buying, activity }) => ({ id, selling, buying, activity })) });
  const snapshots = [...snapshotsByDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-MAX_HISTORY_DAYS);
  await atomicJson(activityHistoryPath, { schemaVersion: 1, updatedAt: current.updatedAt, source: current.source, sourceUrl: current.sourceUrl, retentionDays: MAX_HISTORY_DAYS, snapshots });
  await atomicJson(summaryPath, { schemaVersion: 1, updatedAt: current.updatedAt, source: current.source, sourceUrl: current.sourceUrl, sourceLatestDay: current.sourceLatestDay, itemCount: current.itemCount, mostActive: current.items.slice(0, 50) });
  console.log(changed ? `Updated ${items.length} Adopt Me items for ${latestDay}.` : `No activity changes for ${latestDay}; kept current snapshot.`);
}

main().catch((error) => { console.error(`Petlio market update failed: ${error.message}`); process.exitCode = 1; });
