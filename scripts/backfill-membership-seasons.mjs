#!/usr/bin/env node
/**
 * Backfill `season` onto the Phase 2 `producer_memberships` (Phase 4 contract
 * section 2.6, decision D33: a membership belongs to exactly one season).
 *
 *   node scripts/backfill-membership-seasons.mjs --market wlrfm --season 2026 [--dry-run | --write] [--db-project <id>]
 *
 * Sets `season` on every membership of the market that has no season field
 * and changes nothing else (not even `updated_at`). Dry run is the default and
 * prints the same report `--write` would produce. Readers already treat a
 * missing field as the legacy season (src/services/seasons.ts), so this can run
 * before or after the deploy; it only makes the data say what the code assumes.
 *
 * `firebase-admin` is imported lazily, like import-survey.mjs, so the module
 * can be loaded in a test against the in-memory fake database.
 */
import { pathToFileURL } from 'node:url';

const SEASON_LABEL_RE = /^\d{4}(-[a-z0-9]{1,16})?$/;

/**
 * @param {{ db: any, marketId: string, season: string, write: boolean, log?: (line: string) => void }} opts
 * @returns {Promise<{ scanned: number, updated: number, already_set: number }>}
 */
export async function runBackfill({ db, marketId, season, write, log = () => {} }) {
  if (!SEASON_LABEL_RE.test(season)) throw new Error(`Invalid season '${season}': expected '2026' or '2026-winter'`);
  const snap = await db.collection('producer_memberships').where('market_id', '==', marketId).get();
  let scanned = 0;
  let updated = 0;
  let alreadySet = 0;
  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data();
    if (typeof data.season === 'string' && data.season !== '') {
      alreadySet += 1;
      continue;
    }
    if (write) await db.collection('producer_memberships').doc(doc.id).update({ season });
    updated += 1;
  }
  const verb = write ? 'updated' : 'would update';
  log(`scanned ${scanned} / ${verb} ${updated} / already_set ${alreadySet}`);
  return { scanned, updated, already_set: alreadySet };
}

function parseArgs(argv) {
  const args = { dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--market':
        args.market = argv[(i += 1)];
        break;
      case '--season':
        args.season = argv[(i += 1)];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--write':
        args.dryRun = false;
        break;
      case '--db-project':
        args.dbProject = argv[(i += 1)];
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.market) throw new Error('--market is required');
  if (!args.season) throw new Error('--season is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    initializeApp(args.dbProject ? { projectId: args.dbProject } : undefined);
  }
  const db = getFirestore();
  await runBackfill({ db, marketId: args.market, season: args.season, write: !args.dryRun, log: (line) => console.log(line) });
  if (args.dryRun) console.log('(dry run - no writes made; pass --write to persist)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
