import { expect, it } from "vitest";
import { checkDangerousCommand } from "./dangerous";

/**
 * A recursive force delete stays visible when it is hidden inside a construct the shell still
 * executes: an expanding heredoc body, an extglob wrapping a substitution, an unterminated
 * heredoc, or an ANSI-C quoted command word.
 *
 * Structural matching only here — no text fallback patterns — so a failure means the parse and
 * walk path lost the command, not that the matchers disagree.
 */
const HIDDEN_FORMS: Record<string, string> = {
  "heredoc body substitution": "cat <<EOF\n$(rm -rf /srv/keepme)\nEOF\n",
  "dash-dash heredoc body substitution":
    "cat <<-EOF\n\t$(rm -rf /srv/keepme)\nEOF\n",
  "extglob-wrapped substitution": "echo ?($(rm -rf /srv/keepme))",
  "unterminated heredoc": "cat <<EOF\n$(rm -rf /srv/keepme)\n",
  "ANSI-C quoted command word": "$'\\x72m' -rf /srv/keepme",
};

const FLAGGED = Object.fromEntries(
  Object.keys(HIDDEN_FORMS).map((k) => [k, "recursive force delete"]),
);

function check(command: string): string | false {
  const match = checkDangerousCommand({
    command,
    patterns: [],
    useBuiltinMatchers: true,
    fallbackPatterns: [],
  });
  return match ? match.description : false;
}

it("flags a recursive force delete hidden in every form the shell executes", () => {
  const seen = Object.fromEntries(
    Object.entries(HIDDEN_FORMS).map(([label, command]) => [
      label,
      check(command),
    ]),
  );
  expect(seen).toEqual(FLAGGED);
});
