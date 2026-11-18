import { describe, expect, it, vi } from "vitest";
import type { CommandGrant } from "../../src/core/commands";
import { NOOP_THEME } from "../../tests/utils/theme";
import {
  createPermissionGateConfirmComponent,
  enabledPermissionGatePromptOptions,
  type PermissionGateDecision,
  permissionGatePromptOptions,
} from "./prompt";

const DELETE_CLASS = "builtin:recursive force delete";
const DEFAULT_GRANTS: CommandGrant[] = [
  { class: DELETE_CLASS, directory: "/home/mike/project/build" },
];
const TWO_GRANTS: CommandGrant[] = [
  { class: DELETE_CLASS, directory: "/home/mike/project/build" },
  { class: DELETE_CLASS, directory: "/home/mike/project/out" },
];

function mount(
  command: string,
  description = "recursive delete",
  options: {
    review?: string;
    grants?: CommandGrant[] | null;
    alwaysEnabled?: boolean;
  } = {},
) {
  let captured: PermissionGateDecision | undefined;
  const done = (decision: PermissionGateDecision) => {
    captured = decision;
  };

  const tui = {
    terminal: { rows: 40, columns: 80 },
    requestRender: vi.fn(),
  };

  const component = createPermissionGateConfirmComponent(command, description, {
    review: options.review,
    grants:
      "grants" in options ? (options.grants ?? undefined) : DEFAULT_GRANTS,
    alwaysEnabled: options.alwaysEnabled,
  })(tui, NOOP_THEME, {}, done);

  const rendered = () => {
    const output = component.render(80);
    return Array.isArray(output) ? output.join("\n") : String(output);
  };

  return { component, rendered, result: () => captured };
}

function renderedLines(component: {
  render(width: number): string | string[];
}) {
  const output = component.render(80);
  return Array.isArray(output) ? output : String(output).split("\n");
}

/** The answers that leave a standing grant behind. */
function grantsSaved(decision?: PermissionGateDecision) {
  return (
    decision?.answers.filter(
      (answer) => answer.choice === "session" || answer.choice === "always",
    ) ?? []
  );
}

describe("permission gate prompt options", () => {
  it("labels a grant with the class and the directory it covers", () => {
    const options = permissionGatePromptOptions(DEFAULT_GRANTS, true);
    const labels = options.map((option) => option.label);

    expect(labels).toEqual([
      "Allow once",
      "Allow recursive force delete of ~/project/build this session",
      "Always allow recursive force delete of ~/project/build",
      "Deny",
      "Decline and stop",
    ]);
  });

  it("labels an answer that covers several directories", () => {
    const labels = permissionGatePromptOptions(TWO_GRANTS, true).map(
      (option) => option.label,
    );

    expect(labels).toContain(
      "Allow recursive force delete of ~/project/build, ~/project/out this session",
    );
    expect(labels).toContain(
      "Always allow recursive force delete of ~/project/build, ~/project/out",
    );
  });

  it("offers no grant when no directory covers the action", () => {
    expect(
      permissionGatePromptOptions([], true).map((option) => option.result),
    ).toEqual(["allow", "deny", "stop"]);
  });

  it("offers a per-directory answer only when there is more than one directory", () => {
    expect(
      permissionGatePromptOptions(DEFAULT_GRANTS, true).map(
        (option) => option.result,
      ),
    ).not.toContain("choose");
    expect(
      permissionGatePromptOptions(TWO_GRANTS, true).map(
        (option) => option.result,
      ),
    ).toContain("choose");
  });

  it("disables the always option when its grant cannot be saved", () => {
    const options = permissionGatePromptOptions(DEFAULT_GRANTS, false);
    const always = options.find((option) => option.result === "allow-always");

    expect(always?.disabled).toBe(true);
    expect(
      enabledPermissionGatePromptOptions(DEFAULT_GRANTS, false).map(
        (option) => option.result,
      ),
    ).not.toContain("allow-always");
  });
});

