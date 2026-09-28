/**
 * Preset commands: `/review`, `/test`, `/fix <symptom>`.
 *
 * Each preset is `/code` with a fixed role prefix, defined exactly once here.
 * The router only looks up the prefix; the plan flow in `plan.ts` composes it
 * with the user text and records the preset name on the task (for `/cost`).
 */

export const PRESET_NAMES = ['review', 'test', 'fix'] as const;

export type PresetName = (typeof PRESET_NAMES)[number];

/** Fixed role prefix per preset. English: these go to the agent, not the phone. */
export const PRESET_PREFIXES: Record<PresetName, string> = {
  review:
    'Code review. Inspect the project in the working directory (use `git diff` and recent changes when available) and report: bugs, risks, style issues, ordered by severity. Do NOT modify files. Target:',
  test:
    'Testing. In the working directory: run the existing test suite if there is one, otherwise propose and add the smallest useful tests for the requested target. Report pass/fail per test, keep the diff minimal. Target:',
  fix: 'Bug fix. Diagnose the root cause of the symptom below in the working directory project, explain it briefly, then fix it with the smallest reasonable diff and verify (run the relevant tests or a repro). Symptom:',
};

/** Default target when the user sends a bare `/review` or `/test`. */
export const PRESET_DEFAULT_TARGET = 'the whole project in the working directory';

export function isPreset(s: string): s is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(s);
}

/** Compose the final prompt: fixed prefix + user text (or the default target). */
export function applyPreset(name: PresetName, prompt: string): string {
  const target = prompt === '' ? PRESET_DEFAULT_TARGET : prompt;
  return `${PRESET_PREFIXES[name]}\n\n${target}`;
}
