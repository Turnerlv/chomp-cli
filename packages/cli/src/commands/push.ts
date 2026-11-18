import { Command } from "commander";

export function registerPushCommand(program: Command) {
  program
    .command("push", { hidden: true })
    .description("Sync local SQLite graph DB to Supabase")
    .action(() => {
      console.log("Push command executed (stub)");
    });
}