describe("createPermissionGateConfirmComponent", () => {
  it("renders without throwing", () => {
    const { rendered } = mount("rm -rf /");
    expect(() => rendered()).not.toThrow();
  });

  it("renders the reviewer's reasoning above the decision", () => {
    const { component } = mount("rm -rf /", "recursive delete", {
      review:
        "Model review (2.4s): classifier: your request probably covers this, but only 82% sure",
    });
    const lines = renderedLines(component);
    // The review wraps, so look for the phrase that starts it.
    const reviewIndex = lines.findIndex((line) =>
      line.includes("Model review (2.4s)"),
    );
    const decisionIndex = lines.findIndex((line) =>
      line.includes("Allow execution?"),
    );

    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(decisionIndex).toBeGreaterThan(reviewIndex);
  });

  it("omits the reviewer line when nothing reviewed the action", () => {
    expect(mount("rm -rf /").rendered()).not.toContain("Model review");
  });

  it("lists the answers with their keys, naming the directory a grant covers", () => {
    const output = mount("rm -rf build", "recursive force delete").rendered();

    expect(output).toContain("y  Allow once");
    expect(output).toContain(
      "a  Allow recursive force delete of ~/project/build this session",
    );
    expect(output).toContain(
      "A  Always allow recursive force delete of ~/project/build",
    );
    expect(output).toContain("n  Deny");
    expect(output).toContain("s  Decline and stop");
    expect(output).toContain("scroll the command");
  });

  it("says what a grant covers, naming the directory it is taken for", () => {
    const output = mount("rm -rf build", "recursive force delete").rendered();

    expect(output).toContain("~/project/build");
    // The note wraps, so it is checked as the sentence it spells.
    const spelled = output.replace(/\s+/g, " ");
    expect(spelled).toContain(
      "The grant covers recursive force delete of one directory, and what is under it:",
    );
    expect(spelled).toContain("A delete of any other directory still asks.");
  });

  it("lists every directory when an answer covers several", () => {
    const { component } = mount("rm -rf build out", "recursive force delete", {
      grants: TWO_GRANTS,
    });
    const lines = renderedLines(component);

    const listed = lines.filter(
      (line) =>
        line.includes("~/project/build") || line.includes("~/project/out"),
    );
    expect(listed.some((line) => line.includes("~/project/build"))).toBe(true);
    expect(listed.some((line) => line.includes("~/project/out"))).toBe(true);
    expect(lines.some((line) => line.includes("Each grant covers"))).toBe(true);
  });

  it("counts the directories in a label and still lists them in the note", () => {
    const many: CommandGrant[] = ["build", "out", "tests", "extra"].map(
      (name) => ({
        class: DELETE_CLASS,
        directory: `/home/mike/project/${name}`,
      }),
    );
    const labels = permissionGatePromptOptions(many, true).map(
      (option) => option.label,
    );
    expect(labels).toContain(
      "Allow recursive force delete of 4 directories this session",
    );

    const lines = mount(
      "rm -rf build out tests extra",
      "recursive force delete",
      {
        grants: many,
      },
    )
      .rendered()
      .split("\n");
    for (const name of ["build", "out", "tests", "extra"]) {
      expect(lines.some((line) => line.includes(`~/project/${name}`))).toBe(
        true,
      );
    }
  });

  it("offers only this command when no grant names it", () => {
    const output = mount(
      "rm -rf /a/build /home/mike/Sync/out",
      "recursive force delete",
      {
        grants: null,
      },
    ).rendered();

    expect(output).not.toContain("Allow recursive force delete of");
    expect(output.replace(/\s+/g, " ")).toContain(
      "No directory grant is offered",
    );
  });

  it("omits the always row when its grant cannot be saved", () => {
    const output = mount("rm -rf /", "recursive force delete", {
      alwaysEnabled: false,
    }).rendered();

    expect(output).not.toContain("Always allow");
  });

  it("allows with y / Y / enter, saving no grant", () => {
    for (const key of ["y", "Y", "\r"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()?.outcome).toBe("allow");
      expect(grantsSaved(result())).toEqual([]);
    }
  });

  it("grants the class for the session with a", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("a");
    expect(result()?.outcome).toBe("allow");
    expect(grantsSaved(result())).toEqual([
      { grant: DEFAULT_GRANTS[0], choice: "session" },
    ]);
  });

  it("grants the class permanently with A", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("A");
    expect(result()?.outcome).toBe("allow");
    expect(grantsSaved(result())).toEqual([
      { grant: DEFAULT_GRANTS[0], choice: "always" },
    ]);
  });

  it("does not fold A into the session grant when the always grant is unavailable", () => {
    const { component, result } = mount("rm -rf /", "recursive force delete", {
      alwaysEnabled: false,
    });
    component.handleInput("A");
    expect(result()).toBeUndefined();
  });

  it("denies with n / N / esc", () => {
    for (const key of ["n", "N", "\u001b"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()?.outcome).toBe("deny");
      expect(grantsSaved(result())).toEqual([]);
    }
  });

  it("emits stop when s or S is pressed", () => {
    for (const key of ["s", "S"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()?.outcome).toBe("stop");
    }
  });

  it("does nothing for unrelated keys", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("x");
    expect(result()).toBeUndefined();
  });
});

