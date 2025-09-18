import { setGlobalDispatcher, Agent } from "undici";
import fs from "fs";
import fsp from "fs/promises";
import axios from "axios";
import FormData from "form-data";
import {
  Connection,
  LAMPORTS_PER_SOL,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

// Umi + adapters
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { keypairIdentity, generateSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";

// Metaplex Token Metadata
import {
  mplTokenMetadata,
  createNft,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";

// Anchor for smart contract interaction - FIXED IMPORT
import * as anchor from "@project-serum/anchor";
const { BN } = anchor.default;  // Extract BN from anchor.default

// Utils + env
import dotenv from "dotenv";
dotenv.config();

const CLUSTER = process.env.CLUSTER;
const RPC_URL = process.env.RPC_URL;
const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY;
const KEYPAIR_PATH = process.env.KEYPAIR_PATH;
const PROGRAM_ID = new PublicKey("GRb8e96kJJvofUenMx6QM7mRu9mwKCdzY6KC4PGTD3KL");

// Enhanced undici configuration for better reliability
setGlobalDispatcher(
  new Agent({
    connect: { 
      timeout: 60000,
      keepAlive: true,
      keepAliveInitialDelay: 1000,
      keepAliveMaxTimeout: 30000
    },
    headersTimeout: 60000,
    bodyTimeout: 60000,
    maxRedirections: 3,
    retry: {
      limit: 3,
      methods: ['GET', 'POST'],
      statusCodes: [408, 413, 429, 500, 502, 503, 504],
      errorCodes: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EPIPE']
    }
  })
);

// --- Enhanced helper functions ---
function validateKeypairFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keypair file not found: ${filePath}`);
  }
}

function readKeypairFromFile(filePath) {
  try {
    const secret = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (e) {
    throw new Error(`Failed to read keypair from ${filePath}: ${e.message || e}`);
  }
}

// Enhanced connection function with retry logic
async function createRobustConnection(rpcUrl, maxRetries = 3) {
  console.log("🔗 Creating connection to:", rpcUrl);
  
  // Try multiple RPC endpoints if the main one fails
  const rpcEndpoints = [
    rpcUrl,
    "https://api.devnet.solana.com",
    "https://devnet.helius-rpc.com/?api-key=75376d66-68db-40ef-8746-5fe60eadeb8d", // Free backup
    "https://rpc-devnet.helius.xyz/?api-key=75376d66-68db-40ef-8746-5fe60eadeb8d"
  ];

  for (const endpoint of rpcEndpoints) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`  📡 Trying ${endpoint} (attempt ${attempt}/${maxRetries})`);
        
        const connection = new Connection(endpoint, {
          commitment: "confirmed",
          confirmTransactionInitialTimeout: 120000,
          wsEndpoint: undefined, // Disable WebSocket to avoid connection issues
          httpHeaders: {
            "User-Agent": "solana-ticket-minter/1.0.0"
          }
        });

        // Test the connection
        const slot = await connection.getSlot();
        console.log(`  ✅ Connected successfully! Current slot: ${slot}`);
        return connection;

      } catch (error) {
        console.log(`  ❌ Connection failed: ${error.message}`);
        
        if (attempt === maxRetries && endpoint === rpcEndpoints[rpcEndpoints.length - 1]) {
          throw new Error(`All RPC endpoints failed. Last error: ${error.message}`);
        }
        
        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  }
}

async function ensureSufficientBalance(connection, publicKey, minBalance = 0.01) {
  console.log("💰 Checking balance...");
  
  let lamports;
  let retries = 3;
  
  while (retries > 0) {
    try {
      lamports = await connection.getBalance(publicKey);
      break;
    } catch (error) {
      console.log(`  ⚠️ Balance check failed, retrying... (${retries} attempts left)`);
      retries--;
      if (retries === 0) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  const sol = lamports / LAMPORTS_PER_SOL;
  console.log(`  📊 Current balance: ${sol.toFixed(4)} SOL`);
  
  if (sol < minBalance && RPC_URL && (RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost"))) {
    console.log("🪂 Requesting localnet airdrop...");
    try {
      const sig = await connection.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      const newBal = await connection.getBalance(publicKey);
      console.log(`  ✅ Airdrop completed. New balance: ${(newBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      return;
    } catch (e) {
      console.warn("  ⚠️ Airdrop failed (continuing):", e.message || e);
    }
  }
  
  if (sol < minBalance) {
    throw new Error(`Insufficient balance: ${sol.toFixed(4)} SOL (minimum: ${minBalance} SOL)`);
  }
}

// --- IPFS Upload functions (enhanced with retry logic) ---
export async function uploadToIPFS(filePath, fileName = "ticket.png", network = "public") {
  if (!PINATA_JWT) throw new Error("PINATA_JWT not set in environment.");
  console.log("🌐 Uploading file to Pinata:", filePath);

  const formData = new FormData();
  formData.append("file", fs.createReadStream(filePath));
  formData.append("network", network);
  formData.append("name", fileName);
  formData.append(
    "keyvalues",
    JSON.stringify({ purpose: "ticket", uploadedBy: "myApp" })
  );

  let retries = 3;
  while (retries > 0) {
    try {
      const res = await axios.post("https://uploads.pinata.cloud/v3/files", formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${PINATA_JWT}`,
        },
        maxBodyLength: Infinity,
        timeout: 60000,
      });

      const cid = res?.data?.data?.cid;
      if (!cid) throw new Error(`Pinata response missing CID: ${JSON.stringify(res?.data)}`);

      const url = `https://${PINATA_GATEWAY}/ipfs/${cid}`;
      console.log("  ✅ Pinata file upload successful:", url);
      return url;
    } catch (err) {
      retries--;
      console.log(`  ⚠️ Upload failed, retrying... (${retries} attempts left)`);
      
      if (retries === 0) {
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message || err;
        throw new Error(`Pinata file upload failed: ${msg}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

export async function uploadJSONToIPFS(metadata, fileName = "metadata.json", network = "public") {
  if (!PINATA_JWT) throw new Error("PINATA_JWT not set in environment.");

  console.log("📄 Uploading JSON metadata to Pinata...");
  const formData = new FormData();
  const blob = Buffer.from(JSON.stringify(metadata));
  formData.append("file", blob, { filename: fileName, contentType: "application/json" });
  formData.append("network", network);

  let retries = 3;
  while (retries > 0) {
    try {
      const res = await axios.post("https://uploads.pinata.cloud/v3/files", formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${PINATA_JWT}`,
        },
        maxBodyLength: Infinity,
        timeout: 60000,
      });

      const cid = res?.data?.data?.cid;
      if (!cid) throw new Error(`Pinata response missing CID: ${JSON.stringify(res?.data)}`);

      const url = `https://${PINATA_GATEWAY}/ipfs/${cid}`;
      console.log("  ✅ Pinata metadata upload successful:", url);
      return url;
    } catch (err) {
      retries--;
      console.log(`  ⚠️ Metadata upload failed, retrying... (${retries} attempts left)`);
      
      if (retries === 0) {
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message || err;
        throw new Error(`Pinata metadata upload failed: ${msg}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

// --- Smart Contract Integration ---

// Updated IDL matching your Rust program exactly
const IDL = {
  version: "0.1.0",
  name: "ticket_market",
  instructions: [
    {
      name: "createTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "organizer", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "price", type: "u64" },
        { name: "resaleAllowed", type: "bool" },
        { name: "maxMarkup", type: "u8" },
        { name: "mint", type: "publicKey" }
      ]
    },
    {
      name: "listTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "owner", isMut: false, isSigner: true }
      ],
      args: [{ name: "newPrice", type: "u64" }]
    },
    {
      name: "buyTicket",
      accounts: [
        { name: "ticket", isMut: true, isSigner: false },
        { name: "owner", isMut: true, isSigner: true },
        { name: "buyer", isMut: true, isSigner: true },
        { name: "systemProgram", isMut: false, isSigner: false }
      ],
      args: []
    }
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
          { name: "mint", type: "publicKey" }
        ]
      }
    }
  ],
  errors: [
    { code: 6000, name: "ResaleNotAllowed", msg: "Ticket resale is not allowed." },
    { code: 6001, name: "NotTicketOwner", msg: "You are not the ticket owner." },
    { code: 6002, name: "ExceedsMaxMarkup", msg: "Price exceeds allowed markup." },
    { code: 6003, name: "TicketNotListed", msg: "Ticket is not listed for sale." }
  ]
};

// Fixed function to create ticket in smart contract
async function createSmartContractTicket(
  connection,
  wallet,
  mintAddress,
  price,
  resaleAllowed = true,
  maxMarkup = 20
) {
  console.log("🔗 Creating smart contract ticket...");
  
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { 
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false
    }
  );
  
  const program = new anchor.Program(IDL, PROGRAM_ID, provider);
  const mintPubkey = new PublicKey(mintAddress);
  const [ticketPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ticket"), 
      wallet.publicKey.toBuffer(),
      mintPubkey.toBuffer()
    ],
    PROGRAM_ID
  );
  
  console.log("  📍 Ticket PDA:", ticketPda.toBase58());
  console.log("  🏷️ Using mint:", mintPubkey.toBase58());
  
  try {
    const accountInfo = await connection.getAccountInfo(ticketPda);
    if (accountInfo) {
      console.log("  ⚠️ Ticket PDA already exists, fetching existing data...");
      try {
        const ticketData = await program.account.ticket.fetch(ticketPda);
        console.log("  📋 Existing ticket data:", {
          owner: ticketData.owner.toBase58(),
          price: ticketData.price.toNumber() / LAMPORTS_PER_SOL,
          mint: ticketData.mint.toBase58()
        });
        return {
          ticketPda: ticketPda.toBase58(),
          signature: null,
          alreadyExists: true
        };
      } catch (e) {
        console.log("  ⚠️ Could not fetch existing ticket data");
      }
    }
    
    // Create new ticket with mint parameter
    const tx = await program.methods
      .createTicket(
        new BN(price * LAMPORTS_PER_SOL),
        resaleAllowed,
        maxMarkup,
        mintPubkey
      )
      .accounts({
        ticket: ticketPda,
        organizer: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: false
      });
    
    console.log("  ✅ Smart contract ticket created:", tx);
    
    return {
      ticketPda: ticketPda.toBase58(),
      signature: tx,
      alreadyExists: false
    };
  } catch (error) {
    console.error("  ❌ Smart contract ticket creation failed:", error);
    if (error.logs) {
      console.error("  📋 Transaction logs:", error.logs);
    }
    throw error;
  }
}

// --- Enhanced mint function with smart contract integration ---
async function mintTicketWithSmartContract({
  imagePath,
  name,
  description,
  eventDate,
  seat,
  price, // Price in SOL
  resaleAllowed = true,
  maxMarkup = 20,
  sellerFeeBasisPoints = 0,
}) {
  console.log("🎫 Starting integrated NFT ticket minting process...");

  // Basic param checks
  if (!imagePath || !name || !description || !price) {
    throw new Error("Missing required parameters: imagePath, name, description, price");
  }

  // Keypair
  validateKeypairFile(KEYPAIR_PATH);
  const solKeypair = readKeypairFromFile(KEYPAIR_PATH);
  console.log("👤 Wallet loaded. Public key:", solKeypair.publicKey.toBase58());

  // Enhanced connection
  const connection = await createRobustConnection(RPC_URL);

  // Balance check
  await ensureSufficientBalance(connection, solKeypair.publicKey, 0.05); // Increased minimum

  // UMI setup for NFT minting
  console.log("⚙️ Setting up UMI for NFT minting...");
  const umi = createUmi(RPC_URL).use(mplTokenMetadata());
  const umiKeypair = fromWeb3JsKeypair(solKeypair);
  umi.use(keypairIdentity(umiKeypair));

  // Image check
  if (!fs.existsSync(imagePath)) throw new Error(`Image file not found: ${imagePath}`);

  // Upload image to IPFS
  const imageUri = await uploadToIPFS(imagePath);

  // Create enhanced metadata including smart contract info
  const metadata = {
    name,
    symbol: "TICKET",
    description: `${description}\nEvent: ${eventDate}\nSeat: ${seat}\nPrice: ${price} SOL`,
    image: imageUri,
    external_url: "https://your-event-website.com",
    attributes: [
      { trait_type: "Event Date", value: eventDate },
      { trait_type: "Seat", value: seat },
      { trait_type: "Ticket Type", value: "Event Ticket" },
      { trait_type: "Price", value: `${price} SOL` },
      { trait_type: "Resale Allowed", value: resaleAllowed ? "Yes" : "No" },
      { trait_type: "Max Markup", value: `${maxMarkup}%` },
    ],
    properties: {
      files: [{ uri: imageUri, type: "image/png" }],
      creators: [{ address: solKeypair.publicKey.toBase58(), share: 100 }],
      category: "ticket",
    },
  };

  // Upload metadata to IPFS
  const metadataUri = await uploadJSONToIPFS(metadata);

  // Generate mint signer
  const mint = generateSigner(umi);
  console.log("🏷️ Generated mint address:", mint.publicKey.toString());

  // Save last mint so client can pick it up automatically
  try {
    fs.writeFileSync("last_mint.json", JSON.stringify({ mint: mint.publicKey.toString() }));
    console.log("  💾 Wrote last_mint.json with mint:", mint.publicKey.toString());
  } catch (e) {
    console.warn("  ⚠️ Failed to write last_mint.json:", e.message || e);
  }

  try {
    // Step 1: Create the pNFT
    console.log("1️⃣ Creating pNFT...");
    const nftResult = await createNft(umi, {
      mint,
      name,
      symbol: "TICKET",
      uri: metadataUri,
      sellerFeeBasisPoints,
      creators: [
        { address: umi.identity.publicKey, verified: true, share: 100 },
      ],
      primarySaleHappened: false,
      isMutable: true,
      tokenStandard: TokenStandard.NonFungible,
    }).sendAndConfirm(umi, {
      send: { commitment: "confirmed" },
      confirm: { commitment: "confirmed" },
    });

    const nftSignature = Array.isArray(nftResult.signature) 
      ? Buffer.from(nftResult.signature).toString('base64')
      : nftResult.signature.toString();

    console.log("  ✅ pNFT created successfully!");

    // Step 2: Create smart contract ticket
    console.log("2️⃣ Creating smart contract ticket...");
    const smartContractResult = await createSmartContractTicket(
      connection,
      solKeypair,
      mint.publicKey.toString(),
      price,
      resaleAllowed,
      maxMarkup
    );

    console.log("\n🎉 Ticket minting completed successfully!");
    console.log("=".repeat(60));
    console.log("📋 TICKET DETAILS:");
    console.log("   NFT Mint:", mint.publicKey.toString());
    console.log("   Smart Contract PDA:", smartContractResult.ticketPda);
    console.log("   NFT Transaction:", nftSignature);
    console.log("   Smart Contract Transaction:", smartContractResult.signature);
    console.log("   Image URI:", imageUri);
    console.log("   Metadata URI:", metadataUri);
    console.log("   Price:", `${price} SOL`);
    console.log("   Resale Allowed:", resaleAllowed);
    console.log("   Max Markup:", `${maxMarkup}%`);
    console.log("=".repeat(60));

    return {
      mintAddress: mint.publicKey.toString(),
      ticketPda: smartContractResult.ticketPda,
      nftSignature,
      smartContractSignature: smartContractResult.signature,
      imageUri,
      metadataUri,
      price,
      resaleAllowed,
      maxMarkup,
    };
  } catch (err) {
    console.error("❌ Minting failed. Full error:", err);
    if (err.logs) console.error("Transaction logs:", err.logs);
    throw err;
  }
}

// --- Additional marketplace functions ---

// List a ticket for resale
const MINT_ADDRESS = '7w5wbaKNXa1UGp6RHmnGYKDibBs7RyUK1p5t4jHzeZks';
const OWNER_PUBKEY = 'EwJ3knEKtjhEhoNRZ2NFjxMHEo7ceJKPGkqgL3jBSnjC';

// Helper function to get ticket PDA
function getTicketPDA(organizerPublicKey, mintAddress, programId) {
  const [ticketPDA] = PublicKey.findProgramAddressSync([
    Buffer.from("ticket"),
    organizerPublicKey.toBuffer(),
    new PublicKey(mintAddress).toBuffer()
  ], programId);
  return ticketPDA;
}

export async function listTicketForResale(mintAddress, newPrice) {
  console.log("📝 Listing ticket for resale...");
  console.log("  🏷️ Mint:", mintAddress);
  console.log("  💰 New Price:", newPrice, "SOL");
  
  try {
    const solKeypair = readKeypairFromFile(KEYPAIR_PATH);
    const connection = await createRobustConnection(RPC_URL);
    
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(solKeypair),
      { commitment: "confirmed" }
    );
    
    const program = new anchor.Program(IDL, PROGRAM_ID, provider);
    
    // Get the correct PDA using the organizer (current wallet) and mint
    const mintPubkey = new PublicKey(mintAddress);
    const ticketPda = getTicketPDA(solKeypair.publicKey, mintAddress, PROGRAM_ID);
    
    console.log("  📍 Using ticket PDA:", ticketPda.toBase58());
    
    // First check if the ticket exists and get current data
    const ticketData = await program.account.ticket.fetch(ticketPda);
    console.log("  📋 Current ticket data:");
    console.log("    Owner:", ticketData.owner.toBase58());
    console.log("    Current price:", ticketData.price.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("    Original price:", ticketData.originalPrice.toNumber() / LAMPORTS_PER_SOL, "SOL");
    console.log("    Resale allowed:", ticketData.resaleAllowed);
    console.log("    Max markup:", ticketData.maxMarkup + "%");
    console.log("    Currently listed:", ticketData.isListed);
    
    // Verify resale is allowed
    if (!ticketData.resaleAllowed) {
      throw new Error("Resale is not allowed for this ticket");
    }
    
    // Verify markup doesn't exceed maximum
    const originalPrice = ticketData.originalPrice.toNumber() / LAMPORTS_PER_SOL;
    const maxAllowedPrice = originalPrice * (1 + ticketData.maxMarkup / 100);
    
    if (newPrice > maxAllowedPrice) {
      throw new Error(`Price ${newPrice} SOL exceeds maximum allowed price of ${maxAllowedPrice.toFixed(4)} SOL (${ticketData.maxMarkup}% markup)`);
    }
    
    const tx = await program.methods
      .listTicket(new BN(newPrice * LAMPORTS_PER_SOL))
      .accounts({
        ticket: ticketPda,
        owner: solKeypair.publicKey,
      })
      .rpc({
        commitment: "confirmed",
        preflightCommitment: "confirmed",
        skipPreflight: false
      });
    
    console.log("  ✅ Ticket listed for resale successfully!");
    console.log("  🔗 Transaction:", tx);
    
    return tx;
  } catch (error) {
    console.error("  ❌ Failed to list ticket:", error.message || error);
    if (error.logs) {
      console.error("  📋 Transaction logs:", error.logs);
    }
    throw error;
  }
}

// Get ticket information
export async function getTicketInfo(mintAddress = null) {
  console.log("🔍 Getting ticket information...");
  
  try {
    // Initialize connection and program within the function
    const solKeypair = readKeypairFromFile(KEYPAIR_PATH);
    const connection = await createRobustConnection(RPC_URL);
    
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(solKeypair),
      { commitment: "confirmed" }
    );
    
    const program = new anchor.Program(IDL, PROGRAM_ID, provider);
    
    // Use the mint from parameters or fallback to hardcoded
    const mintToUse = mintAddress || MINT_ADDRESS;
    
    // Get the correct PDA
    const organizerPubkey = new PublicKey(OWNER_PUBKEY);
    const ticketPDA = getTicketPDA(organizerPubkey, mintToUse, PROGRAM_ID);
    
    console.log("  📍 Looking up PDA:", ticketPDA.toBase58());
    
    // Fetch account
    const accountInfo = await connection.getAccountInfo(ticketPDA);
    
    if (!accountInfo) {
      throw new Error(`No ticket account found at PDA: ${ticketPDA.toBase58()}`);
    }
    
    // Parse the account data
    const ticketData = await program.account.ticket.fetch(ticketPDA);
    
    console.log("  ✅ Ticket data retrieved successfully");
    
    return {
      pda: ticketPDA.toBase58(),
      owner: ticketData.owner.toBase58(),
      price: ticketData.price.toNumber() / LAMPORTS_PER_SOL,
      originalPrice: ticketData.originalPrice.toNumber() / LAMPORTS_PER_SOL,
      resaleAllowed: ticketData.resaleAllowed,
      maxMarkup: ticketData.maxMarkup,
      isListed: ticketData.isListed,
      mint: ticketData.mint.toBase58()
    };
  } catch (error) {
    console.error("  ❌ Error in getTicketInfo:", error.message || error);
    throw error;
  }
}

// --- Main runner function ---
async function main() {
  const assetPath = "./assets/ticket.png";
  try {
    await fsp.access(assetPath);
  } catch {
    console.error("❌ Place a PNG/JPG ticket image at ./assets/ticket.png and re-run");
    process.exit(1);
  }

  console.log("🎪 Initializing integrated ticket minting...");
  console.log("Network:", CLUSTER, "| RPC URL:", RPC_URL);

  try {
    const result = await mintTicketWithSmartContract({
      imagePath: assetPath,
      name: "VIP Concert Ticket #001",
      description: "VIP access to the Indie Night Concert with backstage pass",
      eventDate: "2025-12-25T19:00:00Z",
      seat: "VIP-001",
      price: 0.1, // 0.1 SOL
      resaleAllowed: true,
      maxMarkup: 25, // 25% max markup
      sellerFeeBasisPoints: 500, // 5% royalty
    });
    
    console.log("\n🎊 Integration completed successfully!");
    
    // Test fetching ticket info using minted mint address
    console.log("\n🔍 Fetching ticket information...");
    const ticketInfo = await getTicketInfo(result.mintAddress);
    console.log("Ticket Info:", ticketInfo);
    
  } catch (error) {
    console.error("\n❌ Process failed:", error.message || error);
    if (error.logs) console.error("Logs:", error.logs);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
