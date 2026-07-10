// One-time pairing flow, run as `whatsapp-mcp login` in a real terminal.
// This is a CLI command — NOT the MCP server — so printing to stdout here
// is fine and intended.

import qrcode from "qrcode-terminal";
import { WhatsAppClient } from "./whatsapp.js";

const PAIRING_TIMEOUT_MS = 120_000;

export async function runLogin(phone?: string): Promise<void> {
  if (WhatsAppClient.isPaired()) {
    console.log("Already paired. The session lives in ~/.whatsapp-mcp/auth —");
    console.log("delete that folder (or remove the linked device in WhatsApp) to re-pair.");
    return;
  }

  const phoneDigits = phone?.replace(/\D/g, "");
  if (phone && (!phoneDigits || phoneDigits.length < 7)) {
    console.error(`"${phone}" doesn't look like a phone number. Use international format, e.g. +962791234567`);
    process.exit(1);
  }

  console.log("Connecting to WhatsApp…\n");
  const client = new WhatsAppClient();
  let pairingCodeShown = false;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pairing timed out after 2 minutes. Run login again.")),
      PAIRING_TIMEOUT_MS
    );

    client.onQr = (qr) => {
      if (phoneDigits) {
        // Pairing-code mode: terminal-rendered QRs are unreliable with some
        // fonts/line-spacing, so when the user gives their number we show an
        // 8-character code to type into the phone instead. The first `qr`
        // event is our signal that the socket is ready to accept the request.
        if (pairingCodeShown) return;
        pairingCodeShown = true;
        void client.requestPairingCode(phoneDigits).then((code) => {
          console.log(`Your pairing code:  ${code}\n`);
          console.log("On your phone: WhatsApp → Settings → Linked Devices → Link a Device");
          console.log("→ tap \"Link with phone number instead\" → enter the code above.");
        });
        return;
      }
      console.clear();
      console.log("Scan this QR with your phone:");
      console.log("WhatsApp → Settings → Linked Devices → Link a Device\n");
      qrcode.generate(qr, { small: true });
      console.log("\n(The code refreshes automatically every ~20 seconds — just keep this open.)");
      console.log("QR not scanning? Run:  whatsapp-mcp login <your number>  for a typed pairing code instead.");
    };

    client.onOpen = () => {
      clearTimeout(timer);
      // Give Baileys a moment to flush credentials to disk before we exit.
      setTimeout(() => {
        console.log(`\nPaired successfully as ${client.selfNumber()}.`);
        console.log("You can now add the MCP server to Claude — see README.");
        resolve();
      }, 1500);
    };
  });

  await client.connect();
  await done;
  process.exit(0);
}
