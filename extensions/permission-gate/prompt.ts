import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CommandGrant } from "../../src/core/commands";
import { truncateToWidth } from "../shared/truncate";
import {
  actsOnTheGrantedDirectory,
  describeCommandClass,
  describeGrantDirectory,
  describeGrantOffer,
  describeGrants,
} from "./grants";

interface MinimalTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

interface NumberedWrappedRow {
  logicalLineNumber: number;
  rendered: string;
}

interface CommandViewportState {
  maxScrollOffset: number;
  pinnedRows: NumberedWrappedRow[];
  scrollWindowLines: number;
  scrollableRows: NumberedWrappedRow[];
}

const COMMAND_VIEWPORT_LINES = 12;

function buildNumberedWrappedLines(
  command: string,
  contentWidth: number,
  theme: Pick<MinimalTheme, "fg">,
): NumberedWrappedRow[] {
  const logicalLines = command.split("\n");
  const lineNumberWidth = Math.max(2, String(logicalLines.length).length);
  const prefixSpacing = 1;
  const textWidth = Math.max(1, contentWidth - lineNumberWidth - prefixSpacing);
  const rows: Array<{ logicalLineNumber: number; rendered: string }> = [];

  for (const [index, logicalLine] of logicalLines.entries()) {
    const lineNumber = index + 1;
    const wrapped = wrapTextWithAnsi(theme.fg("text", logicalLine), textWidth);
    const wrappedLines = wrapped.length > 0 ? wrapped : [""];
    const prefix = theme.fg(
      "dim",
      String(lineNumber).padStart(lineNumberWidth),
    );

    for (const line of wrappedLines) {
      rows.push({
        logicalLineNumber: lineNumber,
        rendered: `${prefix} ${line}`,
      });
    }
  }

  return rows;
}

function getCommandViewportState(
  command: string,
  contentWidth: number,
  theme: Pick<MinimalTheme, "fg">,
): CommandViewportState {
  const numberedRows = buildNumberedWrappedLines(command, contentWidth, theme);
  const pinnedRows = numberedRows.filter((row) => row.logicalLineNumber === 1);
  const scrollableRows = numberedRows.filter(
    (row) => row.logicalLineNumber !== 1,
  );
  const scrollWindowLines = Math.max(
    0,
    COMMAND_VIEWPORT_LINES - pinnedRows.length,
  );

  return {
    maxScrollOffset: Math.max(0, scrollableRows.length - scrollWindowLines),
    pinnedRows,
    scrollWindowLines,
    scrollableRows,
  };
}

function buildRightAlignedBorder(
  width: number,
  themeLine: (s: string) => string,
  label: string,
): string {
  const safeWidth = Math.max(1, width);
  const truncatedLabel = truncateToWidth(label, safeWidth);
  const remaining = safeWidth - visibleWidth(truncatedLabel);
  return themeLine("─".repeat(Math.max(0, remaining)) + truncatedLabel);
}

/** What the user decided about one directory the command impacts. */
export type GrantChoice = "session" | "always" | "once" | "refuse";

/** One directory, and the answer given for it. */
export interface GrantAnswer {
  grant: CommandGrant;
  choice: GrantChoice;
}

/**
 * What the prompt settled on.
 *
 * A flagged command runs or it does not — `rm -rf build out` cannot be run for
 * half its operands — so refusing one directory blocks the command, while the
 * grants chosen for the other directories stand on their own.
 */
export interface PermissionGateDecision {
  outcome: "allow" | "deny" | "stop";
  answers: GrantAnswer[];
}

/**
 * An answer from the flat option list. `choose` hands over to the per-directory
 * picker, where each directory gets its own answer.
 */
export type PermissionGateAnswer =
  | "allow"
  | "allow-session"
  | "allow-always"
  | "deny"
  | "stop"
  | "choose";

export interface PermissionGatePromptOption {
  label: string;
  result: PermissionGateAnswer;
  /** Single-key shortcut. Uppercase is the stronger, permanent answer. */
  key: string;
  disabled: boolean;
}

/**
 * The answers the prompt offers. A grant covers one class of command for one
 * directory, so the labels say both: the class the rule flagged, and each
 * directory the answer applies to. Where the command impacts no directory the
 * gate is willing to vouch for — it reaches outside the ground it works in, it
 * names nothing because the shell fills the path in, or the gate cannot place the
 * command at all — there is no grant answer, only allowing this one command.
 * When a command impacts several directories, `c` answers them one at a time, so
 * a session grant for one of them does not carry the others with it.
 */
