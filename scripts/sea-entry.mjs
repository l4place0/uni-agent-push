process.env.NODE_SEA = "1";

const { main } = await import("../src/cli.js");
process.exitCode = await main(process.argv.slice(2));
