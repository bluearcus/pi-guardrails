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
import { describeGrant } from "./grants";

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

export type PermissionGateConfirmResult =
  | "allow"
  | "allow-session"
  | "allow-always"
  | "deny"
  | "stop";

export interface PermissionGatePromptOption {
  label: string;
  result: PermissionGateConfirmResult;
  /** Single-key shortcut. Uppercase is the stronger, permanent answer. */
  key: string;
  disabled: boolean;
}

/**
 * The answers the prompt offers. A grant covers one class of command inside one
 * directory, so the labels say both: the class the rule flagged, and the
 * directory the answer applies to. Where no directory grant would honestly
 * cover the action — the targets span directories, the action reaches outside
 * the ground the call is working in, or the gate cannot place the command at all
 * — there is no grant answer, only allowing this one command.
 */
export function permissionGatePromptOptions(
  grant: CommandGrant | undefined,
  alwaysEnabled: boolean,
): PermissionGatePromptOption[] {
  const options: PermissionGatePromptOption[] = [
    { label: "Allow once", result: "allow", key: "y", disabled: false },
  ];

  if (grant) {
    const grantLabel = describeGrant(grant);
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

  options.push(
    { label: "Deny", result: "deny", key: "n", disabled: false },
    { label: "Decline and stop", result: "stop", key: "s", disabled: false },
  );
  return options;
}

export function enabledPermissionGatePromptOptions(
  grant: CommandGrant | undefined,
  alwaysEnabled: boolean,
): PermissionGatePromptOption[] {
  return permissionGatePromptOptions(grant, alwaysEnabled).filter(
    (option) => !option.disabled,
  );
}

/**
 * The line that says what the answer means, because a grant is not the same
 * thing as allowing this command: it is this class of command, in this
 * directory, and nowhere else.
 */
export function permissionGateGrantNote(
  grant: CommandGrant | undefined,
): string {
  if (!grant) {
    return "No directory grant would cover this action — a grant is one class of command under one directory you are working in — so only this command can be allowed.";
  }
  return `A grant covers ${describeGrant(grant)} only. Another directory still asks.`;
}

export interface PermissionGateConfirmOptions {
  /** What the decision delegates said about this command. */
  review?: string;
  /** The grant this answer would save, if one can be named. */
  grant?: CommandGrant;
  /** Whether an always grant can be saved from this session. */
  alwaysEnabled?: boolean;
}

export function createPermissionGateConfirmComponent(
  command: string,
  description: string,
  confirmOptions: PermissionGateConfirmOptions,
) {
  const review = confirmOptions.review;
  const grant = confirmOptions.grant;
  const promptOptions = permissionGatePromptOptions(
    grant,
    confirmOptions.alwaysEnabled ?? true,
  );

  return (
    tui: { terminal: { rows: number; columns: number }; requestRender(): void },
    theme: MinimalTheme,
    _kb: unknown,
    done: (result: PermissionGateConfirmResult) => void,
  ) => {
    const container = new Container();
    const redBorder = (s: string) => theme.fg("error", s);
    const dimBorder = (s: string) => theme.fg("dim", s);
    let scrollOffset = 0;

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
    container.addChild(new Text(theme.fg("text", "Allow execution?"), 1, 0));
    container.addChild(new Spacer(1));
    const optionsText = new Text("", 0, 0);
    container.addChild(optionsText);
    const noteText = new Text(
      theme.fg("dim", permissionGateGrantNote(grant)),
      1,
      0,
    );
    container.addChild(noteText);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("dim", "↑/↓ or j/k: scroll the command • Esc: deny"),
        1,
        0,
      ),
    );
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
            wrapTextWithAnsi(permissionGateGrantNote(grant), contentWidth).join(
              "\n",
            ),
          ),
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

        if (matchesKey(data, Key.up) || data === "k") {
          scrollOffset = Math.max(0, scrollOffset - 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.down) || data === "j") {
          scrollOffset = Math.min(maxScrollOffset, scrollOffset + 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          done("allow");
        } else if (matchesKey(data, Key.escape)) {
          done("deny");
        } else if (data.length === 1) {
          // A key that names an option is used as written, so an uppercase
          // answer never folds into the lowercase one below it: when the
          // always grant is unavailable, its key does nothing.
          const exact = promptOptions.find((option) => option.key === data);
          if (exact) {
            if (!exact.disabled) done(exact.result);
            return;
          }
          const folded = promptOptions.find(
            (option) => option.key.toLowerCase() === data.toLowerCase(),
          );
          if (folded && !folded.disabled) done(folded.result);
        }
      },
    };
  };
}
