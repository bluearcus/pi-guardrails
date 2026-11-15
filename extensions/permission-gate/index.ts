import { bindProjectConfig } from "@aliou/pi-utils-settings";
import {
  type ExtensionAPI,
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
  commandClassKey,
  describeCommandClass,
  isCommandAllowed,
  isCommandClassAllowed,
  saveCommandGrant,
} from "./grants";
import {
  createPermissionGateConfirmComponent,
  enabledPermissionGatePromptOptions,
  type PermissionGateConfirmResult,
} from "./prompt";
import {
  createPermissionGateRule,
  formatAutoDenyReason,
  matchCommandPattern,
} from "./rules";

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
        cwd: ctx.cwd,
      }),
    ]);
    if (safety.kind === "safe") return;

    // A class the user has already allowed decides the command without a
    // prompt and without a review: the answer was given when the grant was.
    const classKey = commandClassKey(safety.metadata);
    if (isCommandClassAllowed(classKey)) return;

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

    const classLabel = describeCommandClass(classKey);
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

    let result: PermissionGateConfirmResult;
    try {
      const customResult = await ctx.ui.custom<PermissionGateConfirmResult>(
        createPermissionGateConfirmComponent(command, safety.reason, {
          review,
          classLabel,
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
          classLabel,
          alwaysEnabled,
        );
        if (!alwaysEnabled) {
          ctx.ui.notify(
            '"Always" grants are saved in this project\'s settings, which are ignored because this folder is not trusted. Use /trust and restart Pi to enable them, or set permissionGate.alwaysScope to global.',
            "warning",
          );
        }
        const indentedCommand = command.replace(/^/gm, "    ");
        const selection = await ctx.ui.select(
          `Dangerous command: ${safety.reason}${
            review ? `\n${review}` : ""
          }\n\n${indentedCommand}`,
          options.map((option) => option.label),
        );
        result =
          options.find((option) => option.label === selection)?.result ??
          "deny";
      } else {
        result = customResult;
      }
    } finally {
      pi.events.emit(
        GUARDRAILS_PROMPT_CLOSED_EVENT,
        createPromptClosedPayload(promptOpened),
      );
    }

    if (result === "allow") return;
    if (result === "allow-session" || result === "allow-always") {
      const scope =
        result === "allow-session"
          ? "memory"
          : config.permissionGate.alwaysScope;
      const saved = await saveCommandGrant(classKey, scope);
      ctx.ui.notify(
        saved.added
          ? `Allowed "${classLabel}" commands ${
              saved.path
                ? `always — saved to ${saved.path}`
                : "for this session"
            }. Revoke it in /guardrails:settings → Permission Gate → Command classes.`
          : `Allowed "${classLabel}" commands.`,
        "info",
      );
      return;
    }

    if (result === "stop") {
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
