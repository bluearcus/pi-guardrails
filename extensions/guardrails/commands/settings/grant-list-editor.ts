import {
  type Component,
  Input,
  Key,
  matchesKey,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import {
  type CommandGrant,
  normalizeGrantDirectory,
} from "../../../../src/core/commands";

/**
 * Edits the command grants: a class of flagged command paired with the one
 * directory it is allowed in. A grant is two values, so a draft is filled in
 * two steps — the directory first, then the class it names.
 */

type Step = "directory" | "class";

interface Draft {
  directory: string;
  class: string;
}

function isCommandGrant(value: unknown): value is CommandGrant {
  if (!value || typeof value !== "object") return false;
  const entry = value as { class?: unknown; directory?: unknown };
  return typeof entry.class === "string" && typeof entry.directory === "string";
}

function isClassKey(value: string): boolean {
  return value.startsWith("builtin:") || value.startsWith("pattern:");
}

export class GrantListEditor implements Component {
  private readonly input = new Input();
  private grants: CommandGrant[];
  private selectedIndex = 0;
  private mode: "list" | "draft" = "list";
  private editIndex = -1;
  private step: Step = "directory";
  private draft: Draft = { directory: "", class: "" };
  private problem: string | undefined;

  constructor(
    private readonly options: {
      label: string;
      grants: CommandGrant[];
      theme: SettingsListTheme;
      onSave: (grants: CommandGrant[]) => void;
      onDone: () => void;
      maxVisible?: number;
    },
  ) {
    this.grants = options.grants.filter(isCommandGrant).map((grant) => ({
      class: grant.class,
      directory: grant.directory,
    }));
    this.input.onSubmit = () => this.submitStep();
    this.input.onEscape = () => this.cancel();
  }

  invalidate() {}

  render(width: number): string[] {
    const lines = [
      this.options.theme.label(` ${this.options.label}`, true),
      "",
    ];

    if (this.mode === "draft") {
      const filled = this.step === "class" ? this.draft.directory : undefined;
      lines.push(
        this.options.theme.hint(
          this.editIndex >= 0 ? "  Edit grant" : "  New grant",
        ),
      );
      if (filled) {
        lines.push(this.options.theme.hint(`  directory: ${filled}`));
      }
      lines.push(
        this.options.theme.hint(
          this.step === "directory"
            ? "  directory the grant covers:"
            : "  class: builtin:<what the flag was called> or pattern:<pattern>",
        ),
        "",
        ...this.input.render(Math.max(1, width - 4)).map((line) => `  ${line}`),
        "",
      );
      if (this.problem) {
        lines.push(this.options.theme.hint(`  ${this.problem}`));
      }
      lines.push(
        this.options.theme.hint("  Enter: next · Esc: cancel"),
        this.options.theme.hint(
          "  A grant covers that class under that directory only, never the directory itself.",
        ),
      );
      return lines;
    }

    if (this.grants.length === 0) {
      lines.push(this.options.theme.hint("  (empty)"));
    } else {
      const maxVisible = this.options.maxVisible ?? 10;
      const startIndex = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(maxVisible / 2),
          this.grants.length - maxVisible,
        ),
      );
      const endIndex = Math.min(startIndex + maxVisible, this.grants.length);
      for (let i = startIndex; i < endIndex; i++) {
        const grant = this.grants[i];
        if (!grant) continue;
        const isSelected = i === this.selectedIndex;
        const prefix = isSelected ? this.options.theme.cursor : "  ";
        lines.push(
          `${prefix}${this.options.theme.value(grant.directory, isSelected)} ${this.options.theme.hint(`[${grant.class}]`)}`,
        );
      }
      if (startIndex > 0 || endIndex < this.grants.length) {
        lines.push(
          this.options.theme.hint(
            `  (${this.selectedIndex + 1}/${this.grants.length})`,
          ),
        );
      }
    }

    lines.push("");
    lines.push(
      this.options.theme.hint(
        "  a: add · e/Enter: edit · d: delete · Esc: back",
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (this.mode === "draft") {
      this.input.handleInput(data);
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      if (this.grants.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.grants.length - 1
          : this.selectedIndex - 1;
    } else if (matchesKey(data, Key.down) || data === "j") {
      if (this.grants.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.grants.length - 1
          ? 0
          : this.selectedIndex + 1;
    } else if (data === "a" || data === "A") {
      this.startDraft(-1);
    } else if (data === "e" || data === "E" || matchesKey(data, Key.enter)) {
      this.startDraft(this.selectedIndex);
    } else if (data === "d" || data === "D") {
      this.deleteSelected();
    } else if (matchesKey(data, Key.escape)) {
      this.options.onDone();
    }
  }

  private startDraft(index: number): void {
    const grant = index >= 0 ? this.grants[index] : undefined;
    this.mode = "draft";
    this.editIndex = index;
    this.step = "directory";
    this.problem = undefined;
    this.draft = {
      directory: grant?.directory ?? "",
      class: grant?.class ?? "",
    };
    this.input.setValue(this.draft.directory);
  }

  private submitStep(): void {
    const value = this.input.getValue().trim();

    if (this.step === "directory") {
      const directory = normalizeGrantDirectory(value);
      if (!directory) {
        this.problem = "name one directory, e.g. /home/mike/project/build";
        return;
      }
      this.draft.directory = directory;
      this.step = "class";
      this.problem = undefined;
      this.input.setValue(this.draft.class);
      return;
    }

    if (!isClassKey(value)) {
      this.problem =
        'name the class the prompt showed: "builtin:recursive force delete" or "pattern:docker run --privileged"';
      return;
    }

    const grant: CommandGrant = {
      class: value,
      directory: this.draft.directory,
    };
    if (this.editIndex >= 0) {
      this.grants[this.editIndex] = grant;
    } else {
      this.grants.push(grant);
      this.selectedIndex = this.grants.length - 1;
    }
    this.grants = dedupe(this.grants);
    this.options.onSave([...this.grants]);
    this.cancel();
  }

  private deleteSelected(): void {
    if (this.grants.length === 0) return;
    this.grants.splice(this.selectedIndex, 1);
    if (this.selectedIndex >= this.grants.length) {
      this.selectedIndex = Math.max(0, this.grants.length - 1);
    }
    this.options.onSave([...this.grants]);
  }

  private cancel(): void {
    this.mode = "list";
    this.editIndex = -1;
    this.step = "directory";
    this.draft = { directory: "", class: "" };
    this.problem = undefined;
    this.input.setValue("");
  }
}

function dedupe(grants: CommandGrant[]): CommandGrant[] {
  const seen = new Set<string>();
  const result: CommandGrant[] = [];
  for (const grant of grants) {
    const key = `${grant.class}\u0000${grant.directory}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(grant);
  }
  return result;
}
