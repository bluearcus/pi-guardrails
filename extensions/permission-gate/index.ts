import { bindProjectConfig } from "@aliou/pi-utils-settings";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { checkAction } from "../../src/core";
import { configLoader } from "../../src/shared/config";
import {
  createDelegateRoster,
  delegateDecision,
  describeReview,
  registerDecisionEntryRenderer,
} from "../../src/shared/delegation";
import {
  createFeatureRegisterPayload,
  createPromptClosedPayload,
  createPromptOpenedPayload,
  emitActionBlocked,
  emitRiskDetected,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  setupLegacyPromptEventAlias,
} from "../../src/shared/events";
import {
  type CommandGrant,
  commandClassKey,
  describeGrant,
  describeGrantOffer,
  grantCandidatesFor,
  isCommandAllowed,
  saveCommandGrants,
} from "./grants";
import {
  createPermissionGateConfirmComponent,
  decisionForAnswer,
  decisionForChoices,
  enabledPermissionGatePromptOptions,
  type GrantChoice,
  grantChoiceOptions,
  type PermissionGateDecision,
  permissionGateGrantNote,
} from "./prompt";
import {
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
} from "./rules";

/**
 * The per-directory answers as a sequence of plain selects, for a session with no
 * custom component: one question per directory, so granting one and refusing
 * another is possible outside the TUI picker too. A question left unanswered is a
 * refusal.
 */
async function chooseGrantsPerDirectory(
  grants: readonly CommandGrant[],
  alwaysEnabled: boolean,
  ctx: ExtensionContext,
): Promise<PermissionGateDecision> {
  const choices: GrantChoice[] = [];
  for (const grant of grants) {
    const options = grantChoiceOptions(alwaysEnabled);
    const selection = await ctx.ui.select(
      describeGrant(grant),
      options.map((option) => option.label),
    );
    choices.push(
      options.find((option) => option.label === selection)?.choice ?? "refuse",
    );
  }
  return decisionForChoices(grants, choices);
}

