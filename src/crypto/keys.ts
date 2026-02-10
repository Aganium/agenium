/**
 * Cryptographic Key Management
 * Ed25519 for agent identity, RSA for TLS certificates
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface AgentKeyPair {
  publicKey: string;   // Base64 encoded
  privateKey: string;  // Base64 encoded (sensitive!)
  fingerprint: string; // SHA256 fingerprint
}

export interface TLSKeyPair {
  publicKey: string;   // PEM format
  privateKey: string;  // PEM format
}

// ============================================================================
// Ed25519 Identity Keys
// ============================================================================

/**
 * Generate a new Ed25519 keypair for agent identity
 */
export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const privKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' });
  
  const pubKeyB64 = pubKeyDer.toString('base64');
  const privKeyB64 = privKeyDer.toString('base64');
  
  // Fingerprint is SHA256 of public key
  const fingerprint = crypto.createHash('sha256')
    .update(pubKeyDer)
    .digest('hex');
  
  return {
    publicKey: pubKeyB64,
    privateKey: privKeyB64,
    fingerprint,
  };
}

/**
 * Sign data with agent private key
 */
export function signWithAgentKey(data: Buffer, privateKeyB64: string): string {
  const privKeyDer = Buffer.from(privateKeyB64, 'base64');
  const privateKey = crypto.createPrivateKey({
    key: privKeyDer,
    format: 'der',
    type: 'pkcs8',
  });
  
  const signature = crypto.sign(null, data, privateKey);
  return signature.toString('base64');
}

/**
 * Verify signature with agent public key
 */
export function verifyAgentSignature(
  data: Buffer,
  signatureB64: string,
  publicKeyB64: string
): boolean {
  const pubKeyDer = Buffer.from(publicKeyB64, 'base64');
  const publicKey = crypto.createPublicKey({
    key: pubKeyDer,
    format: 'der',
    type: 'spki',
  });
  
  const signature = Buffer.from(signatureB64, 'base64');
  return crypto.verify(null, data, publicKey, signature);
}

// ============================================================================
// RSA Keys for TLS
// ============================================================================

/**
 * Generate RSA keypair for TLS certificates
 */
export function generateTLSKeyPair(): TLSKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  
  return { publicKey, privateKey };
}

// ============================================================================
// Key Persistence
// ============================================================================

export interface KeyStore {
  agentKeys: AgentKeyPair;
  tlsKeys: TLSKeyPair;
}

/**
 * Save keys to disk (private keys should be encrypted in production)
 */
export function saveKeys(store: KeyStore, dataDir: string): void {
  const keysDir = path.join(dataDir, 'identity');
  fs.mkdirSync(keysDir, { recursive: true });
  
  fs.writeFileSync(
    path.join(keysDir, 'agent.json'),
    JSON.stringify(store.agentKeys, null, 2),
    { mode: 0o600 }
  );
  
  fs.writeFileSync(
    path.join(keysDir, 'tls-private.pem'),
    store.tlsKeys.privateKey,
    { mode: 0o600 }
  );
  
  fs.writeFileSync(
    path.join(keysDir, 'tls-public.pem'),
    store.tlsKeys.publicKey,
    { mode: 0o644 }
  );
}

/**
 * Load keys from disk
 */
export function loadKeys(dataDir: string): KeyStore | null {
  const keysDir = path.join(dataDir, 'identity');
  
  try {
    const agentKeys = JSON.parse(
      fs.readFileSync(path.join(keysDir, 'agent.json'), 'utf-8')
    ) as AgentKeyPair;
    
    const tlsKeys: TLSKeyPair = {
      privateKey: fs.readFileSync(path.join(keysDir, 'tls-private.pem'), 'utf-8'),
      publicKey: fs.readFileSync(path.join(keysDir, 'tls-public.pem'), 'utf-8'),
    };
    
    return { agentKeys, tlsKeys };
  } catch {
    return null;
  }
}

/**
 * Initialize or load keys
 */
export function initializeKeys(dataDir: string): KeyStore {
  const existing = loadKeys(dataDir);
  if (existing) return existing;
  
  const store: KeyStore = {
    agentKeys: generateAgentKeyPair(),
    tlsKeys: generateTLSKeyPair(),
  };
  
  saveKeys(store, dataDir);
  return store;
}
