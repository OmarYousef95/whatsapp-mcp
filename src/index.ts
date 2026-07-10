#!/usr/bin/env node
// Entry point. Two modes:
//   whatsapp-mcp login   → interactive CLI pairing (QR in the terminal)
//   whatsapp-mcp         → MCP server on stdio (what Claude spawns)

import { runLogin } from "./login.js";
import { runServer } from "./server.js";

const command = process.argv[2];

if (command === "login") {
  runLogin(process.argv[3]).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else {
  runServer().catch((e) => {
    // stderr only — stdout is the MCP protocol channel.
    console.error("whatsapp-mcp fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