describe("per-directory answers", () => {
  it("lines the answers up in one column, whatever the directory", () => {
    const { component, rendered } = mount(
      "rm -rf build out",
      "recursive force delete",
      {
        grants: [
          { class: DELETE_CLASS, directory: "/home/mike/project/build" },
          {
            class: DELETE_CLASS,
            directory:
              "/home/mike/project/a/path/long/enough/to/run/past/the/row/and/keep/going",
          },
        ],
      },
    );

    component.handleInput("c");
    const rows = rendered()
      .split("\n")
      .filter((line) => line.includes("~/project/"));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Cursor, a space, the answer padded to its column, then the directory.
      expect(row.indexOf("~/project/")).toBe(9);
    }
  });

  it("answers each directory separately, granting one and refusing another", () => {
    const { component, rendered, result } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS },
    );

    component.handleInput("c");
    const lines = rendered().split("\n");
    expect(lines.some((line) => line.includes("Answer each directory"))).toBe(
      true,
    );
    expect(
      lines.some(
        (line) => line.includes("~/project/build") && line.includes("once"),
      ),
    ).toBe(true);

    // A session grant for build and a refusal for out; the cursor steps on.
    component.handleInput("a");
    component.handleInput("n");
    component.handleInput("\r");

    expect(result()?.outcome).toBe("deny");
    expect(grantsSaved(result())).toEqual([
      { grant: TWO_GRANTS[0], choice: "session" },
    ]);
  });

  it("runs the command with no grant when every directory is left at once", () => {
    const { component, result } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS },
    );
    component.handleInput("c");
    component.handleInput("\r");

    expect(result()?.outcome).toBe("allow");
    expect(grantsSaved(result())).toEqual([]);
  });

  it("says what Enter does before it is pressed", () => {
    const { component, rendered } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS },
    );
    component.handleInput("c");
    expect(rendered().replace(/\s+/g, " ")).toContain(
      "Enter runs this command. No grant is saved.",
    );

    component.handleInput("n");
    expect(rendered().replace(/\s+/g, " ")).toContain(
      "Enter blocks this command: refused ~/project/build",
    );
  });

  it("cycles an answer with Tab, starting from no grant", () => {
    const { component, rendered, result } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS },
    );
    component.handleInput("c");
    // once -> session -> always -> refuse
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\r");

    expect(rendered()).toContain("refuse");
    expect(result()?.outcome).toBe("deny");
    expect(grantsSaved(result())).toEqual([]);
  });

  it("leaves the always answer out of the cycle when it cannot be saved", () => {
    const { component, rendered, result } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS, alwaysEnabled: false },
    );
    component.handleInput("c");
    // once -> session -> refuse
    component.handleInput("\t");
    component.handleInput("\t");
    component.handleInput("\r");

    expect(rendered()).toContain("refuse");
    expect(result()?.outcome).toBe("deny");
  });

  it("goes back to the plain answers on Esc without deciding anything", () => {
    const { component, rendered, result } = mount(
      "rm -rf build out",
      "recursive force delete",
      { grants: TWO_GRANTS },
    );
    component.handleInput("c");
    component.handleInput("a");
    component.handleInput("\u001b");

    expect(result()).toBeUndefined();
    expect(rendered()).toContain("Allow execution?");

    component.handleInput("y");
    expect(result()?.outcome).toBe("allow");
  });
});
