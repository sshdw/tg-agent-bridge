import type { Config } from '../config.js';
import { getProvider } from '../gateway/registry.js';
import type { AgentEvent, AgentId, AgentTask, HistoryItem, TaskMode } from '../gateway/types.js';
import { composePrompt } from '../gateway/spawnRunner.js';
import type { Store } from '../storage/db.js';
import { AttachCensor, outboundErrorMessage, planAttachments } from './files.js';
import { resolveWorkdir } from './permissions.js';
import { getOrCreate } from './sessions.js';
import { bindApprovalStore, resolveApproval } from './approvals.js';
import { log } from '../log.js';

export interface StreamHandle {
  push(delta: string): void;
  finish(text: string): Promise<void>;
  fail(code: string): Promise<void>;
}

export interface SubmitOptions {
  /** `/review`, `/test`, `/fix` — recorded on the task for `/cost` breakdowns. */
  preset?: string;
  /** Extra system-ish instruction prepended to the prompt (presets, plan comments). */
  rolePrefix?: string;
  /** Plan mode: park the task as `awaiting_plan` instead of executing it. */
  planOnly?: boolean;
}

/** Caption for files the agent asked to send, shown under an inline photo. */
export const ATTACH_CAPTION = '📎 Из ответа агента';

export interface Responder {
  streamStart(chatId: number, options?: { mode?: TaskMode; label?: string }): Promise<StreamHandle>;
  askApproval(chatId: number, command: string): Promise<boolean>;
  notify(chatId: number, text: string, keyboard?: unknown): Promise<void>;
  /**
   * Optional (WAVE2/FILES): send the files an agent reply asked for — the explicit
   * `[[attach:path]]` markers first, the conservative path guesser as a fallback.
   * `caption` labels the upload (used as the photo caption); each file's own name is
   * always appended. Kept optional so a Responder without file support still satisfies
   * the contract; the queue only calls it when present.
   */
  attachFiles?(chatId: number, paths: string[], caption?: string): Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('E_TIMEOUT'));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const errCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('E_') ? m.split(':')[0] ?? 'E_AGENT_FAILED' : 'E_AGENT_FAILED';
};

export class TaskQueue {
  private pumping = new Set<number>();
  private streams = new Map<number, StreamHandle>();
  private sessionIds = new Map<number, string>();
  /** Tasks parked on plan approval: chatId -> taskId awaiting a decision. */
  private planWaiting = new Map<number, { taskId: number; plan: string; reworks: number; origin: string }>();
  // WAVE2/EXEC-BEGIN (plan turns: agent drafts a plan first, chat approves, then it runs)
  /** Task ids currently running as plan turns (stored prompt is the real one). */
  private planTurns = new Set<number>();
  /** Plan turn id -> original implementation prompt (restored on approve). */
  private planOrigin = new Map<number, string>();
  /** Plan turn id -> rework rounds already spent. */
  private planRounds = new Map<number, number>();
  /** Set by plan.ts: deliver the approve/rework keyboard after a plan turn. */
  private planNotify: ((chatId: number, taskId: number, plan: string) => Promise<void>) | null = null;

  /** plan.ts delivers the approve/rework keyboard through this hook (queue stays telegram-free). */
  onPlanReady(fn: (chatId: number, taskId: number, plan: string) => Promise<void>): void {
    this.planNotify = fn;
  }
  // WAVE2/EXEC-END

  constructor(
    private store: Store,
    private cfg: Config,
    private io: Responder,
  ) {
    // The approvals bridge must point at the live database; a reopen builds a
    // new Store + a new queue, which rebinds here. Plan fast-path state is
    // rebuilt from the durable `awaiting_plan` rows right after.
    bindApprovalStore(this.store);
    this.restorePlans();
  }

  /**
   * Boot restore: rebuild the fast-path plan map from durable `awaiting_plan`
   * rows, so a parked plan survives a restart (W2 AC3). Memory stays a cache —
   * the rows are the source of truth.
   */
  private restorePlans(): void {
    try {
      for (const row of this.store.awaitingPlans()) {
        if (this.planWaiting.has(row.chat_id)) continue;
        this.planWaiting.set(row.chat_id, {
          taskId: row.id,
          plan: row.plan_text ?? '',
          reworks: row.plan_reworks ?? 0,
          origin: row.plan_origin ?? row.prompt ?? '',
        });
      }
    } catch {
      // A store that cannot list plans must not break boot; chat flows fall
      // back to per-chat lookups in `waitingFor`.
    }
  }