export function permissionGatePromptOptions(
  grants: readonly CommandGrant[],
  alwaysEnabled: boolean,
): PermissionGatePromptOption[] {
  const options: PermissionGatePromptOption[] = [
    { label: "Allow once", result: "allow", key: "y", disabled: false },
  ];

  if (grants.length > 0) {
    const grantLabel = describeGrantOffer(grants);
    options.push(
      {
        label: `Allow ${grantLabel} this session`,
        result: "allow-session",
        key: "a",
        disabled: false,
      },
      {
        label: `Always allow ${grantLabel}`,
        result: "allow-always",
        key: "A",
        disabled: !alwaysEnabled,
      },
    );
  }

  if (grants.length > 1) {
    options.push({
      label: "Choose per directory (grant some, refuse others)",
      result: "choose",
      key: "c",
      disabled: false,
    });
  }

  options.push(
    { label: "Deny", result: "deny", key: "n", disabled: false },
    { label: "Decline and stop", result: "stop", key: "s", disabled: false },
  );
  return options;
}

export function enabledPermissionGatePromptOptions(
  grants: readonly CommandGrant[],
  alwaysEnabled: boolean,
): PermissionGatePromptOption[] {
  return permissionGatePromptOptions(grants, alwaysEnabled).filter(
    (option) => !option.disabled,
  );
}

/** The answers one directory can get, in the order a picker cycles through them. */
export function grantChoiceOptions(
  alwaysEnabled: boolean,
): { label: string; choice: GrantChoice; key: string }[] {
  const options: { label: string; choice: GrantChoice; key: string }[] = [
    {
      label: "Grant it for this session",
      choice: "session",
      key: "a",
    },
  ];
  if (alwaysEnabled) {
    options.push({ label: "Grant it always", choice: "always", key: "A" });
  }
  options.push(
    { label: "Allow this command once, no grant", choice: "once", key: "y" },
    { label: "Refuse — block this command", choice: "refuse", key: "n" },
  );
  return options;
}

/** A choice as a picker row spells it. */
export function describeGrantChoice(choice: GrantChoice): string {
  switch (choice) {
    case "session":
      return "session";
    case "always":
      return "always";
    case "once":
      return "once";
    default:
      return "refuse";
  }
}

/** The next answer for the highlighted directory, when the user cycles it. */
const CYCLE_ORDER: GrantChoice[] = ["once", "session", "always", "refuse"];

export function cycleGrantChoice(
  choice: GrantChoice,
  alwaysEnabled: boolean,
): GrantChoice {
  const order = CYCLE_ORDER.filter(
    (entry) => entry !== "always" || alwaysEnabled,
  );
  const index = order.indexOf(choice);
  return order[(index + 1) % order.length] ?? "once";
}

/** What a flat answer means for every directory the command impacts. */
export function decisionForAnswer(
  answer: PermissionGateAnswer,
  grants: readonly CommandGrant[],
): PermissionGateDecision {
  const choice: GrantChoice | undefined =
    answer === "allow-session"
      ? "session"
      : answer === "allow-always"
        ? "always"
        : undefined;
  const outcome =
    answer === "deny" ? "deny" : answer === "stop" ? "stop" : "allow";
  return {
    outcome,
    answers: choice
      ? grants.map((grant) => ({ grant, choice }))
      : grants.map((grant) => ({ grant, choice: "once" })),
  };
}

/** What the per-directory answers add up to. */
export function decisionForChoices(
  grants: readonly CommandGrant[],
  choices: readonly GrantChoice[],
): PermissionGateDecision {
  const answers: GrantAnswer[] = grants.map((grant, index) => ({
    grant,
    choice: choices[index] ?? "once",
  }));
  return {
    outcome: answers.some((answer) => answer.choice === "refuse")
      ? "deny"
      : "allow",
    answers,
  };
}

/**
 * The line that says what the answer means, because a grant is not the same thing
 * as allowing this command: it is this class of command, for one named directory,
 * and for nothing beside that directory. Every directory the command impacts is
 * listed, because each one is a separate grant the user is agreeing to.
 */
export function permissionGateGrantNote(
  grants: readonly CommandGrant[],
): string {
  if (grants.length === 0) {
    return "No directory grant is offered: a grant names one directory the command impacts, and this command does not name one the gate would vouch for — so only this command can be allowed.";
  }

  const [first] = grants;
  const oneClass =
    first !== undefined &&
    grants.every((grant) => grant.class === first.class) &&
    actsOnTheGrantedDirectory(first.class);

  if (oneClass && first) {
    const className = describeCommandClass(first.class);
    const header =
      grants.length === 1
        ? `The grant covers ${className} of one directory, and what is under it:`
        : `Each grant covers ${className} of one directory, and what is under it:`;
    const list = grants.map(
      (grant) => `• ${describeGrantDirectory(grant.directory)}`,
    );
    return [
      header,
      ...list,
      grants.length > 1
        ? "A delete of any other directory still asks. Press c to grant some of these and refuse others."
        : "A delete of any other directory still asks.",
    ].join("\n");
  }

  return `A grant covers ${describeGrants(grants)} only. Anywhere else still asks.`;
}

