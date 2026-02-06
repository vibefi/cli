#!/usr/bin/env bun
import { Command } from "commander";
import { registerCouncil } from "./commands/council";
import { registerDapp } from "./commands/dapp";
import { registerPackage } from "./commands/package";
import { registerProposals } from "./commands/proposals";
import { registerStatus } from "./commands/status";
import { registerVote } from "./commands/vote";

const program = new Command();

program.name("vibefi").description("VibeFi CLI").version("0.1.0");

registerPackage(program);
registerStatus(program);
registerProposals(program);
registerDapp(program);
registerVote(program);
registerCouncil(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
