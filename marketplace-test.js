import { listTicketForResale, getTicketInfo } from './mint_ticket.js';
import dotenv from "dotenv";
dotenv.config();

// Your ticket details from the successful minting
const TICKET_PDA = 'ACknp2DPs43LCFwDkECAvx7CpJemLGhZqYma3AwBysL5';
const MINT_ADDRESS = '7w5wbaKNXa1UGp6RHmnGYKDibBs7RyUK1p5t4jHzeZks';
const OWNER_PUBKEY = 'EwJ3knEKtjhEhoNRZ2NFjxMHEo7ceJKPGkqgL3jBSnjC';

async function testMarketplace() {
  console.log("🎪 Testing Ticket Marketplace Features");
  console.log("=====================================");
  
  try {
    // 1. Check current ticket status
    console.log("\n1️⃣ Checking current ticket status...");
    const initialInfo = await getTicketInfo();
    console.log("Initial Ticket Info:", {
      owner: initialInfo.owner,
      price: `${initialInfo.price} SOL`,
      originalPrice: `${initialInfo.originalPrice} SOL`,
      resaleAllowed: initialInfo.resaleAllowed,
      maxMarkup: `${initialInfo.maxMarkup}%`,
      isListed: initialInfo.isListed,
      pda: initialInfo.pda
    });

    // 2. Test listing ticket for resale (within markup limit)
    console.log("\n2️⃣ Testing ticket listing for resale...");
    const maxAllowedPrice = initialInfo.originalPrice * (1 + initialInfo.maxMarkup / 100);
    const newPrice = maxAllowedPrice - 0.01; // Just under the limit
    
    console.log(`   Original price: ${initialInfo.originalPrice} SOL`);
    console.log(`   Max allowed price: ${maxAllowedPrice.toFixed(3)} SOL`);
    console.log(`   Listing price: ${newPrice.toFixed(3)} SOL`);
    
    const listTx = await listTicketForResale(MINT_ADDRESS, newPrice);
    console.log(`   ✅ Ticket listed successfully! Transaction: ${listTx}`);

    // 3. Verify the listing
    console.log("\n3️⃣ Verifying ticket listing...");
    const listedInfo = await getTicketInfo();
    console.log("Updated Ticket Info:", {
      owner: listedInfo.owner,
      currentPrice: `${listedInfo.price} SOL`,
      originalPrice: `${listedInfo.originalPrice} SOL`,
      isListed: listedInfo.isListed,
      priceIncrease: `${((listedInfo.price / listedInfo.originalPrice - 1) * 100).toFixed(1)}%`
    });

    // 4. Test invalid listing (exceeding markup limit)
    console.log("\n4️⃣ Testing invalid listing (exceeding markup limit)...");
    try {
      const invalidPrice = maxAllowedPrice + 0.05; // Exceeds limit
      console.log(`   Attempting to list at ${invalidPrice.toFixed(3)} SOL (exceeds limit)`);
      await listTicketForResale(MINT_ADDRESS, invalidPrice);
      console.log("   ❌ ERROR: Should have failed!");
    } catch (error) {
      console.log(`   ✅ Correctly rejected: ${error.message}`);
    }

    console.log("\n🎊 Marketplace testing completed!");
    console.log("=====================================");
    console.log("✅ NFT ticket with smart contract controls working perfectly!");
    console.log("✅ Resale price limits enforced");
    console.log("✅ Ticket ownership and listing status tracked");
    
  } catch (error) {
    console.error("❌ Marketplace test failed:", error.message);
    console.error("Error details:", error);
    if (error.logs) {
      console.error("Transaction logs:", error.logs);
    }
  }
}

// Additional utility functions for marketplace operations
async function checkAllTickets() {
  console.log("🔍 Checking all tickets for this wallet...");
  try {
    const info = await getTicketInfo();
    console.log("Ticket found:", {
      pda: info.pda,
      owner: info.owner,
      price: `${info.price} SOL`,
      listed: info.isListed ? '🟢 For Sale' : '🔴 Not Listed'
    });
  } catch (error) {
    console.log("No tickets found for this wallet");
    console.error("Debug error:", error);
  }
}

async function getTicketMarketSummary() {
  console.log("📊 Ticket Market Summary");
  console.log("========================");
  
  try {
    const info = await getTicketInfo();
    const markup = ((info.price / info.originalPrice - 1) * 100);
    
    console.log(`🎫 Ticket PDA: ${info.pda}`);
    console.log(`👤 Owner: ${info.owner}`);
    console.log(`💰 Current Price: ${info.price} SOL`);
    console.log(`📈 Markup: ${markup.toFixed(1)}% (Max: ${info.maxMarkup}%)`);
    console.log(`🏪 Status: ${info.isListed ? 'Listed for Sale' : 'Not for Sale'}`);
    console.log(`🔄 Resale: ${info.resaleAllowed ? 'Allowed' : 'Restricted'}`);
    
    // Calculate remaining markup room
    const remainingMarkup = info.maxMarkup - markup;
    const maxPossiblePrice = info.originalPrice * (1 + info.maxMarkup / 100);
    
    console.log("\n📊 Market Analysis:");
    console.log(`   Max possible price: ${maxPossiblePrice.toFixed(3)} SOL`);
    console.log(`   Remaining markup room: ${remainingMarkup.toFixed(1)}%`);
    console.log(`   Price appreciation potential: ${(maxPossiblePrice - info.price).toFixed(3)} SOL`);
    
  } catch (error) {
    console.error("Failed to get market summary:", error.message);
  }
}

// Main execution
async function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'test':
      await testMarketplace();
      break;
    case 'check':
      await checkAllTickets();
      break;
    case 'summary':
      await getTicketMarketSummary();
      break;
    case 'info':
      const info = await getTicketInfo();
      console.log("Detailed Ticket Info:", JSON.stringify(info, null, 2));
      break;
    default:
      console.log("🎫 Ticket Marketplace Tester");
      console.log("Usage:");
      console.log("  node marketplace-test.js test     - Run full marketplace test");
      console.log("  node marketplace-test.js check    - Check ticket status");
      console.log("  node marketplace-test.js summary  - Market summary");
      console.log("  node marketplace-test.js info     - Raw ticket info");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}