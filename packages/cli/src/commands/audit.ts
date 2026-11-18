import { Command } from "commander";
import { runVisualCartographer } from "../utils/visualLinter.js";

export function registerAuditCommand(program: Command): void {
  program
    .command("_audit-visualizer", { hidden: true })
    .description("Runs the visualizer cartographer audit against the layout pipeline")
    .action(async () => {
      const output = await runVisualCartographer(process.cwd());
      console.log(output);
    });
}