  /**
   * The parked plan for a chat: memory fast path first, durable row on a miss
   * (cold boot). The miss populates the map, so later calls stay cheap.
   */
  private waitingFor(chatId: number): { taskId: number; plan: string; reworks: number; origin: string } | undefined {
    const hit = this.planWaiting.get(chatId);
    if (hit) return hit;
    try {
      const row = this.store.awaitingPlan(chatId);
      if (!row) return undefined;
      const waiting = {
        taskId: row.id,
        plan: row.plan_text ?? '',
        reworks: row.plan_reworks ?? 0,
        origin: row.plan_origin ?? row.prompt ?? '',
      };
      this.planWaiting.set(chatId, waiting);
      return waiting;
    } catch {
      return undefined;
    }
  }

  submit(
    chatId: number,
    prompt: string,
    mode: TaskMode,
    images: string[],
    options: SubmitOptions = {},
  ): 'started' | 'queued' | 'planned' {
    const s = getOrCreate(this.store, this.cfg, chatId);
    this.store.addMessage(chatId, 'user', prompt);
    const taskId = this.store.createTask(chatId, s.agent, mode, prompt, images, options.preset ?? '');
    if (options.planOnly === true) {
      // WAVE2/EXEC (plan turn): the stored prompt stays the real one; the pump
      // runs the agent for a plan, execute() wraps the prompt and parks the result.
      this.planTurns.add(taskId);
      this.planOrigin.set(taskId, prompt);
      this.planRounds.set(taskId, 0);
      // Durable from birth: a restart mid-plan-turn must keep origin + rounds.
      try {
        this.store.setTaskPlanMeta(taskId, prompt, 0);
      } catch {
        // memory above already carries this tick; the meta lands on park
      }
      if (this.pumping.has(chatId)) return 'planned';
      void this.pump(chatId);
      return 'planned';
    }
    if (this.pumping.has(chatId)) return 'queued';
    void this.pump(chatId);
    return 'started';
  }

  /** Plan flow: the owner approved a parked task — restore the real prompt and run it. */
  approvePlan(chatId: number): number | null {
    const waiting = this.waitingFor(chatId);
    if (!waiting) return null;
    this.planWaiting.delete(chatId);
    // The parked row holds a plan-turn (or rework) prompt: put the original
    // implementation prompt back, with the approved plan attached as context.
    const task = this.store.getTask(waiting.taskId);
    const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
    this.store.setTaskPrompt(waiting.taskId, `${origin}\n\nApproved plan to follow:\n${waiting.plan}`);
    this.store.setTaskStatus(waiting.taskId, 'pending');
    if (!this.pumping.has(chatId)) void this.pump(chatId);
    return waiting.taskId;
  }

  /**
   * Plan flow: plain-text reply treated as a plan comment. Follow-up runs are
   * plan turns too (buttons each round). Returns false when out of rounds —
   * the caller then runs the task anyway.
   */
  reworkPlan(chatId: number, comment: string): { rounds: number } | null {
    const waiting = this.waitingFor(chatId);
    if (!waiting) return null;
    // The DB is authoritative for spent rounds: after a restart the memory map
    // is rebuilt from `plan_reworks`, but take the max so a hot tick never lags.
    const spent = this.store.getTask(waiting.taskId)?.plan_reworks ?? waiting.reworks;
    const reworks = Math.max(waiting.reworks, spent);
    if (reworks >= MAX_PLAN_REWORKS) {
      // Out of rework rounds: run the task anyway, as specified.
      this.planWaiting.delete(chatId);
      const task = this.store.getTask(waiting.taskId);
      const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
      this.store.setTaskPrompt(waiting.taskId, `${origin}\n\nApproved plan to follow:\n${waiting.plan}`);
      this.store.setTaskStatus(waiting.taskId, 'pending');
      if (!this.pumping.has(chatId)) void this.pump(chatId);
      return null;
    }
    const rounds = waiting.reworks + 1;
    const task = this.store.getTask(waiting.taskId);
    const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
    this.store.setTaskPlan(waiting.taskId, waiting.plan);
    this.store.addMessage(chatId, 'user', comment);
    this.store.setTaskStatus(waiting.taskId, 'cancelled');
    this.planWaiting.delete(chatId);
    const s = getOrCreate(this.store, this.cfg, chatId);
    const nextId = this.store.createTask(
      chatId,
      task?.agent ?? s.agent,
      task?.mode ?? 'code',
      `${PLAN_REWORK_PREFIX}${comment}`,
      [],
      'plan-rework',
    );
    this.planTurns.add(nextId);
    this.planOrigin.set(nextId, origin);
    this.planRounds.set(nextId, rounds);
    // Durable from birth, like the first plan turn in submit().
    try {
      this.store.setTaskPlanMeta(nextId, origin, rounds);
    } catch {
      // memory above already carries this tick; the meta lands on park
    }
    if (!this.pumping.has(chatId)) void this.pump(chatId);
    return { rounds };
  }

