import type { Config } from '../config.js';
import type { Responder } from '../core/queue.js';
import type { Store } from '../storage/db.js';
import { GitHubClient, runStatus } from './client.js';
import { log } from '../log.js';

/**
 * `/watch` background poller.
 *
 * Every `cfg.ciPollMs` (default 5 min) it asks GitHub for the latest workflow runs
 * of each watched repo and DMs the owner when the status of the newest run changed.
 * Failures are deliberately quiet: a bad token, a deleted repo or a rate limit logs
 * once per repo and never spams the chat — the owner has too few messages to waste.
 */

/** Repos that already had a failure logged, so we log once instead of every tick. */
const reported = new Set<string>();

const RED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const GREEN = new Set(['success']);
const GRAY = new Set(['cancelled', 'skipped', 'neutral', 'stale']);

function emoji(status: string): string {
  if (GREEN.has(status)) return '🟢';
  if (RED.has(status)) return '🔴';
  if (GRAY.has(status)) return '⚪';
  return '🟡';
}

/** A run that is still working — seeing it start is never worth a DM. */
const PENDING = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

/**
 * True when the transition between two statuses is worth a DM: the newest run
 * reached a finished verdict (green, red or grey). Progress states are skipped
 * quietly — the owner cares about the verdict, not the start. Exported for the
 * offline harness.
 */
export function isNoteworthy(prev: string, next: string): boolean {
  if (prev === next) return false;
  return !PENDING.has(next);
}

export function startCiPoller(cfg: Config, store: Store, io: Responder): void {
  const client = new GitHubClient(cfg.githubToken);
  if (!client.configured) {
    log('ci poller: GITHUB_TOKEN absent — /watch entries will not be polled');
    return;
  }

  const tick = async (): Promise<void> => {
    const watches = store.listAllCiWatch();
    if (watches.length === 0) return;
    for (const w of watches) {
      try {
        const runs = await client.latestRuns(w.repo, w.branch, 1);
        const run = runs[0];
        if (!run) continue;
        const status = runStatus(run);
        if (!isNoteworthy(w.last_status, status)) continue;
        store.updateCiWatchState(w.chat_id, w.repo, status, run.id);
        reported.delete(`${w.chat_id}:${w.repo}`);
        const title = run.display_title === '' ? run.name : run.display_title;
        await io
          .notify(
            w.chat_id,
            `${emoji(status)} ${w.repo} ${w.branch === '' ? '' : `(${w.branch}) `}${status}\n${title}\n${run.html_url}`,
          )
          .catch(() => undefined);
      } catch (e) {
        const key = `${w.chat_id}:${w.repo}`;
        if (!reported.has(key)) {
          reported.add(key);
          const m = e instanceof Error ? e.message : String(e);
          log(`ci poller ${w.repo}: ${m}`);
        }
      }
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, cfg.ciPollMs);
  timer.unref?.();
  log(`ci poller up (every ${Math.round(cfg.ciPollMs / 1000)}s)`);
}
