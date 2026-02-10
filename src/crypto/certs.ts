/**
 * Certificate Authority and Certificate Generation
 * Self-signed CA for local agent network
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface CertificateInfo {
  cert: string;        // PEM format
  privateKey: string;  // PEM format
  fingerprint: string; // SHA256 fingerprint
}

export interface CAInfo extends CertificateInfo {
  serial: number;      // Next serial number
}

// ============================================================================
// Self-Signed Certificate Generation (Pure Node.js)
// ============================================================================

/**
 * Create a self-signed CA certificate
 * Uses Node.js crypto for X.509 generation
 */
export function createCA(agentName: string): CAInfo {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  // Create self-signed certificate
  const cert = crypto.X509Certificate.prototype ? 
    createSelfSignedCert(agentName, publicKey, privateKey, true) :
    createFallbackCert(agentName, publicKey, privateKey);

  const certPem = cert;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const fingerprint = crypto.createHash('sha256')
    .update(certPem)
    .digest('hex');

  return {
    cert: certPem,
    privateKey: keyPem,
    fingerprint,
    serial: 1,
  };
}

/**
 * Create an agent certificate (self-signed for now, would be CA-signed in production)
 */
export function createAgentCert(
  agentName: string,
  _agentPublicKey: string, // Agent's TLS public key (PEM) - unused for now
  _ca: CAInfo // CA info - would be used for signing in production
): CertificateInfo {
  // Generate a fresh keypair for this certificate
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  // Create self-signed cert with matching keys
  const cert = createSelfSignedCert(agentName, publicKey, privateKey, false);

  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const fingerprint = crypto.createHash('sha256')
    .update(cert)
    .digest('hex');

  return {
    cert,
    privateKey: keyPem,
    fingerprint,
  };
}

/**
 * Create a self-signed certificate using Node.js crypto
 */
function createSelfSignedCert(
  commonName: string,
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  isCA: boolean
): string {
  // Node.js 20+ has X509Certificate but not generation
  // We'll create a minimal self-signed cert using raw DER encoding
  
  const now = new Date();
  const notBefore = now;
  const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year
  
  // For simplicity, generate using openssl-like structure
  // In production, use a proper library like node-forge
  return generateMinimalCert(commonName, publicKey, privateKey, isCA, notBefore, notAfter);
}

/**
 * Generate minimal self-signed certificate
 * This is a simplified implementation - production should use forge or similar
 */
function generateMinimalCert(
  cn: string,
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject,
  isCA: boolean,
  notBefore: Date,
  notAfter: Date
): string {
  // Export public key to get the raw bytes
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  
  // Build a minimal X.509 v3 certificate structure
  const serial = crypto.randomBytes(8);
  
  // Create TBS (To Be Signed) certificate
  const tbs = buildTBSCertificate(cn, serial, pubKeyDer, isCA, notBefore, notAfter);
  
  // Sign the TBS
  const signature = crypto.sign('sha256', tbs, privateKey);
  
  // Build final certificate
  const cert = buildCertificate(tbs, signature);
  
  // Convert to PEM
  const b64 = cert.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// ASN.1 DER encoding helpers
function buildTBSCertificate(
  cn: string,
  serial: Buffer,
  pubKeyDer: Buffer,
  isCA: boolean,
  notBefore: Date,
  notAfter: Date
): Buffer {
  const parts: Buffer[] = [];
  
  // Version (v3 = 2)
  parts.push(Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]));
  
  // Serial number
  parts.push(derInteger(serial));
  
  // Signature algorithm (sha256WithRSAEncryption)
  parts.push(Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00
  ]));
  
  // Issuer (CN=...)
  parts.push(derName(cn));
  
  // Validity
  parts.push(derValidity(notBefore, notAfter));
  
  // Subject (CN=...)
  parts.push(derName(cn));
  
  // Subject Public Key Info
  parts.push(pubKeyDer);
  
  // Extensions (basic constraints for CA)
  if (isCA) {
    parts.push(derCAExtensions());
  }
  
  return derSequence(Buffer.concat(parts));
}