  /** Register a plan for button-driven approval, keyed by chat. */
  parkPlan(chatId: number, taskId: number, plan: string, reworks = 0, origin = ''): void {
    this.planWaiting.set(chatId, { taskId, plan, reworks, origin });
    // The parked plan must survive a restart: origin + rework count live on
    // the row (`awaiting_plan` + `plan_text` were already durable).
    try {
      this.store.setTaskPlanMeta(taskId, origin, reworks);
    } catch {
      // memory above already carries this tick
    }
  }

  hasPlan(chatId: number): boolean {
    return this.waitingFor(chatId) !== undefined;
  }

  async cancel(chatId: number): Promise<'approval' | 'task' | 'plan' | 'nothing'> {
    if (resolveApproval(chatId, false)) return 'approval';
    const waiting = this.waitingFor(chatId);
    if (waiting) {
      this.planWaiting.delete(chatId);
      this.store.setTaskStatus(waiting.taskId, 'cancelled');
      return 'plan';
    }
    const task = this.store.runningTask(chatId);
    if (!task || !this.pumping.has(chatId)) return 'nothing';
    this.store.setTaskStatus(task.id, 'cancelled');
    const sid = this.sessionIds.get(chatId);
    if (sid) {
      try {
        await getProvider(task.agent).cancel(sid);
      } catch {
        // provider cancel is best-effort
      }
    }
    await this.streams.get(chatId)?.fail('E_CANCELLED');
    return 'task';
  }

  status(chatId: number): { running: boolean; pending: number; plan: boolean } {
    return {
      running: this.pumping.has(chatId),
      pending: this.store.pendingCount(chatId),
      plan: this.waitingFor(chatId) !== undefined,
    };
  }

  private async pump(chatId: number): Promise<void> {
    if (this.pumping.has(chatId)) return;
    this.pumping.add(chatId);
    try {
      for (;;) {
        const task = this.store.oldestPending(chatId);
        if (!task) return;
        await this.execute(chatId, task.id);
      }
    } finally {
      this.pumping.delete(chatId);
      this.streams.delete(chatId);
      this.sessionIds.delete(chatId);
    }
  }