export default async function permissionGate(pi: ExtensionAPI) {
  await configLoader.load();
  bindProjectConfig(pi, configLoader);

  pi.events.on(GUARDRAILS_FEATURE_REQUEST_EVENT, () => {
    pi.events.emit(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      createFeatureRegisterPayload("permissionGate"),
    );
  });
  setupLegacyPromptEventAlias(pi, "permissionGate");
  registerDecisionEntryRenderer(pi);
  const delegates = createDelegateRoster(pi);

  pi.on("tool_call", async (event, ctx) => {
    const config = configLoader.getConfig();
    if (!config.enabled || !config.features.permissionGate) return;
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    const action = { kind: "command" as const, command, origin: "bash" };
    if (isCommandAllowed(command)) return;

    const autoDenyMatch = matchCommandPattern(
      command,
      config.permissionGate.autoDenyPatterns,
    );

    if (autoDenyMatch) {
      const reason = formatAutoDenyReason(autoDenyMatch);

      emitActionBlocked(pi, {
        feature: "permissionGate",
        action,
        reason,
        block: { source: "permission", metadata: autoDenyMatch },
        context: { toolName: "bash", input: event.input },
      });

      return {
        block: true,
        reason,
        ...(autoDenyMatch.terminate ? { terminate: true } : {}),
      };
    }

    const safety = await checkAction(action, [
      createPermissionGateRule({
        patterns: config.permissionGate.patterns,
        useBuiltinMatchers: config.permissionGate.useBuiltinMatchers,
        scratchDelete: config.permissionGate.scratchDelete,
        grants: config.permissionGate.grants,
        cwd: ctx.cwd,
        home: process.env.HOME,
      }),
    ]);
    if (safety.kind === "safe") return;

    emitRiskDetected(pi, {
      feature: "permissionGate",
      risk: safety,
      context: { toolName: "bash", input: event.input },
    });

    if (!config.permissionGate.requireConfirmation) {
      ctx.ui.notify(`Dangerous command detected: ${safety.reason}`, "warning");
      return;
    }

    const delegated = await delegateDecision(
      pi,
      delegates,
      {
        feature: "permissionGate",
        action: safety.action,
        reason: safety.reason,
        metadata: safety.metadata,
        toolName: "bash",
        input: event.input,
      },
      ctx,
      { timeoutMs: config.delegation.timeoutMs },
    );
    if (delegated?.verdict === "allow") return;
    if (delegated?.verdict === "block") {
      const reason = `Blocked by decision delegate: ${delegated.reason}`;
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: {
          source: "delegate",
          metadata: { risk: safety.metadata, delegation: delegated },
        },
        context: { toolName: "bash", input: event.input },
      });
      return { block: true, reason };
    }

    const review = describeReview(delegated);

    if (!ctx.hasUI) {
      const reason = review
        ? `Dangerous command blocked (no UI to confirm): ${safety.reason}. ${review}`
        : `Dangerous command blocked (no UI to confirm): ${safety.reason}`;
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: {
          source: "nonInteractive",
          metadata: delegated
            ? { risk: safety.metadata, delegation: delegated }
            : safety.metadata,
        },
        context: { toolName: "bash", input: event.input },
      });
      return { block: true, reason };
    }

    const classKey = commandClassKey(safety.metadata);
    const grants = grantCandidatesFor(
      classKey,
      command,
      ctx.cwd,
      config.permissionGate.scratchDelete.roots,
      config.permissionGate.grants,
    );
    const grantLabel = grants.length > 0 ? describeGrantOffer(grants) : "";
    const alwaysEnabled =
      config.permissionGate.alwaysScope === "global" ||
      configLoader.getProjectState() === "trusted";

    const promptOpened = createPromptOpenedPayload({
      feature: "permissionGate",
      action: safety.action,
      reason: safety.reason,
      prompt: {
        kind: "permission",
        metadata: safety.metadata,
      },
      context: { toolName: "bash", input: event.input },
    });
    pi.events.emit(GUARDRAILS_PROMPT_OPENED_EVENT, promptOpened);

    let decision: PermissionGateDecision;
    try {
      const customResult = await ctx.ui.custom<PermissionGateDecision>(
        createPermissionGateConfirmComponent(command, safety.reason, {
          review,
          grants,
          alwaysEnabled,
        }),
        {
          blocked: {
            kind: "permission",
            message: "Guardrails approval required",
          },
        },
      );

      if (customResult === undefined) {
        // RPC mode has no custom component support; fall back to a plain
        // select with the same options as the TUI prompt.
        const options = enabledPermissionGatePromptOptions(
          grants,
          alwaysEnabled,
        );
        if (!alwaysEnabled) {
          ctx.ui.notify(
            '"Always" grants are saved in this project\'s settings, which are ignored because this folder is not trusted. Use /trust and restart Pi to enable them, or set permissionGate.alwaysScope to global.',
            "warning",
          );
        }
        const indentedCommand = command.replace(/^/gm, "    ");
        // A select shows one line per option, so the directories an answer covers
        // go in the message: a label naming three of them is not the whole ask.
        const selection = await ctx.ui.select(
          `Dangerous command: ${safety.reason}${
            review ? `\n${review}` : ""
          }\n\n${indentedCommand}${
            grants.length > 0 ? `\n\n${permissionGateGrantNote(grants)}` : ""
          }`,
          options.map((option) => option.label),
        );
        const answer =
          options.find((option) => option.label === selection)?.result ??
          "deny";
        decision =
          answer === "choose"
            ? await chooseGrantsPerDirectory(grants, alwaysEnabled, ctx)
            : decisionForAnswer(answer, grants);
      } else {
        decision = customResult;
      }
    } finally {
      pi.events.emit(
        GUARDRAILS_PROMPT_CLOSED_EVENT,
        createPromptClosedPayload(promptOpened),
      );
    }

    // What the user chose to keep standing is saved whatever this command does.
    // A session grant for the build directory is their answer for that directory
    // even when a different directory made them block this command.
    const saved: string[] = [];
    const sessionGrants = decision.answers
      .filter((answer) => answer.choice === "session")
      .map((answer) => answer.grant);
    if (sessionGrants.length > 0) {
      const result = await saveCommandGrants(sessionGrants, "memory");
      if (result.added.length > 0) {
        saved.push(`${describeGrantOffer(result.added)} for this session`);
      }
    }
    const alwaysGrants = alwaysEnabled
      ? decision.answers
          .filter((answer) => answer.choice === "always")
          .map((answer) => answer.grant)
      : [];
    if (alwaysGrants.length > 0) {
      const result = await saveCommandGrants(
        alwaysGrants,
        config.permissionGate.alwaysScope,
      );
      if (result.added.length > 0) {
        saved.push(
          `${describeGrantOffer(result.added)} saved to ${
            result.path ?? config.permissionGate.alwaysScope
          }`,
        );
      }
    }

    if (decision.outcome === "allow") {
      ctx.ui.notify(
        saved.length > 0
          ? `Allowed ${grantLabel || "this command"} — ${saved.join(
              "; ",
            )}. Revoke them in /guardrails:settings → Permission Gate → Command grants.`
          : `Allowed ${grantLabel || "this command"}.`,
        "info",
      );
      return;
    }

    if (saved.length > 0) {
      ctx.ui.notify(
        `Blocked, but kept: ${saved.join(
          "; ",
        )}. Revoke them in /guardrails:settings → Permission Gate → Command grants.`,
        "info",
      );
    }

    if (decision.outcome === "stop") {
      const reason = "User declined and stopped dangerous command";
      emitActionBlocked(pi, {
        feature: "permissionGate",
        action: safety.action,
        reason,
        block: { source: "user-stop", metadata: safety.metadata },
        context: { toolName: "bash", input: event.input },
      });
      ctx.abort();
      return { block: true, reason };
    }

    const reason = "User denied dangerous command";
    emitActionBlocked(pi, {
      feature: "permissionGate",
      action: safety.action,
      reason,
      block: { source: "user", metadata: safety.metadata },
      context: { toolName: "bash", input: event.input },
    });
    return { block: true, reason };
  });
}