function buildCertificate(tbs: Buffer, signature: Buffer): Buffer {
  const parts: Buffer[] = [];
  
  // TBS Certificate
  parts.push(tbs);
  
  // Signature algorithm
  parts.push(Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00
  ]));
  
  // Signature value (bit string)
  const sigBits = Buffer.concat([Buffer.from([0x00]), signature]);
  parts.push(derBitString(sigBits));
  
  return derSequence(Buffer.concat(parts));
}

function derSequence(content: Buffer): Buffer {
  return derWrap(0x30, content);
}

function derInteger(value: Buffer): Buffer {
  // Ensure positive (add leading 0 if high bit set)
  const padded = value[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value;
  return derWrap(0x02, padded);
}

function derBitString(content: Buffer): Buffer {
  return derWrap(0x03, content);
}

function derWrap(tag: number, content: Buffer): Buffer {
  const len = content.length;
  if (len < 128) {
    return Buffer.concat([Buffer.from([tag, len]), content]);
  } else if (len < 256) {
    return Buffer.concat([Buffer.from([tag, 0x81, len]), content]);
  } else {
    return Buffer.concat([Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]), content]);
  }
}

function derName(cn: string): Buffer {
  // RDNSequence with single CN
  const cnOid = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]); // OID 2.5.4.3
  const cnValue = derWrap(0x0c, Buffer.from(cn, 'utf-8')); // UTF8String
  const atv = derSequence(Buffer.concat([cnOid, cnValue]));
  const rdn = derWrap(0x31, atv); // SET
  return derSequence(rdn);
}

function derValidity(notBefore: Date, notAfter: Date): Buffer {
  const formatTime = (d: Date) => {
    const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    return derWrap(0x17, Buffer.from(s)); // UTCTime
  };
  return derSequence(Buffer.concat([formatTime(notBefore), formatTime(notAfter)]));
}

function derCAExtensions(): Buffer {
  // Basic Constraints: CA=true
  const bcOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13]); // OID 2.5.29.19
  const bcValue = derSequence(Buffer.from([0x01, 0x01, 0xff])); // BOOLEAN TRUE
  const bcExt = derSequence(Buffer.concat([
    bcOid,
    Buffer.from([0x01, 0x01, 0xff]), // critical=true
    derWrap(0x04, bcValue) // OCTET STRING
  ]));
  return derWrap(0xa3, derSequence(bcExt)); // [3] Extensions
}

// Fallback for older Node versions
function createFallbackCert(
  cn: string,
  publicKey: crypto.KeyObject,
  privateKey: crypto.KeyObject
): string {
  // Minimal placeholder - in production use proper library
  return generateMinimalCert(cn, publicKey, privateKey, true, new Date(), 
    new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
}

// ============================================================================
// CA Persistence
// ============================================================================

/**
 * Save CA to disk
 */
export function saveCA(ca: CAInfo, dataDir: string): void {
  const caDir = path.join(dataDir, 'ca');
  fs.mkdirSync(caDir, { recursive: true });
  
  fs.writeFileSync(path.join(caDir, 'ca.crt'), ca.cert, { mode: 0o644 });
  fs.writeFileSync(path.join(caDir, 'ca.key'), ca.privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(caDir, 'serial'), ca.serial.toString(), { mode: 0o644 });
}

/**
 * Load CA from disk
 */
export function loadCA(dataDir: string): CAInfo | null {
  const caDir = path.join(dataDir, 'ca');
  
  try {
    return {
      cert: fs.readFileSync(path.join(caDir, 'ca.crt'), 'utf-8'),
      privateKey: fs.readFileSync(path.join(caDir, 'ca.key'), 'utf-8'),
      fingerprint: '', // Recalculate if needed
      serial: parseInt(fs.readFileSync(path.join(caDir, 'serial'), 'utf-8'), 10),
    };
  } catch {
    return null;
  }
}

/**
 * Initialize or load CA
 */
export function initializeCA(agentName: string, dataDir: string): CAInfo {
  const existing = loadCA(dataDir);
  if (existing) return existing;
  
  const ca = createCA(`${agentName}-ca`);
  saveCA(ca, dataDir);
  return ca;
}
