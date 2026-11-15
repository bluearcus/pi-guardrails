import { describe, expect, it, vi } from "vitest";
import type { CommandGrant } from "../../src/core/commands";
import { NOOP_THEME } from "../../tests/utils/theme";
import {
  createPermissionGateConfirmComponent,
  enabledPermissionGatePromptOptions,
  type PermissionGateConfirmResult,
  permissionGatePromptOptions,
} from "./prompt";

const DELETE_CLASS = "builtin:recursive force delete";
const DEFAULT_GRANT: CommandGrant = {
  class: DELETE_CLASS,
  directory: "/home/mike/project",
};

function mount(
  command: string,
  description = "recursive delete",
  options: {
    review?: string;
    grant?: CommandGrant | null;
    alwaysEnabled?: boolean;
  } = {},
) {
  let captured: PermissionGateConfirmResult | undefined;
  const done = (result: PermissionGateConfirmResult) => {
    captured = result;
  };

  const tui = {
    terminal: { rows: 40, columns: 80 },
    requestRender: vi.fn(),
  };

  const component = createPermissionGateConfirmComponent(command, description, {
    review: options.review,
    grant: "grant" in options ? (options.grant ?? undefined) : DEFAULT_GRANT,
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

describe("permission gate prompt options", () => {
  it("labels a grant with the class and the directory it covers", () => {
    const options = permissionGatePromptOptions(DEFAULT_GRANT, true);
    const labels = options.map((option) => option.label);

    expect(labels).toEqual([
      "Allow once",
      "Allow recursive force delete under ~/project this session",
      "Always allow recursive force delete under ~/project",
      "Deny",
      "Decline and stop",
    ]);
  });

  it("offers no grant when no directory covers the action", () => {
    expect(
      permissionGatePromptOptions(undefined, true).map(
        (option) => option.result,
      ),
    ).toEqual(["allow", "deny", "stop"]);
  });

  it("disables the always option when its grant cannot be saved", () => {
    const options = permissionGatePromptOptions(DEFAULT_GRANT, false);
    const always = options.find((option) => option.result === "allow-always");

    expect(always?.disabled).toBe(true);
    expect(
      enabledPermissionGatePromptOptions(DEFAULT_GRANT, false).map(
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
        "Model review (2.4s): classifier: leaned in scope, but not confidently enough (82%)",
    });
    const lines = renderedLines(component);
    const reviewIndex = lines.findIndex((line) =>
      line.includes("not confidently enough"),
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
    const output = mount("rm -rf /tmp/b1", "recursive force delete").rendered();

    expect(output).toContain("y  Allow once");
    expect(output).toContain(
      "a  Allow recursive force delete under ~/project this session",
    );
    expect(output).toContain(
      "A  Always allow recursive force delete under ~/project",
    );
    expect(output).toContain("n  Deny");
    expect(output).toContain("s  Decline and stop");
    expect(output).toContain("scroll the command");
  });

  it("says what a grant covers", () => {
    const output = mount("rm -rf /tmp/b1", "recursive force delete").rendered();

    expect(output).toContain(
      "A grant covers recursive force delete under ~/project only",
    );
    // The note wraps, so it is checked as the sentence it spells.
    expect(output.replace(/\s+/g, " ")).toContain(
      "Another directory still asks.",
    );
  });

  it("offers only this command when no grant names it", () => {
    const output = mount(
      "rm -rf /a/build /home/mike/Sync/out",
      "recursive force delete",
      {
        grant: null,
      },
    ).rendered();

    expect(output).not.toContain("Allow recursive force delete under");
    expect(output).toContain("No single directory covers this action");
  });

  it("omits the always row when its grant cannot be saved", () => {
    const output = mount("rm -rf /", "recursive force delete", {
      alwaysEnabled: false,
    }).rendered();

    expect(output).not.toContain("Always allow");
  });

  it("allows with y / Y / enter", () => {
    for (const key of ["y", "Y", "\r"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()).toBe("allow");
    }
  });

  it("grants the class for the session with a", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("a");
    expect(result()).toBe("allow-session");
  });

  it("grants the class permanently with A", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("A");
    expect(result()).toBe("allow-always");
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
      expect(result()).toBe("deny");
    }
  });

  it("emits stop when s or S is pressed", () => {
    for (const key of ["s", "S"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()).toBe("stop");
    }
  });

  it("does nothing for unrelated keys", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("x");
    expect(result()).toBeUndefined();
  });
});
