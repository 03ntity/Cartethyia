import { ENV_PATH } from "./env";
import { getLocalPlatform } from "./platform";
import { hasRequiredFailure, runHealthChecks, type CheckPhase } from "./health";

const phases: readonly CheckPhase[] = ["preflight", "configuration", "runtime"];

export async function doctor(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "doctor");
  const phaseIndex = args.indexOf("--phase");
  const unknown = args.filter((arg, index) => arg !== "--json" && arg !== "--phase" && args[index - 1] !== "--phase");
  const phase = phaseIndex >= 0 ? args[phaseIndex + 1] : undefined;
  if (unknown.length > 0 || (phase !== undefined && !phases.includes(phase as CheckPhase)) || (phaseIndex >= 0 && phase === undefined)) {
    throw new Error("Usage: cartethyia doctor [--phase preflight|configuration|runtime] [--json]");
  }
  const selected = phase ? [phase as CheckPhase] : (["configuration", "runtime"] as const);
  const envPath = ENV_PATH;
  const port = Number(process.env.PORT ?? "12800");
  console.log(`Cartethyia doctor · ${getLocalPlatform()}`);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const results = await runHealthChecks({ target: "local", env, envPath, port, phases: selected });
  if (args.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else {
    for (const item of results) {
      const marker = item.status === "pass" ? "PASS" : item.status.toUpperCase();
      console.log(`${marker} [${item.phase}] ${item.summary}`);
      if (item.remediation) console.log(`  ${item.remediation}`);
    }
  }
  if (hasRequiredFailure(results)) process.exitCode = 1;
}

if (import.meta.main) {
  doctor().catch((error: unknown) => {
    console.error(`Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
