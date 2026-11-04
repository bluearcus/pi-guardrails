import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Personal Pi extension: tells you when a fork's upstream repository has
 * published commits the fork has not merged.
 *
 * Install (either):
 *   pi install <this file>
 *   cp this file ~/.pi/agent/extensions/upstream-watch.ts
 *
 * Configure in ~/.pi/agent/upstream-watch.json:
 *   {
 *     "repos": ["/path/to/fork"],
 *     "script": "scripts/upstream-check.sh",   // optional, default shown
 *     "notifyOnSessionStart": true              // optional, default true
 *   }
 *
 * `/upstream` checks every configured repository on demand.
 */

interface WatchConfig {
  repos?: string[];
  script?: string;
  notifyOnSessionStart?: boolean;
}

interface RepoReport {
  repo: string;
  behind: number;
  commits: string[];
  error?: string;
}

const CONFIG_NAME = "upstream-watch.json";
const DEFAULT_SCRIPT = "scripts/upstream-check.sh";

function agentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ??
    process.env.PI_CODING_AGENT_CONFIG_DIR ??
    `${homedir()}/.pi/agent`
  );
}

function loadConfig(): WatchConfig {
  try {
    const raw = readFileSync(`${agentDir()}/${CONFIG_NAME}`, "utf8");
    return JSON.parse(raw) as WatchConfig;
  } catch {
    return {};
  }
}

async function checkRepo(
  pi: ExtensionAPI,
  repo: string,
  script: string,
): Promise<RepoReport> {
  const result = await pi.exec("sh", [script, "--porcelain"], {
    cwd: repo,
    timeout: 30_000,
  });

  if (result.code !== 0 && result.code !== 1) {
    return {
      repo,
      behind: 0,
      commits: [],
      error: (result.stderr || `exit ${result.code}`).trim(),
    };
  }

  const [count, ...commits] = result.stdout.split("\n").filter(Boolean);
  const behind = Number.parseInt(count ?? "0", 10);
  if (!Number.isFinite(behind)) {
    return { repo, behind: 0, commits: [], error: "unexpected script output" };
  }
  return { repo, behind, commits };
}

export default function upstreamWatch(pi: ExtensionAPI) {
  let checkedThisSession = false;

  async function run(ctx: Pick<ExtensionContext, "ui">, force: boolean) {
    const config = loadConfig();
    const repos = config.repos ?? [];
    if (repos.length === 0) return;
    if (checkedThisSession && !force) return;
    checkedThisSession = true;

    const script = config.script ?? DEFAULT_SCRIPT;
    for (const repo of repos) {
      const report = await checkRepo(pi, repo, script);
      if (report.error) {
        ctx.ui.notify(`upstream watch: ${repo}: ${report.error}`, "error");
        continue;
      }
      if (report.behind === 0) {
        if (force) ctx.ui.notify(`upstream watch: ${repo} is current`, "info");
        continue;
      }
      const preview = report.commits
        .slice(0, 5)
        .map((line) => line.trim())
        .join("\n");
      const more = report.behind > 5 ? `\n… ${report.behind - 5} more` : "";
      ctx.ui.notify(
        `upstream watch: ${report.behind} unmerged commit(s) in ${report.repo}\n${preview}${more}`,
        "warning",
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    if (config.notifyOnSessionStart === false) return;
    await run(ctx, false);
  });

  pi.registerCommand("upstream", {
    description: "Check configured forks for unmerged upstream commits",
    handler: async (_args, ctx) => {
      await run(ctx, true);
    },
  });
}
