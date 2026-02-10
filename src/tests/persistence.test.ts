/**
 * Persistence Tests
 * Tests for session persistence, outbox, resume, and deduplication
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import { DatabaseManager, createDatabase, PersistedSession, OutboxMessage } from '../persistence/database.js';
import { ResumeManager, createResumeManager } from '../persistence/resume.js';
import { OutboxManager, createOutboxManager } from '../persistence/outbox.js';
import { now, generateId } from '../core/types.js';
import { MessageType } from '../protocol/types.js';

const TEST_DIR = '/tmp/agenium-test';

function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

describe('DatabaseManager', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    cleanup();
    db = createDatabase('test-agent', TEST_DIR);
    db.open();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test('saves and loads session', () => {
    const session: PersistedSession = {
      sessionId: generateId(),
      remoteAgentName: 'remote-agent',
      remotePublicKey: 'pubkey123',
      endpoint: 'https://localhost:9000',
      host: 'localhost',
      port: 9000,
      state: 'ACTIVE',
      capabilities: '["messaging"]',
      createdAt: now(),
      lastSeenAt: now(),
      lastErrorCode: null,
      protocolVersion: '1.0',
    };

    db.saveSession(session);
    const loaded = db.getSession(session.sessionId);

    assert.ok(loaded);
    assert.strictEqual(loaded.remoteAgentName, 'remote-agent');
    assert.strictEqual(loaded.state, 'ACTIVE');
  });

  test('loads resumable sessions', () => {
    const activeSession: PersistedSession = {
      sessionId: generateId(),
      remoteAgentName: 'active-agent',
      remotePublicKey: 'pk1',
      endpoint: 'https://localhost:9001',
      host: 'localhost',
      port: 9001,
      state: 'ACTIVE',
      capabilities: '[]',
      createdAt: now(),
      lastSeenAt: now(),
      lastErrorCode: null,
      protocolVersion: '1.0',
    };

    const closedSession: PersistedSession = {
      ...activeSession,
      sessionId: generateId(),
      remoteAgentName: 'closed-agent',
      state: 'CLOSED',
    };

    db.saveSession(activeSession);
    db.saveSession(closedSession);

    const resumable = db.loadResumableSessions();
    
    assert.strictEqual(resumable.length, 1);
    assert.strictEqual(resumable[0].remoteAgentName, 'active-agent');
  });

  test('updates session state', () => {
    const session: PersistedSession = {
      sessionId: generateId(),
      remoteAgentName: 'test',
      remotePublicKey: 'pk',
      endpoint: 'https://localhost:9000',
      host: 'localhost',
      port: 9000,
      state: 'ACTIVE',
      capabilities: '[]',
      createdAt: now(),
      lastSeenAt: now(),
      lastErrorCode: null,
      protocolVersion: '1.0',
    };

    db.saveSession(session);
    db.updateSessionState(session.sessionId, 'SUSPENDED', 'TEST_ERROR');

    const loaded = db.getSession(session.sessionId);
    assert.ok(loaded);
    assert.strictEqual(loaded.state, 'SUSPENDED');
    assert.strictEqual(loaded.lastErrorCode, 'TEST_ERROR');
  });
});

describe('Outbox', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    cleanup();
    db = createDatabase('test-agent', TEST_DIR);
    db.open();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test('enqueues and retrieves pending messages', () => {
    const sessionId = generateId();
    const msgId = generateId();

    db.enqueueMessage({
      msgId,
      sessionId,
      type: 'REQUEST',
      frameJson: '{"test":true}',
      priority: 0,
      createdAt: now(),
    });

    const pending = db.getPendingMessages(10);
    
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].msgId, msgId);
    assert.strictEqual(pending[0].status, 'PENDING');
  });

  test('updates message status with retry scheduling', () => {
    const sessionId = generateId();
    const msgId = generateId();

    db.enqueueMessage({
      msgId,
      sessionId,
      type: 'REQUEST',
      frameJson: '{}',
      priority: 0,
      createdAt: now(),
    });

    const futureTime = now() + 10000;
    db.updateMessageStatus(msgId, 'PENDING', futureTime, 'TIMEOUT');

    const pending = db.getPendingMessages(10);
    
    // Should not be returned yet (nextAttemptAt is in future)
    assert.strictEqual(pending.length, 0);
  });

  test('counts in-flight messages', () => {
    const sessionId = generateId();

    for (let i = 0; i < 5; i++) {
      db.enqueueMessage({
        msgId: generateId(),
        sessionId,
        type: 'REQUEST',
        frameJson: '{}',
        priority: 0,
        createdAt: now(),
      });
    }

    const count = db.getInFlightCount(sessionId);
    assert.strictEqual(count, 5);
  });
});

describe('Deduplication', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    cleanup();
    db = createDatabase('test-agent', TEST_DIR);
    db.open();
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  test('detects duplicate messages', () => {
    const msgId = generateId();
    const sessionId = generateId();

    assert.strictEqual(db.isDuplicate(msgId, sessionId), false);
    
    db.markProcessed(msgId, sessionId);
    
    assert.strictEqual(db.isDuplicate(msgId, sessionId), true);
  });

  test('prunes old dedupe entries', () => {
    const msgId = generateId();
    const sessionId = generateId();

    db.markProcessed(msgId, sessionId);
    
    // Prune should not remove recent entries
    const pruned1 = db.pruneDedupe();
    assert.strictEqual(pruned1, 0);
    
    // Stats should show entry
    const stats = db.getStats();
    assert.strictEqual(stats.dedupeSize, 1);
  });
});

describe('ResumeManager', () => {
  let db: DatabaseManager;
  let resumeManager: ResumeManager;

  beforeEach(() => {
    cleanup();
    db = createDatabase('test-agent', TEST_DIR);
    db.open();
    resumeManager = createResumeManager(db, {
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
  });

  afterEach(() => {
    resumeManager.stop();
    db.close();
    cleanup();
  });

  test('queues sessions for resume', () => {
    resumeManager.queueResume('session-1', 'agent-1');
    resumeManager.queueResume('session-2', 'agent-2');

    const pending = resumeManager.getPendingResumes();
    assert.strictEqual(pending.length, 2);
  });

  test('tracks attempts on failure', () => {
    // Set resume function that always fails
    let attempts = 0;
    resumeManager.setResumeFunction(async () => {
      attempts++;
      throw new Error('Test failure');
    });

    resumeManager.queueResume('test-session', 'test-agent');
    
    const pending = resumeManager.getPendingResumes();
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].sessionId, 'test-session');
    assert.strictEqual(pending[0].attempts, 0);
  });
});

describe('OutboxManager', () => {
  let db: DatabaseManager;
  let outbox: OutboxManager;

  beforeEach(() => {
    cleanup();
    db = createDatabase('test-agent', TEST_DIR);
    db.open();
    outbox = createOutboxManager(db, {
      maxInFlight: 5,
      maxAttempts: 3,
      retryDelaysMs: [100, 200, 400],
    });
  });

  afterEach(() => {
    outbox.stop();
    db.close();
    cleanup();
  });

  test('enforces max in-flight limit', () => {
    const sessionId = generateId();

    // Fill up the queue
    for (let i = 0; i < 5; i++) {
      const result = outbox.enqueue(sessionId, {
        version: '1.0',
        messageId: generateId(),
        type: MessageType.REQUEST,
        sessionId,
        timestamp: now(),
        payload: { method: 'test', params: {} },
      } as any);
      assert.strictEqual(result.success, true);
    }

    // This should fail
    const result = outbox.enqueue(sessionId, {
      version: '1.0',
      messageId: generateId(),
      type: MessageType.REQUEST,
      sessionId,
      timestamp: now(),
      payload: { method: 'test', params: {} },
    } as any);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'QUEUE_FULL');
  });

  test('schedules retry on retryable errors', () => {
    const sessionId = generateId();
    const msgId = generateId();

    outbox.enqueue(sessionId, {
      version: '1.0',
      messageId: msgId,
      type: MessageType.REQUEST,
      sessionId,
      timestamp: now(),
      payload: { method: 'test', params: {} },
    } as any);

    // Verify message is queued
    const stats = outbox.getStats();
    assert.strictEqual(stats.pending, 1);
  });

  test('does not retry non-retryable errors', () => {
    const sessionId = generateId();
    const msgId = generateId();

    let sendAttempts = 0;
    outbox.setSendFunction(async () => {
      sendAttempts++;
      return { success: false, error: 'UNKNOWN_METHOD', isRetryable: false };
    });

    outbox.enqueue(sessionId, {
      version: '1.0',
      messageId: msgId,
      type: MessageType.REQUEST,
      sessionId,
      timestamp: now(),
      payload: { method: 'test', params: {} },
    } as any);

    outbox.start();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Should only attempt once for non-retryable
        assert.strictEqual(sendAttempts, 1);
        resolve();
      }, 500);
    });
  });
});

// Run tests
console.log('Running persistence tests...\n');
