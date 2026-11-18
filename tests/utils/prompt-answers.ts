/**
 * Drive the real permission-gate confirm component from a test.
 *
 * `ctx.ui.custom()` hands a test the component factory and resolves with whatever
 * the component hands back, so pressing the prompt's own keys keeps a test honest
 * about what an answer means: it cannot invent a result the prompt would not
 * produce.
 */

import { vi } from "vitest";
import type { PermissionGateAnswer } from "../../extensions/permission-gate/prompt";
import { NOOP_THEME } from "./theme";

const ANSWER_KEYS: Record<PermissionGateAnswer, string[]> = {
  allow: ["y"],
  "allow-session": ["a"],
  "allow-always": ["A"],
  deny: ["n"],
  stop: ["s"],
  // The picker answers the directories in the order the prompt lists them.
  choose: ["c", "a", "n", "\r"],
};

/** A `ctx.ui.custom` mock that presses these keys on the mounted component. */
export function pressKeys(keys: readonly string[]) {
  return vi.fn().mockImplementation(
    (
      factory: (
        tui: unknown,
        theme: unknown,
        kb: unknown,
        done: (result: unknown) => void,
      ) => { handleInput(key: string): void },
    ) =>
      new Promise((resolve) => {
        const component = factory(
          { terminal: { rows: 40, columns: 80 }, requestRender: () => {} },
          NOOP_THEME,
          {},
          resolve,
        );
        for (const key of keys) component.handleInput(key);
      }),
  );
}

/** A `ctx.ui.custom` mock that gives one of the prompt's flat answers. */
export function answerPrompt(answer: keyof typeof ANSWER_KEYS) {
  return pressKeys(ANSWER_KEYS[answer]);
}

/**
 * Turn whatever a test wrote for `ctx.ui.custom` into the real prompt being
 * pressed. A test may name the answer (`"deny"`) or write a mock that resolves
 * it; both end up pressing keys on the mounted component, so no test can claim
 * an answer the prompt would not produce. A mock that resolves nothing keeps
 * doing that, which is how the select fallback is exercised.
 */
export function answerFor(custom: unknown) {
  if (typeof custom === "string") return answerPrompt(custom as PermissionGateAnswer);
  if (typeof custom !== "function") return custom;

  const written = custom as (...args: unknown[]) => unknown;
  return vi.fn(async (...args: unknown[]) => {
    const value = await written(...args);
    if (typeof value !== "string") return value;
    return answerPrompt(value as PermissionGateAnswer)(...args);
  });
}
