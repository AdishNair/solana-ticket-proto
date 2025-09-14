// utils/keypair.js
import fs from 'fs';
import { Keypair } from '@solana/web3.js';

export function readKeypairFromFile(filePath) {
  try {
    const secretKeyString = fs.readFileSync(filePath, 'utf8');
    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    throw new Error(`Failed to read keypair from ${filePath}: ${error.message}`);
  }
}

export function validateKeypairFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keypair file not found: ${filePath}`);
  }
  
  try {
    readKeypairFromFile(filePath);
    return true;
  } catch (error) {
    throw new Error(`Invalid keypair file: ${error.message}`);
  }
}