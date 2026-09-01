import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextEncoder } from 'node:util';

if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}
if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(__dirname, '..', 'js', 'fimi-integration.js'), 'utf8');
new Function(SOURCE)();
const Integration = globalThis.ZeeschuimerFimiIntegration;
let databaseSequence = 0;

function storageArea(initial = {}) {
    const values = { ...initial };
    return {
        values,
        async get(key) {
            if (typeof key === 'string') return key in values ? { [key]: values[key] } : {};
            return { ...key, ...values };
        },
        async set(input) { Object.assign(values, structuredClone(input)); },
    };
}

describe('FIMI external export bridge', () => {
    let db;

    beforeEach(async () => {
        const Dexie = (await import('dexie')).default;
        databaseSequence += 1;
        db = new Dexie(`zeeschuimer-fimi-test-${databaseSequence}`);
        db.version(2).stores({
            items: '++id, item_id, nav_index, source_platform, last_updated, [item_id+source_platform+last_updated]',
            uploads: '++id',
            nav: '++id, tab_id, session',
            settings: 'key',
        });
        await db.open();
    });

    afterEach(async () => {
        if (db) await db.delete();
        db = null;
    });

    test('validates sender, protocol, job identity, platform, and terminal state', () => {
        const sender = { id: Integration.WORKBENCH_EXTENSION_ID };
        expect(Integration.validateMessage({
            type: Integration.MESSAGE_TYPE.HELLO,
            protocolVersion: Integration.PROTOCOL_VERSION,
        }, sender)).toBeNull();
        expect(Integration.validateMessage({
            type: Integration.MESSAGE_TYPE.HELLO,
            protocolVersion: Integration.PROTOCOL_VERSION,
        }, { id: 'another-extension@example' })).toBe('UNAUTHORIZED_SENDER');
        expect(Integration.validateMessage({
            type: Integration.MESSAGE_TYPE.EXPORT,
            protocolVersion: Integration.PROTOCOL_VERSION,
            jobId: 'job_bad',
            jobState: 'COMPLETED',
            platform: Integration.THREADS_MODULE_ID,
        }, sender)).toBe('INVALID_JOB_ID');
        expect(Integration.validateMessage({
            type: Integration.MESSAGE_TYPE.EXPORT,
            protocolVersion: Integration.PROTOCOL_VERSION,
            jobId: 'job_11111111-1111-4111-8111-111111111111',
            jobState: 'RUNNING',
            platform: Integration.THREADS_MODULE_ID,
        }, sender)).toBe('JOB_NOT_TERMINAL');
    });

    test('matches only the marked Threads tab and bounded update window', () => {
        const marker = { platform: 'threads.net', tabId: 77, startedEpochMs: 1_000 };
        expect(Integration.itemMatchesMarker({
            source_platform: 'threads.net', nav_index: '4:77:2', last_updated: 1_500,
        }, marker, 2_000)).toBe(true);
        expect(Integration.itemMatchesMarker({
            source_platform: 'threads.net', nav_index: '4:78:2', last_updated: 1_500,
        }, marker, 2_000)).toBe(false);
        expect(Integration.itemMatchesMarker({
            source_platform: 'threads.net', nav_index: '4:77:2', last_updated: 999,
        }, marker, 2_000)).toBe(false);
    });

    test('exports new and updated rows for one job exactly once to its fixed directory', async () => {
        await db.items.add({
            item_id: 'old', nav_index: '3:12:1', source_platform: 'threads.net',
            timestamp_collected: 100, last_updated: 100, data: { id: 'old' },
        });
        const storage = storageArea({ 'zs-enabled-threads.net': '1' });
        const downloads = [];
        const blobs = [];
        const browserObject = {
            storage: { local: storage },
            runtime: { getManifest: () => ({ version: '1.14.2.2' }) },
            tabs: { get: async (id) => ({ id, url: 'https://www.threads.com/@alice' }) },
            downloads: {
                async download(options) { downloads.push(options); return 9; },
                async search() { return [{ id: 9, state: 'complete' }]; },
                onChanged: { addListener() {}, removeListener() {} },
            },
        };
        const times = [new Date(1_000), new Date(3_000)];
        const bridge = Integration.createBridge({
            browserObject,
            db,
            cryptoObject: webcrypto,
            now: () => times.shift(),
            makeBlob(parts, type) { const blob = { parts, type }; blobs.push(blob); return blob; },
            createObjectURL: () => 'blob:fimi-export',
            revokeObjectURL() {},
            waitForDownload: async () => ({ id: 9, state: 'complete' }),
        });
        const sender = { id: Integration.WORKBENCH_EXTENSION_ID };
        const jobId = 'job_11111111-1111-4111-8111-111111111111';
        const begun = await bridge.handle({
            type: Integration.MESSAGE_TYPE.BEGIN,
            protocolVersion: Integration.PROTOCOL_VERSION,
            jobId,
            platform: Integration.THREADS_MODULE_ID,
            tabId: 77,
        }, sender);
        expect(begun.accepted).toBe(true);
        expect(begun.marker.cursorId).toBe(1);

        await db.items.update(1, {
            nav_index: '4:77:1', last_updated: 2_500, data: { id: 'old-updated' },
        });
        await db.items.bulkAdd([
            {
                item_id: 'new', nav_index: '4:77:2', source_platform: 'threads.net',
                timestamp_collected: 2_000, last_updated: 2_000, data: { id: 'new' },
            },
            {
                item_id: 'other-tab', nav_index: '4:78:2', source_platform: 'threads.net',
                timestamp_collected: 2_000, last_updated: 2_000, data: { id: 'other-tab' },
            },
        ]);
        const exported = await bridge.handle({
            type: Integration.MESSAGE_TYPE.EXPORT,
            protocolVersion: Integration.PROTOCOL_VERSION,
            jobId,
            platform: Integration.THREADS_MODULE_ID,
            jobState: 'COMPLETED',
        }, sender);
        expect(exported.accepted).toBe(true);
        expect(exported.receipt.itemCount).toBe(2);
        expect(exported.receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(downloads).toHaveLength(1);
        expect(downloads[0].filename).toMatch(
            /^threads-capture\/job_11111111-1111-4111-8111-111111111111\/zeeschuimer\//,
        );
        const rows = blobs[0].parts[0].trim().split('\n').map(JSON.parse);
        expect(rows.map((row) => row.item_id)).toEqual(['old', 'new']);

        const repeated = await bridge.handle({
            type: Integration.MESSAGE_TYPE.EXPORT,
            protocolVersion: Integration.PROTOCOL_VERSION,
            jobId,
            platform: Integration.THREADS_MODULE_ID,
            jobState: 'COMPLETED',
        }, sender);
        expect(repeated.idempotent).toBe(true);
        expect(downloads).toHaveLength(1);
    });
});
