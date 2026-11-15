import {
  Key,
  matchesKey,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CommandGrant } from "../../../../src/core/commands";
import { GrantListEditor } from "./grant-list-editor";

/** Styling is not what these tests are about. */
const theme = {
  label: (text: string) => text,
  hint: (text: string) => text,
  value: (text: string) => text,
  cursor: "> ",
} as unknown as SettingsListTheme;

const DELETE = "builtin:recursive force delete";

function editor(grants: CommandGrant[], onSave = vi.fn()) {
  const component = new GrantListEditor({
    label: "Command grants",
    grants,
    theme,
    onSave,
    onDone: vi.fn(),
  });
  return { component, onSave };
}

function type(component: GrantListEditor, text: string) {
  for (const character of text) component.handleInput(character);
}

function pressEnter(component: GrantListEditor) {
  // pi-tui reports Enter as the key name through matchesKey; the component
  // forwards raw input, so send the byte a terminal sends.
  component.handleInput("\r");
}

function rendered(component: GrantListEditor) {
  return component.render(80).join("\n");
}

describe("GrantListEditor", () => {
  it("lists each grant as its directory and the class it covers", () => {
    const { component } = editor([
      { class: DELETE, directory: "/home/mike/project" },
      { class: "pattern:mkfs.", directory: "/dev/scratch" },
    ]);
    const output = rendered(component);

    expect(output).toContain(
      "/home/mike/project [builtin:recursive force delete]",
    );
    expect(output).toContain("/dev/scratch [pattern:mkfs.]");
  });

  it("says so when there is nothing granted", () => {
    const { component } = editor([]);

    expect(rendered(component)).toContain("(empty)");
  });

  it("asks for the directory, then the class, and saves the pair", () => {
    const { component, onSave } = editor([]);

    component.handleInput("a");
    type(component, "/home/mike/project/build");
    pressEnter(component);
    expect(rendered(component)).toContain("class: builtin:");

    type(component, DELETE);
    pressEnter(component);

    expect(onSave).toHaveBeenCalledWith([
      { class: DELETE, directory: "/home/mike/project/build" },
    ]);
    expect(rendered(component)).toContain(
      "/home/mike/project/build [builtin:recursive force delete]",
    );
  });

  it("refuses a directory the gate could not name", () => {
    const { component, onSave } = editor([]);

    component.handleInput("a");
    type(component, "build/output");
    pressEnter(component);

    expect(rendered(component)).toContain("name one directory");
    expect(onSave).not.toHaveBeenCalled();
    // The draft is still open, so the user can fix it.
    expect(rendered(component)).toContain("New grant");
  });

  it("refuses a class the prompt never showed", () => {
    const { component, onSave } = editor([]);

    component.handleInput("a");
    type(component, "/home/mike/project");
    pressEnter(component);
    type(component, "recursive force delete");
    pressEnter(component);

    expect(rendered(component)).toContain('"builtin:recursive force delete"');
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves an edit of an existing grant", () => {
    const { component, onSave } = editor([
      { class: DELETE, directory: "/home/mike/project" },
    ]);

    component.handleInput("e");
    expect(rendered(component)).toContain("Edit grant");
    type(component, "/home/mike/project/build");
    pressEnter(component);
    pressEnter(component); // an empty answer keeps the class as it was

    expect(onSave).toHaveBeenCalledWith([
      { class: DELETE, directory: "/home/mike/project/build" },
    ]);
  });

  it("deletes the selected grant", () => {
    const { component, onSave } = editor([
      { class: DELETE, directory: "/home/mike/project" },
      { class: "pattern:mkfs.", directory: "/dev/scratch" },
    ]);

    component.handleInput("d");

    expect(onSave).toHaveBeenCalledWith([
      { class: "pattern:mkfs.", directory: "/dev/scratch" },
    ]);
  });

  it("keeps one copy of a grant entered twice", () => {
    const { component, onSave } = editor([]);

    for (const _pass of [1, 2]) {
      component.handleInput("a");
      type(component, "/home/mike/project");
      pressEnter(component);
      type(component, DELETE);
      pressEnter(component);
    }

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).toEqual([
      { class: DELETE, directory: "/home/mike/project" },
    ]);
  });

  it("leaves the editor on Escape", () => {
    const onDone = vi.fn();
    const component = new GrantListEditor({
      label: "Command grants",
      grants: [{ class: DELETE, directory: "/tmp" }],
      theme,
      onSave: vi.fn(),
      onDone,
    });

    // The key name pi-tui reports for Escape, as the terminal sends it.
    component.handleInput("\u001b");

    expect(onDone).toHaveBeenCalledOnce();
  });

  it("moves the selection with j and k", () => {
    const { component } = editor([
      { class: DELETE, directory: "/a" },
      { class: DELETE, directory: "/b" },
    ]);

    component.handleInput("j");
    expect(rendered(component)).toContain("> /b");
    component.handleInput("k");
    expect(rendered(component)).toContain("> /a");
    expect(matchesKey("\r", Key.enter)).toBe(true);
  });
});
