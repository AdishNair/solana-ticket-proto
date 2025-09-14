import * as anchor from "@project-serum/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";

// Your deployed program ID
const PROGRAM_ID = new PublicKey("GRb8e96kJJvofUenMx6QM7mRu9mwKCdzY6KC4PGTD3KL");

// Inline IDL JSON
const idl = {
  version: "0.1.0",
  name: "ticket_market",
  instructions: [
    {
      name: "createTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "organizer", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "price", type: "u64" },
        { name: "resaleAllowed", type: "bool" },
        { name: "maxMarkup", type: "u8" },
        { name: "mint", type: "publicKey" },
      ],
    },
    {
      name: "listTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "owner", isMut: false, isSigner: true },
      ],
      args: [{ name: "newPrice", type: "u64" }],
    },
    {
      name: "buyTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "owner", isMut: true, isSigner: true },
        { name: "buyer", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [],
    },
  ],
  accounts: [
    {
      name: "Ticket",
      type: {
        kind: "struct",
        fields: [
          { name: "owner", type: "publicKey" },
          { name: "price", type: "u64" },
          { name: "resaleAllowed", type: "bool" },
          { name: "maxMarkup", type: "u8" },
          { name: "originalPrice", type: "u64" },
          { name: "isListed", type: "bool" },
          { name: "mint", type: "publicKey" },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: "ResaleNotAllowed", msg: "Ticket resale is not allowed." },
    { code: 6001, name: "NotTicketOwner", msg: "You are not the ticket owner." },
    { code: 6002, name: "ExceedsMaxMarkup", msg: "Price exceeds allowed markup." },
    { code: 6003, name: "TicketNotListed", msg: "Ticket is not listed for sale." },
  ],
};

(async () => {
  // Playground provider
  const provider = anchor.getProvider() as any;

  // Basic provider sanity checks
  if (!provider) {
    console.error("❌ anchor.getProvider() returned undefined. Make sure your environment has a provider (e.g., ANCHOR_WALLET / local wallet).");
    process.exit(1);
  }

  // Override connection to Devnet
  provider.connection = new Connection("https://api.devnet.solana.com", "confirmed");
  anchor.setProvider(provider);

  if (!provider.wallet || !provider.wallet.publicKey) {
    console.error("❌ Provider wallet not available. Ensure the provider has a wallet with a publicKey.");
    process.exit(1);
  }

  console.log("Wallet:", provider.wallet.publicKey.toBase58());

  // Load program
  const program = new anchor.Program(idl as anchor.Idl, PROGRAM_ID, provider);

  // Determine mint: CLI arg overrides last_mint.json
  let mintString: string | undefined = undefined;

  if (process.argv.length >= 3 && process.argv[2]) {
    mintString = process.argv[2];
    console.log("Using mint from CLI argument:", mintString);
  } else {
    // Try reading last_mint.json
    try {
      const raw = fs.readFileSync("last_mint.json", "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.mint) {
        throw new Error("last_mint.json missing `mint` field");
      }
      mintString = parsed.mint;
      console.log("Using mint from last_mint.json:", mintString);
    } catch (err: any) {
      console.error("❌ Could not determine mint address. Either pass it as the first CLI argument or ensure last_mint.json exists and has { \"mint\": \"<MINT_ADDRESS>\" }");
      console.error("Error details:", err.message || err);
      process.exit(1);
    }
  }

  let mintPubkey: PublicKey;
  try {
    mintPubkey = new PublicKey(mintString as string);
  } catch (err) {
    console.error("❌ Provided mint is not a valid public key:", mintString);
    process.exit(1);
  }

  const [ticketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), provider.wallet.publicKey.toBuffer(), mintPubkey.toBuffer()],
    PROGRAM_ID
  );

  console.log("Ticket PDA:", ticketPda.toBase58());

  // Fetch account info (read-only)
  try {
    const accountInfo = await provider.connection.getAccountInfo(ticketPda);
    if (!accountInfo) {
      console.log("ℹ Ticket PDA does not exist yet.");
      process.exit(0);
    } else {
      console.log("🎫 Ticket account exists!");
      try {
        const ticketData = await program.account.ticket.fetch(ticketPda);
        console.log("Ticket data:", ticketData);
      } catch (err) {
        console.error("❌ Failed to fetch ticket data from account:", err);
      }
    }
  } catch (err) {
    console.error("❌ Error while fetching account info:", err);
    process.exit(1);
  }
})();
