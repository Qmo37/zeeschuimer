(function attachFimiIntegration(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.ZeeschuimerFimiIntegration = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function makeFimiIntegration() {
    "use strict";

    const PROTOCOL_VERSION = "1.0";
    const WORKBENCH_EXTENSION_ID = "threads-capture-driver@fimi-collect.local";
    const THREADS_MODULE_ID = "threads.net";
    const MESSAGE_TYPE = Object.freeze({
        HELLO: "FIMI_ZEESCHUIMER_HELLO",
        BEGIN: "FIMI_ZEESCHUIMER_BEGIN",
        EXPORT: "FIMI_ZEESCHUIMER_EXPORT",
    });
    const TERMINAL_JOB_STATES = new Set(["COMPLETED", "PARTIAL", "BLOCKED", "FAILED", "CANCELED"]);
    const JOB_ID_PATTERN = /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function markerKey(jobId) {
        return `fimi-capture:${jobId}`;
    }

    function tabIdFromNavIndex(navIndex) {
        if (typeof navIndex !== "string") return null;
        const parts = navIndex.split(":");
        if (parts.length < 3 || !/^-?\d+$/.test(parts[1])) return null;
        const tabId = Number(parts[1]);
        return Number.isSafeInteger(tabId) ? tabId : null;
    }

    function itemMatchesMarker(item, marker, endedEpochMs) {
        if (!item || !marker) return false;
        const lastUpdated = Number(item.last_updated ?? item.timestamp_collected);
        return item.source_platform === marker.platform
            && tabIdFromNavIndex(item.nav_index) === marker.tabId
            && Number.isFinite(lastUpdated)
            && lastUpdated >= marker.startedEpochMs
            && lastUpdated <= endedEpochMs;
    }

    function validateMessage(message, sender, expectedSenderId = WORKBENCH_EXTENSION_ID) {
        if (sender?.id !== expectedSenderId) return "UNAUTHORIZED_SENDER";
        if (!message || typeof message !== "object") return "INVALID_MESSAGE";
        if (message.protocolVersion !== PROTOCOL_VERSION) return "PROTOCOL_MISMATCH";
        if (!Object.values(MESSAGE_TYPE).includes(message.type)) return "UNSUPPORTED_MESSAGE";
        if (message.type !== MESSAGE_TYPE.HELLO) {
            if (!JOB_ID_PATTERN.test(message.jobId || "")) return "INVALID_JOB_ID";
            if (message.platform !== THREADS_MODULE_ID) return "UNSUPPORTED_PLATFORM";
        }
        if (message.type === MESSAGE_TYPE.BEGIN && !Number.isInteger(message.tabId)) {
            return "INVALID_TAB_ID";
        }
        if (message.type === MESSAGE_TYPE.EXPORT && !TERMINAL_JOB_STATES.has(message.jobState)) {
            return "JOB_NOT_TERMINAL";
        }
        return null;
    }

    async function captureEnabled(browserObject, platform = THREADS_MODULE_ID) {
        const key = `zs-enabled-${platform}`;
        const stored = await browserObject.storage.local.get(key);
        return Boolean(stored && parseInt(stored[key], 10));
    }

    async function lastItemId(db) {
        const last = await db.items.orderBy("id").last();
        return Number.isSafeInteger(last?.id) ? last.id : 0;
    }

    async function captureItems(db, marker, endedEpochMs) {
        // last_updated is indexed in database schema v2 and changes for both
        // inserts and updates. This avoids scanning the complete accumulated
        // Zeeschuimer store and preserves updated rows with pre-job primary keys.
        const candidates = await db.items
            .where("last_updated")
            .between(marker.startedEpochMs, endedEpochMs, true, true)
            .toArray();
        return candidates
            .filter((item) => itemMatchesMarker(item, marker, endedEpochMs))
            .sort((left, right) => left.id - right.id);
    }

    function serializeNdjson(items) {
        return items.map((item) => `${JSON.stringify(item)}\n`).join("");
    }

    function bytesToHex(bytes) {
        return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function sha256Hex(text, cryptoObject = root.crypto) {
        if (!cryptoObject?.subtle) throw new Error("WebCrypto unavailable");
        const digest = await cryptoObject.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return bytesToHex(new Uint8Array(digest));
    }

    function exportFilename(jobId, endedAt) {
        const stamp = endedAt.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
        return `threads-capture/${jobId}/zeeschuimer/zeeschuimer-export-threads.net-${stamp}.ndjson`;
    }

    async function waitForDownload(browserObject, downloadId, timeoutMs = 60_000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                browserObject.downloads.onChanged.removeListener(listener);
                callback(value);
            };
            const listener = (delta) => {
                if (delta.id !== downloadId || !delta.state) return;
                if (delta.state.current === "complete") finish(resolve, { id: downloadId, state: "complete" });
                if (delta.state.current === "interrupted") {
                    finish(reject, new Error(`download interrupted: ${delta.error?.current || "unknown"}`));
                }
            };
            const timeout = setTimeout(() => finish(
                reject,
                new Error(`download ${downloadId} did not settle within ${timeoutMs}ms`),
            ), timeoutMs);
            browserObject.downloads.onChanged.addListener(listener);
            // Register before searching so a very small download cannot finish
            // in the gap between observing its state and adding the listener.
            browserObject.downloads.search({ id: downloadId }).then((current) => {
                if (current[0]?.state === "complete") finish(resolve, current[0]);
                if (current[0]?.state === "interrupted") {
                    finish(reject, new Error(`download interrupted: ${current[0].error || "unknown"}`));
                }
            }, (error) => finish(reject, error));
        });
    }

    function createBridge(options) {
        const browserObject = options.browserObject;
        const db = options.db;
        const expectedSenderId = options.expectedSenderId || WORKBENCH_EXTENSION_ID;
        const now = options.now || (() => new Date());
        const cryptoObject = options.cryptoObject || root.crypto;
        const createObjectURL = options.createObjectURL || ((blob) => root.URL.createObjectURL(blob));
        const revokeObjectURL = options.revokeObjectURL || ((url) => root.URL.revokeObjectURL(url));
        const makeBlob = options.makeBlob || ((parts, type) => new Blob(parts, { type }));
        const awaitDownload = options.waitForDownload || waitForDownload;
        if (!browserObject || !db) throw new TypeError("browserObject and db are required");

        async function storedMarker(jobId) {
            const key = markerKey(jobId);
            const stored = await browserObject.storage.local.get(key);
            return stored?.[key] || null;
        }

        async function saveMarker(marker) {
            await browserObject.storage.local.set({ [markerKey(marker.jobId)]: marker });
        }

        async function hello() {
            return {
                accepted: true,
                bridgeVersion: PROTOCOL_VERSION,
                captureEnabled: await captureEnabled(browserObject),
                extensionVersion: browserObject.runtime.getManifest().version,
                platform: THREADS_MODULE_ID,
            };
        }

        async function begin(message) {
            const existing = await storedMarker(message.jobId);
            if (existing) return { accepted: true, idempotent: true, marker: existing };
            if (!await captureEnabled(browserObject, message.platform)) {
                return { accepted: false, reason: "CAPTURE_DISABLED" };
            }
            const tab = await browserObject.tabs.get(message.tabId);
            let url;
            try {
                url = new URL(tab.url);
            } catch (_error) {
                return { accepted: false, reason: "TAB_NOT_THREADS" };
            }
            if (!/(^|\.)threads\.(?:com|net)$/i.test(url.hostname)) {
                return { accepted: false, reason: "TAB_NOT_THREADS" };
            }
            const started = now();
            const marker = {
                protocolVersion: PROTOCOL_VERSION,
                jobId: message.jobId,
                platform: message.platform,
                tabId: message.tabId,
                cursorId: await lastItemId(db),
                startedAt: started.toISOString(),
                startedEpochMs: started.getTime(),
                receipt: null,
            };
            await saveMarker(marker);
            return { accepted: true, idempotent: false, marker };
        }

        async function exportCapture(message) {
            const marker = await storedMarker(message.jobId);
            if (!marker) return { accepted: false, reason: "CAPTURE_MARKER_NOT_FOUND" };
            if (marker.receipt?.status === "SAVED") {
                return { accepted: true, idempotent: true, receipt: marker.receipt };
            }
            const ended = now();
            const items = await captureItems(db, marker, ended.getTime());
            const ndjson = serializeNdjson(items);
            const digest = await sha256Hex(ndjson, cryptoObject);
            const blob = makeBlob([ndjson], "application/x-ndjson");
            const objectUrl = createObjectURL(blob);
            let downloadId;
            try {
                downloadId = await browserObject.downloads.download({
                    url: objectUrl,
                    filename: exportFilename(message.jobId, ended.toISOString()),
                    conflictAction: "overwrite",
                    saveAs: false,
                });
                await awaitDownload(browserObject, downloadId);
            } finally {
                revokeObjectURL(objectUrl);
            }
            const receipt = {
                protocolVersion: PROTOCOL_VERSION,
                status: "SAVED",
                jobId: message.jobId,
                platform: marker.platform,
                tabId: marker.tabId,
                startedAt: marker.startedAt,
                endedAt: ended.toISOString(),
                cursorId: marker.cursorId,
                itemCount: items.length,
                bytes: new TextEncoder().encode(ndjson).byteLength,
                sha256: digest,
                downloadId,
                filename: exportFilename(message.jobId, ended.toISOString()),
            };
            await saveMarker({ ...marker, receipt });
            return { accepted: true, idempotent: false, receipt };
        }

        async function handle(message, sender) {
            const invalid = validateMessage(message, sender, expectedSenderId);
            if (invalid) return { accepted: false, reason: invalid };
            try {
                if (message.type === MESSAGE_TYPE.HELLO) return await hello();
                if (message.type === MESSAGE_TYPE.BEGIN) return await begin(message);
                return await exportCapture(message);
            } catch (error) {
                console.error("Zeeschuimer FIMI bridge failed", error);
                return { accepted: false, reason: "BRIDGE_ERROR", detail: String(error?.message || error) };
            }
        }

        return Object.freeze({ handle });
    }

    function install(options) {
        const bridge = createBridge(options);
        options.browserObject.runtime.onMessageExternal.addListener((message, sender) =>
            bridge.handle(message, sender));
        return bridge;
    }

    return Object.freeze({
        JOB_ID_PATTERN,
        MESSAGE_TYPE,
        PROTOCOL_VERSION,
        THREADS_MODULE_ID,
        WORKBENCH_EXTENSION_ID,
        captureItems,
        createBridge,
        exportFilename,
        install,
        itemMatchesMarker,
        markerKey,
        serializeNdjson,
        sha256Hex,
        tabIdFromNavIndex,
        validateMessage,
        waitForDownload,
    });
});