export interface PermissionGateConfirmOptions {
  /** What the decision delegates said about this command. */
  review?: string;
  /** The grants this answer would save, one per directory the command impacts. */
  grants?: readonly CommandGrant[];
  /** Whether an always grant can be saved from this session. */
  alwaysEnabled?: boolean;
}

export function createPermissionGateConfirmComponent(
  command: string,
  description: string,
  confirmOptions: PermissionGateConfirmOptions,
) {
  const review = confirmOptions.review;
  const grants = confirmOptions.grants ?? [];
  const alwaysEnabled = confirmOptions.alwaysEnabled ?? true;
  const promptOptions = permissionGatePromptOptions(grants, alwaysEnabled);

  return (
    tui: { terminal: { rows: number; columns: number }; requestRender(): void },
    theme: MinimalTheme,
    _kb: unknown,
    done: (decision: PermissionGateDecision) => void,
  ) => {
    const container = new Container();
    const redBorder = (s: string) => theme.fg("error", s);
    const dimBorder = (s: string) => theme.fg("dim", s);
    let scrollOffset = 0;
    // Several impacted directories are answered one at a time, so that granting
    // one of them does not grant the rest.
    let choosing = false;
    let cursor = 0;
    const choices: GrantChoice[] = grants.map(() => "once");
    const choiceAt = (index: number): GrantChoice => choices[index] ?? "once";

    container.addChild(new DynamicBorder(redBorder));
    container.addChild(
      new Text(
        theme.fg("error", theme.bold("Dangerous Command Detected")),
        1,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("warning", `This command contains ${description}:`),
        1,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    const commandTopBorder = new Text("", 0, 0);
    container.addChild(commandTopBorder);
    const commandText = new Text("", 1, 0);
    container.addChild(commandText);
    const commandBottomBorder = new Text("", 0, 0);
    container.addChild(commandBottomBorder);
    container.addChild(new Spacer(1));
    const reviewText = review ? new Text("", 1, 0) : undefined;
    if (reviewText) {
      container.addChild(reviewText);
      container.addChild(new Spacer(1));
    }
    const questionText = new Text(theme.fg("text", "Allow execution?"), 1, 0);
    container.addChild(questionText);
    container.addChild(new Spacer(1));
    const optionsText = new Text("", 0, 0);
    container.addChild(optionsText);
    const noteText = new Text(
      theme.fg("dim", permissionGateGrantNote(grants)),
      1,
      0,
    );
    container.addChild(noteText);
    container.addChild(new Spacer(1));
    const hintText = new Text(
      theme.fg("dim", "↑/↓ or j/k: scroll the command • Esc: deny"),
      1,
      0,
    );
    container.addChild(hintText);
    container.addChild(new DynamicBorder(redBorder));

    return {
      render: (width: number) => {
        const contentWidth = Math.max(1, width - 4);
        if (review && reviewText) {
          reviewText.setText(
            theme.fg(
              "warning",
              wrapTextWithAnsi(review, contentWidth).join("\n"),
            ),
          );
        }
        const {
          maxScrollOffset,
          pinnedRows,
          scrollWindowLines,
          scrollableRows,
        } = getCommandViewportState(command, contentWidth, theme);
        scrollOffset = Math.max(0, Math.min(scrollOffset, maxScrollOffset));

        const visibleScrollableRows = scrollableRows.slice(
          scrollOffset,
          scrollOffset + scrollWindowLines,
        );
        const visibleRows = [...pinnedRows, ...visibleScrollableRows];
        const linesBelow = Math.max(
          0,
          scrollableRows.length - (scrollOffset + visibleScrollableRows.length),
        );

        commandTopBorder.setText(
          buildRightAlignedBorder(
            width,
            dimBorder,
            scrollOffset > 0 ? `↑ ${scrollOffset} more` : "",
          ),
        );
        commandText.setText(visibleRows.map((row) => row.rendered).join("\n"));
        commandBottomBorder.setText(
          buildRightAlignedBorder(
            width,
            dimBorder,
            linesBelow > 0 ? `↓ ${linesBelow} more` : "",
          ),
        );
        if (choosing) {
          questionText.setText(theme.fg("text", "Answer each directory:"));
          const choiceWidth = 6;
          // The answer first, then the directory: the answer column lines up
          // from row to row, and the directory gets the rest of the line.
          const directoryWidth = Math.max(
            1,
            contentWidth - 2 - choiceWidth - 1,
          );
          optionsText.setText(
            grants
              .map((grant, index) => {
                const choice = choiceAt(index);
                const color =
                  choice === "refuse"
                    ? "error"
                    : choice === "once"
                      ? "dim"
                      : "warning";
                return [
                  index === cursor ? theme.fg("error", ">") : " ",
                  theme.fg(
                    color,
                    describeGrantChoice(choice).padEnd(choiceWidth),
                  ),
                  truncateToWidth(
                    describeGrantDirectory(grant.directory),
                    directoryWidth,
                  ),
                ].join(" ");
              })
              .join("\n"),
          );
          const refused = grants
            .filter((_, index) => choiceAt(index) === "refuse")
            .map((grant) => describeGrantDirectory(grant.directory));
          const saved = grants
            .map((grant, index) => ({ grant, choice: choiceAt(index) }))
            .filter(
              (answer) =>
                answer.choice === "session" || answer.choice === "always",
            )
            .map(
              (answer) =>
                `${describeGrantDirectory(answer.grant.directory)} (${describeGrantChoice(
                  answer.choice,
                )})`,
            );
          noteText.setText(
            theme.fg(
              "dim",
              wrapTextWithAnsi(
                [
                  refused.length > 0
                    ? `Enter blocks this command: refused ${refused.join(", ")}`
                    : "Enter runs this command.",
                  saved.length > 0
                    ? `Grants saved: ${saved.join(", ")}`
                    : "No grant is saved.",
                ].join("\n"),
                contentWidth,
              ).join("\n"),
            ),
          );
          hintText.setText(
            theme.fg(
              "dim",
              [
                "↑/↓ or j/k: move • Tab: next answer • Enter: apply • Esc: back",
                "a: session grant • A: always grant • y: allow once • n: refuse",
              ].join("\n"),
            ),
          );
          return container.render(width);
        }

        questionText.setText(theme.fg("text", "Allow execution?"));
        optionsText.setText(
          promptOptions
            .filter((option) => !option.disabled)
            .map(
              (option) =>
                `  ${option.key}  ${truncateToWidth(
                  option.label,
                  Math.max(1, contentWidth - 6),
                )}`,
            )
            .join("\n"),
        );
        noteText.setText(
          theme.fg(
            "dim",
            wrapTextWithAnsi(
              permissionGateGrantNote(grants),
              contentWidth,
            ).join("\n"),
          ),
        );
        hintText.setText(
          theme.fg("dim", "↑/↓ or j/k: scroll the command • Esc: deny"),
        );
        return container.render(width);
      },
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const contentWidth = Math.max(1, tui.terminal.columns - 4);
        const { maxScrollOffset } = getCommandViewportState(
          command,
          contentWidth,
          theme,
        );

        if (choosing) {
          const move = (step: number) => {
            cursor = Math.max(0, Math.min(grants.length - 1, cursor + step));
            tui.requestRender();
          };

          if (matchesKey(data, Key.up) || data === "k") {
            move(-1);
          } else if (matchesKey(data, Key.down) || data === "j") {
            move(1);
          } else if (matchesKey(data, Key.enter)) {
            done(decisionForChoices(grants, choices));
          } else if (matchesKey(data, Key.escape)) {
            // Back to the plain answers; nothing was saved or decided.
            choosing = false;
            tui.requestRender();
          } else if (data === "\t" || data === " ") {
            choices[cursor] = cycleGrantChoice(choiceAt(cursor), alwaysEnabled);
            tui.requestRender();
          } else if (data.length === 1) {
            const option = grantChoiceOptions(alwaysEnabled).find(
              (entry) => entry.key === data,
            );
            if (option) {
              choices[cursor] = option.choice;
              // Answering a list is a run of keys, so the cursor steps on.
              move(1);
            }
          }
          return;
        }

        if (matchesKey(data, Key.up) || data === "k") {
          scrollOffset = Math.max(0, scrollOffset - 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.down) || data === "j") {
          scrollOffset = Math.min(maxScrollOffset, scrollOffset + 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          done(decisionForAnswer("allow", grants));
        } else if (matchesKey(data, Key.escape)) {
          done(decisionForAnswer("deny", grants));
        } else if (data.length === 1) {
          // A key that names an option is used as written, so an uppercase
          // answer never folds into the lowercase one below it: when the
          // always grant is unavailable, its key does nothing.
          const exact = promptOptions.find((option) => option.key === data);
          if (exact) {
            if (exact.disabled) return;
            if (exact.result === "choose") {
              choosing = true;
              tui.requestRender();
              return;
            }
            done(decisionForAnswer(exact.result, grants));
            return;
          }
          const folded = promptOptions.find(
            (option) => option.key.toLowerCase() === data.toLowerCase(),
          );
          if (folded && !folded.disabled && folded.result !== "choose") {
            done(decisionForAnswer(folded.result, grants));
          }
        }
      },
    };
  };
}
