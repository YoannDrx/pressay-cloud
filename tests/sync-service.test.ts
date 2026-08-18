import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/client.ts', () => ({
  getSql: () => ({ query }),
}));

import { syncChangeInputSchema } from '../src/contracts/sync.ts';
import {
  appendSyncChanges,
  approveSyncDevice,
  beginSyncRecovery,
  completeSyncRecovery,
  configureSyncRecovery,
  deleteSyncRecovery,
  enrollSyncDevice,
  getSyncChanges,
  getSyncDeviceEnvelope,
  listSyncDevices,
} from '../src/services/sync.ts';

const accountId = '95e286b8-8bf9-4cf6-bf73-fc09361dc88c';
const deviceId = 'a2f99183-9727-4ec5-b0db-34388737dc81';
const objectId = '93eff87a-956a-49ec-b8d7-bf6dc28b98b0';
const envelope = Buffer.alloc(48, 7).toString('base64');
const codeHash = Buffer.alloc(32, 9).toString('base64');

describe('E2EE sync', () => {
  beforeEach(() => query.mockReset());

  it('has no schema route for history, transcript, audio or BYOK data', () => {
    for (const objectType of ['history', 'transcript', 'audio', 'byok_key']) {
      expect(
        syncChangeInputSchema.safeParse({
          objectType,
          objectId,
          revision: 1,
          envelope,
        }).success,
      ).toBe(false);
    }
  });

  it('enrolls the first device only when it carries an encrypted account key', async () => {
    query.mockResolvedValueOnce([]);
    await expect(
      enrollSyncDevice('auth-user', deviceId, Buffer.alloc(32, 1).toString('base64')),
    ).rejects.toMatchObject({ code: 'sync_enrollment_rejected' });

    query.mockResolvedValueOnce([{ approved: true }]);
    await expect(
      enrollSyncDevice(
        'auth-user',
        deviceId,
        Buffer.alloc(32, 1).toString('base64'),
        envelope,
      ),
    ).resolves.toBe('approved');
  });

  it('keeps later devices pending until an approved device wraps the account key', async () => {
    query.mockResolvedValueOnce([{ approved: false }]);
    await expect(
      enrollSyncDevice('auth-user', deviceId, Buffer.alloc(32, 2).toString('base64')),
    ).resolves.toBe('pending');

    query.mockResolvedValueOnce([{ id: deviceId }]);
    await expect(
      approveSyncDevice(
        'auth-user',
        deviceId,
        '22f2b8f5-110e-46b9-925d-dd3308be476c',
        envelope,
      ),
    ).resolves.toBeUndefined();
  });

  it('lists public sync keys only through an approved Pro device', async () => {
    query.mockResolvedValueOnce([
      {
        id: deviceId,
        display_name: 'Pressay Mac',
        public_key: Buffer.alloc(32, 4).toString('base64'),
        approved: false,
      },
    ]);
    await expect(listSyncDevices('auth-user', deviceId)).resolves.toEqual([
      {
        id: deviceId,
        displayName: 'Pressay Mac',
        publicKey: Buffer.alloc(32, 4).toString('base64'),
        status: 'pending',
      },
    ]);
  });

  it('returns an approved device only its opaque account-key envelope', async () => {
    query.mockResolvedValueOnce([{ encrypted_account_key: envelope }]);
    await expect(getSyncDeviceEnvelope('auth-user', deviceId)).resolves.toEqual({
      encryptedAccountKey: envelope,
    });

    query.mockResolvedValueOnce([]);
    await expect(getSyncDeviceEnvelope('auth-user', deviceId)).rejects.toMatchObject({
      code: 'sync_envelope_unavailable',
    });
  });

  it('configures and removes a client-generated recovery envelope', async () => {
    query.mockResolvedValueOnce([{ account_id: accountId }]).mockResolvedValueOnce([]);
    await expect(
      configureSyncRecovery('auth-user', deviceId, codeHash, envelope),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(query.mock.calls)).not.toContain(codeHash);
    expect(JSON.stringify(query.mock.calls)).not.toContain(envelope);

    query.mockReset();
    query.mockResolvedValueOnce([{ account_id: accountId }]).mockResolvedValueOnce([]);
    await expect(deleteSyncRecovery('auth-user', deviceId)).resolves.toBeUndefined();
  });

  it('returns only the opaque recovery envelope during recovery', async () => {
    query.mockResolvedValueOnce([{ encrypted_account_key: envelope }]);
    await expect(
      beginSyncRecovery(
        'auth-user',
        deviceId,
        Buffer.alloc(32, 3).toString('base64'),
        codeHash,
      ),
    ).resolves.toEqual({ encryptedAccountKey: envelope });
  });

  it('approves the recovered device and consumes the recovery code atomically', async () => {
    query.mockResolvedValueOnce([{ id: deviceId }]);
    await expect(
      completeSyncRecovery('auth-user', deviceId, codeHash, envelope),
    ).resolves.toBeUndefined();

    query.mockResolvedValueOnce([]);
    await expect(
      completeSyncRecovery('auth-user', deviceId, codeHash, envelope),
    ).rejects.toMatchObject({ code: 'sync_recovery_rejected' });
  });

  it('appends only an opaque envelope from an approved Pro device', async () => {
    let insertedPayload = '';
    query
      .mockResolvedValueOnce([{ account_id: accountId }])
      .mockImplementationOnce((_sql: string, parameters: readonly unknown[]) => {
        insertedPayload = String(parameters[2]);
        return Promise.resolve([{ accepted: 1, conflicts: 0, cursor: '42' }]);
      });
    await expect(
      appendSyncChanges('auth-user', deviceId, [
        {
          objectType: 'mode',
          objectId,
          revision: 1,
          envelope,
          envelopeVersion: 1,
          tombstone: false,
        },
      ]),
    ).resolves.toEqual({ accepted: 1, conflicts: 0, cursor: 42 });

    expect(insertedPayload).not.toContain(envelope);
    expect(insertedPayload).toContain(Buffer.alloc(48, 7).toString('hex'));
  });

  it('returns both device versions and marks a revision conflict', async () => {
    query.mockResolvedValueOnce([{ account_id: accountId }]).mockResolvedValueOnce([
      {
        sequence_id: '42',
        source_device_id: deviceId,
        object_type: 'dictionary',
        client_object_id: objectId,
        revision: '3',
        envelope,
        envelope_version: 1,
        tombstone: false,
        created_at: '2026-08-17T00:00:00.000Z',
        conflict: true,
      },
    ]);

    await expect(getSyncChanges('auth-user', deviceId, 0, 200)).resolves.toEqual({
      changes: [
        {
          sequenceId: 42,
          sourceDeviceId: deviceId,
          objectType: 'dictionary',
          objectId,
          revision: 3,
          envelope,
          envelopeVersion: 1,
          tombstone: false,
          createdAt: '2026-08-17T00:00:00.000Z',
          conflict: true,
        },
      ],
      nextCursor: 42,
      hasMore: false,
    });
  });
});
