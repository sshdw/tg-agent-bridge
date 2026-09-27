/**
 * Minimal GitHub REST client built on `fetch` (Node 24, no `gh` dependency).
 * All calls are read-only except the ones used by /pr and /commit flows, which
 * live in `git.ts` (local git) and `pullRequests.ts`.
 *
 * The token comes only from `process.env.GITHUB_TOKEN` via config, is never
 * logged, and is stripped from any child process environment by spawnRunner.
 */

export interface GitHubUser {
  login: string;
}

export interface WorkflowRun {
  id: number;
  name: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  head_branch: string;
  head_sha: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePrInput {
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
}

export interface PullRequest {
  number: number;
  html_url: string;
  title: string;
}

const API = 'https://api.github.com';

export class GitHubClient {
  constructor(private readonly token: string) {}

  get configured(): boolean {
    return this.token !== '';
  }

  /** Cache headers matter: unauthenticated GitHub asks for conditional requests. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'tg-agent-bridge',
      'x-github-api-version': '2022-11-28',
    };
    if (this.token !== '') h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.configured) throw new Error('E_NO_GITHUB_TOKEN');
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (res.status === 404) throw new Error('E_GH_NOT_FOUND');
    if (res.status === 401 || res.status === 403) throw new Error('E_GH_FORBIDDEN');
    if (!res.ok) throw new Error(`E_GH_HTTP_${res.status}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async whoami(): Promise<GitHubUser> {
    return this.request<GitHubUser>('/user');
  }

  /** Latest workflow runs for a repo. `branch` empty means "all branches". */
  async latestRuns(repo: string, branch = '', perPage = 5): Promise<WorkflowRun[]> {
    const q = new URLSearchParams({ per_page: String(perPage) });
    if (branch !== '') q.set('branch', branch);
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>(
      `/repos/${repo}/actions/runs?${q.toString()}`,
    );
    return data.workflow_runs ?? [];
  }

  async createPullRequest(input: CreatePrInput): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${input.repo}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? '',
      }),
    });
  }

  /** Open PR for a head branch, or null when GitHub has none. */
  async findOpenPr(repo: string, head: string): Promise<PullRequest | null> {
    const owner = repo.split('/')[0] ?? '';
    const q = new URLSearchParams({ state: 'open', head: `${owner}:${head}` });
    const list = await this.request<PullRequest[]>(`/repos/${repo}/pulls?${q.toString()}`);
    return list[0] ?? null;
  }

  /** Default branch of a repo, for /pr when the local branch has no upstream. */
  async defaultBranch(repo: string): Promise<string> {
    const data = await this.request<{ default_branch: string }>(`/repos/${repo}`);
    return data.default_branch;
  }
}

/** Validate an `owner/repo` pair before it reaches the API or a SQL row. */
export function isRepoSlug(s: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(s);
}

/**
 * Validate an optional branch filter before it reaches the API, a SQL row or a
 * chat echo. Letters, digits, `.` `_` `-` `/` only: no whitespace, no shell
 * metachars, no control characters smuggled in from chat input.
 */
export function isBranchName(s: string): boolean {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(s);
}

/**
 * Collapse a workflow run into the small status vocabulary the poller diffs on:
 * success / failure / cancelled / pending / running / neutral.
 */
export function runStatus(run: WorkflowRun): string {
  if (run.status !== 'completed') return run.status;
  return run.conclusion ?? 'unknown';
}