  private async execute(chatId: number, taskId: number): Promise<void> {
    const task0 = this.store.getTask(taskId);
    const stream = await this.io.streamStart(chatId, {
      mode: (task0?.mode as TaskMode) ?? 'ask',
      label: task0?.preset ?? '',
    });
    this.streams.set(chatId, stream);
    this.store.setTaskStatus(taskId, 'running');
    try {
      const s = getOrCreate(this.store, this.cfg, chatId);
      const task = this.store.getTask(taskId);
      if (!task) throw new Error('E_NO_TASK');
      const workdir = resolveWorkdir(this.cfg, chatId, s.project);
      const history: HistoryItem[] = this.store
        .recentMessages(chatId, this.cfg.historyLimit)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
      const sessionId = `${chatId}:${task.id}`;
      this.sessionIds.set(chatId, sessionId);
      const images: string[] = JSON.parse(task.images) as string[];
      const agentTask: AgentTask = {
        sessionId,
        agent: task.agent as AgentId,
        mode: task.mode as TaskMode,
        model: s.model,
        // WAVE2/EXEC (plan turn): the stored prompt is the real one; the plan
        // instruction wraps it here so approve can run the original as-is.
        prompt: this.planTurns.has(taskId) ? planPrompt(task.prompt) : task.prompt,
        images,
        workdir,
        autoApprove: s.autoApprove,
        timeoutMs: this.cfg.taskTimeoutMs,
        history,
        // Only opencode holds a real session today; other providers ignore it and
        // get history injection from `composePrompt`.
        resumeSessionId: task.agent === 'opencode' ? s.agentSessionId : '',
        requestApproval: (cmd) => this.io.askApproval(chatId, cmd),
        onSessionId: (id) => {
          try {
            this.store.setAgentSessionId(chatId, id === '' ? null : id);
          } catch {
            // a failed session-id write must not fail the task itself
          }
        },
      };
      const provider = getProvider(agentTask.agent);
      let full = '';
      // Attach markers are stripped from the LIVE message too, not just from the final
      // text: `[[attach:…]]` is protocol, and the owner must never see it arrive.
      const censor = new AttachCensor();
      const onEvent = (e: AgentEvent): void => {
        if (e.type === 'text') {
          full += e.delta;
          stream.push(censor.push(e.delta));
        }
      };
      const result = await withTimeout(provider.run(agentTask, onEvent), this.cfg.taskTimeoutMs, () => {
        void provider.cancel(sessionId);
      });
      // The plan for an attachment: visible text with the markers gone, plus the files
      // every marker and the fallback guesser resolved to inside the workdir.
      const plan = planAttachments(result.text === '' ? full : result.text, workdir);
      const reply = plan.text === '' ? '(пустой ответ)' : plan.text;
      // WAVE2/EXEC-BEGIN (plan turn completion: park the plan, ask to run)
      if (this.planTurns.delete(taskId)) {
        // Origin + rounds prefer memory, but the row carries them too — a
        // restart between submit and completion must not reset the counter.
        const origin = this.planOrigin.get(taskId) ?? task.plan_origin ?? task.prompt;
        const rounds = this.planRounds.get(taskId) ?? task.plan_reworks ?? 0;
        this.planOrigin.delete(taskId);
        this.planRounds.delete(taskId);
        this.store.setTaskPlan(taskId, reply);
        this.store.addMessage(chatId, 'assistant', reply);
        this.store.setTaskStatus(taskId, 'awaiting_plan');
        this.parkPlan(chatId, taskId, reply, rounds, origin);
        await stream.finish(reply);
        const notify = this.planNotify;
        if (notify) {
          try {
            await notify(chatId, taskId, reply);
          } catch {
            // the plan itself is already delivered; a dead keyboard is minor
          }
        }
        return;
      }
      // WAVE2/EXEC-END
      this.store.setTaskCost(taskId, result.costUsd);
      this.store.addMessage(chatId, 'assistant', reply);
      this.store.setTaskStatus(taskId, 'done');
      await stream.finish(reply);
      // WAVE2/FILES: send what the answer asked for. Best-effort — a failed upload
      // must never fail the task — but every refused marker is told to the owner,
      // because a silently missing file is indistinguishable from a broken bot.
      for (const p of plan.problems) {
        await this.io
          .notify(chatId, `${outboundErrorMessage(p.code)}\nФайл: ${p.requested}`)
          .catch((e) => log(`attach-notify: ${errCode(e)}`));
      }
      if (this.io.attachFiles && plan.files.length > 0) {
        try {
          await this.io.attachFiles(chatId, plan.files, ATTACH_CAPTION);
        } catch (e) {
          log(`attach-files: ${errCode(e)}`);
        }
      }
    } catch (e) {
      const code = errCode(e);
      // WAVE2/EXEC (plan turn): a failed plan leaves nothing parked — clean up.
      this.planTurns.delete(taskId);
      this.planOrigin.delete(taskId);
      this.planRounds.delete(taskId);
      this.store.setTaskStatus(taskId, code === 'E_CANCELLED' ? 'cancelled' : 'error');
      await stream.fail(code);
    }
  }
}

/** Plan mode: at most two rework rounds, then the task runs regardless. */
export const MAX_PLAN_REWORKS = 2;

export const PLAN_REWORK_PREFIX =
  'The user reviewed your plan and asked for changes. Produce an UPDATED short plan only, do not implement yet. Comment: ';

/** Instruction prepended to a /code turn when plan mode is on. */
export const PLAN_FIRST_INSTRUCTION =
  'Plan first. Reply with a SHORT plan (max 8 bullet points): files to touch, steps, risks. Do NOT write code or modify files in this turn.';

/** Turn a parked plan request into the composed prompt actually sent to the agent. */
export function planPrompt(prompt: string): string {
  return `${PLAN_FIRST_INSTRUCTION}\n\n${prompt}`;
}

/** Exported so the queue can hand `composePrompt` a plan-shaped task when needed. */
export { composePrompt };
