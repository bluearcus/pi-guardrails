import { describe, expect, it, vi } from "vitest";
import { NOOP_THEME } from "../../tests/utils/theme";
import { createPermissionGateConfirmComponent } from "./prompt";

type ConfirmResult = "allow" | "allow-session" | "deny" | "stop";

function mount(
  command: string,
  description = "recursive delete",
  review?: string,
) {
  let captured: ConfirmResult | undefined;
  const done = (result: ConfirmResult) => {
    captured = result;
  };

  const tui = {
    terminal: { rows: 40, columns: 80 },
    requestRender: vi.fn(),
  };

  const component = createPermissionGateConfirmComponent(
    command,
    description,
    review,
  )(tui, NOOP_THEME, {}, done);

  return {
    component,
    result: () => captured,
  };
}

describe("createPermissionGateConfirmComponent", () => {
  it("renders without throwing", () => {
    const { component } = mount("rm -rf /");
    expect(() => component.render(80)).not.toThrow();
  });

  it("renders the reviewer's reasoning above the decision", () => {
    const { component } = mount(
      "rm -rf /",
      "recursive delete",
      "Model review (2.4s): classifier: leaned in scope, but not confidently enough (82%)",
    );
    const text = component.render(80);
    const lines = Array.isArray(text) ? text : String(text).split("\n");
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
    const rendered = mount("rm -rf /").component.render(80);
    const text = Array.isArray(rendered)
      ? rendered.join("\n")
      : String(rendered);
    expect(text).not.toContain("Model review");
  });

  it("allows with y / enter keys", () => {
    for (const key of ["y", "Y", "\r"]) {
      const { component, result } = mount("rm -rf /");
      component.handleInput(key);
      expect(result()).toBe("allow");
    }
  });

  it("grants session with a", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("a");
    expect(result()).toBe("allow-session");
  });

  it("denies with n / esc", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("n");
    expect(result()).toBe("deny");
  });

  it("emits stop when s is pressed", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("s");
    expect(result()).toBe("stop");
  });

  it("emits stop when S is pressed", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("S");
    expect(result()).toBe("stop");
  });

  it("does nothing for unrelated keys", () => {
    const { component, result } = mount("rm -rf /");
    component.handleInput("x");
    expect(result()).toBeUndefined();
  });

  it("rendered footer contains the stop hint", () => {
    const { component } = mount("rm -rf /");
    const rendered = component.render(80);
    const output = Array.isArray(rendered)
      ? rendered.join("\n")
      : String(rendered);
    expect(output).toContain("s: decline &");
    expect(output).toContain("stop");
    expect(output).toContain("n/esc: deny");
  });
});
