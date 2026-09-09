import { spawn } from "node:child_process";
import { resolve } from "node:path";

const sellerNames = ["healthguard", "rangepilot", "gridquant", "yieldscout"] as const;
const requestedCommand = process.argv[2];

if (requestedCommand !== "build" && requestedCommand !== "test") {
  throw new Error("seller command must be build or test");
}
const command: "build" | "test" = requestedCommand;

function runSeller(sellerName: (typeof sellerNames)[number]): Promise<void> {
  const directory = resolve("agents", sellerName, "app", "agent");
  console.info(`[category-parity] ${sellerName}: npm run ${command}`);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("npm", ["run", command], {
      cwd: directory,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `${sellerName} ${command} failed with ${signal === null ? `exit ${code}` : `signal ${signal}`}`,
        ),
      );
    });
  });
}

await Promise.all(sellerNames.map(runSeller));
console.info(`[category-parity] all four seller ${command} commands passed`);
