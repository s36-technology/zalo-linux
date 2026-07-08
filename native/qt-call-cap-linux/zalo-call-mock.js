#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const LinuxPeerJNI = require('./linux-peer-jni');

const KEY = 'yjAF9oqMWl6XfXYJn9mA7w==';
const IV = Buffer.from('0'.repeat(32), 'hex');
const MAX_CHUNK_SIZE = 4000;
const DEFAULT_RECV_SOCKET = '/tmp/socketzalorecv2021';
const DEFAULT_SEND_SOCKET = '/tmp/socketzalosend2021';

// This helper replaces the proprietary Linux call binary. The Electron main
// process talks to it through the same two Unix sockets used by the macOS
// helper: "send" carries renderer commands to native, "recv" carries native
// responses back to the renderer.
const recvSocketPath = process.argv[2] || DEFAULT_RECV_SOCKET;
const sendSocketPath = process.argv[3] || DEFAULT_SEND_SOCKET;
const verbose = process.env.ZALO_CALL_MOCK_VERBOSE === '1';
const logPath = process.env.ZALO_CALL_LOG || process.env.ZALO_CALL_MOCK_LOG || path.join(os.tmpdir(), 'zalo-call-linux.log');

let recvSocket = null;
let sendSocket = null;
let shuttingDown = false;
let peerGeneration = 0;
let peer = createPeer();
let latestInitData = null;
let latestLocalData = null;
let callTimeout = null;
let helperRestartTimer = null;
let pendingMakeCallTimer = null;
let pendingMakeCallMessage = null;

bootstrapPeer(peer);

function log(message, data) {
    const line = `[${new Date().toISOString()}] ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
    try {
        fs.appendFileSync(logPath, line);
    } catch (_) {}
    process.stdout.write(line);
}

function encrypt(input) {
    // Zalo's native call socket payloads are AES encrypted before chunking.
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(KEY, 'base64'), IV);
    return Buffer.concat([cipher.update(input), cipher.final()]).toString('hex');
}

function decrypt(input) {
    // Keep the same socket protocol as upstream so the bundled renderer code
    // can stay mostly unchanged.
    const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(KEY, 'base64'), IV);
    return Buffer.concat([
        decipher.update(Buffer.from(input, 'hex')),
        decipher.final()
    ]).toString();
}

function buildChunks(payload) {
    // The original helper splits large encrypted JSON payloads with "$" as the
    // frame delimiter and a small multipart header for long messages.
    const total = Math.floor((payload.length + MAX_CHUNK_SIZE - 1) / MAX_CHUNK_SIZE);
    const id = Date.now();

    if (total <= 1) {
        return [`${payload}$`];
    }

    const chunks = [];
    let rest = payload;
    for (let index = 0; index < total; index += 1) {
        chunks.push(`${rest.slice(0, MAX_CHUNK_SIZE)}#${id}#${total}#${index}#$`);
        rest = rest.slice(MAX_CHUNK_SIZE);
    }
    return chunks;
}

function createChunkParser(onMessage) {
    // Reassembles multipart frames before decrypting and dispatching them.
    const multipart = new Map();

    return (data) => {
        const parts = data.toString().split('$');

        for (const rawPart of parts) {
            if (!rawPart) continue;

            const match = rawPart.match(/^(.*)#(\d+)#(\d+)#(\d+)#$/);
            if (!match) {
                onMessage(rawPart);
                continue;
            }

            const [, payload, id, totalRaw, indexRaw] = match;
            const total = Number(totalRaw);
            const index = Number(indexRaw);
            const state = multipart.get(id) || { total, chunks: [] };
            state.chunks[index] = payload;
            multipart.set(id, state);

            if (state.chunks.filter(Boolean).length === state.total) {
                multipart.delete(id);
                onMessage(state.chunks.join(''));
            }
        }
    };
}

function sendToMain(message) {
    // "Main" here means the Electron side that owns recvSocket.
    if (!message || typeof message !== 'object') {
        log('send ignored', { reason: 'non-object-message', valueType: typeof message });
        return;
    }

    if (!recvSocket || recvSocket.destroyed) {
        return;
    }

    const encrypted = encrypt(JSON.stringify(message));
    for (const chunk of buildChunks(encrypted)) {
        recvSocket.write(chunk);
    }

    if (verbose) {
        log('send', message);
    } else {
        log('send', { type: message.type, command: message.command });
    }
}

function handleCommand(message) {
    // Convert renderer/native commands into PeerJNI-style actions. The facade
    // returns protocol messages, while this bridge handles encryption/socket IO.
    if (!message || typeof message !== 'object') {
        log('recv ignored', { reason: 'non-object-command', valueType: typeof message });
        return;
    }

    if (verbose) {
        log('recv', message);
    } else {
        log('recv', { type: message.type, command: message.command });
    }

    if (message.type === 'request' && message.command === 'killMe') {
        shutdown(0);
        return;
    }

    if (message.command === 'listDevice') {
        sendToMain({
            type: 'response',
            command: 'listDevice',
            data: peer.engine.getDeviceList()
        });
        return;
    }

    if (message.command === 'getCallInfo') {
        sendToMain({
            type: 'response',
            command: 'getCallInfo',
            data: parseJsonObject(peer.zrtc_peer_get_call_info(peer.peerHandle))
        });
        return;
    }

    if (message.command === 'isInCall') {
        sendToMain({
            type: 'response',
            command: 'isInCall',
            data: peer.zrtc_peer_is_in_call(peer.peerHandle)
        });
        return;
    }

    if (message.command === 'isInVideoCall') {
        sendToMain({
            type: 'response',
            command: 'isInVideoCall',
            data: peer.zrtc_peer_is_in_video_call(peer.peerHandle)
        });
        return;
    }

    if (message.command === 'getJsonStats406') {
        const data = message.data || {};
        sendToMain({
            type: 'response',
            command: 'getJsonStats406',
            data: peer.zrtc_peer_get_json_stats406(peer.peerHandle, data.startNetworkType || 0, data.endNetworkType || 0)
        });
        return;
    }

    if (message.command === 'getExtendData') {
        sendToMain({
            type: 'response',
            command: 'getExtendData',
            data: peer.zrtc_peer_get_extend_data(peer.peerHandle)
        });
        return;
    }

    if (message.command === 'getActiveAudioCodecs') {
        sendToMain({
            type: 'response',
            command: 'getActiveAudioCodecs',
            data: peer.zrtc_peer_get_active_audio_codecs(peer.peerHandle)
        });
        return;
    }

    if (message.command === 'getSrtpKey') {
        sendToMain({
            type: 'response',
            command: 'getSrtpKey',
            data: peer.zrtc_peer_get_srtp_key(peer.peerHandle)
        });
        return;
    }

    if (handlePeerJniCommand(message)) {
        return;
    }

    if (message.command === 'makeCall') {
        clearCallTimeout();
        if (shouldWaitForLocalData(message.data)) {
            scheduleMakeCallAfterLocalData(message);
            return;
        }
        resetWeirdPeerEndStateBeforeMakeCall(message.data);
        recreatePeerForNextCall('makeCall');
        peer.zrtc_peer_init_call(peer.peerHandle, '');
        const data = enrichCallDataWithStoredLocal(message.data || {});
        logOutgoingCallConfig(data);
        for (const response of peer.engine.makeCall(data)) {
            sendToMain(response);
        }
        scheduleCallTimeout();
        return;
    }

    if (message.command === 'endCall') {
        clearCallTimeout();
        for (const response of peer.zrtc_peer_end_call(peer.peerHandle, false)) {
            sendToMain(response);
        }
        recreatePeerForIdle('endCall');
        return;
    }

    if (message.command === 'switchCamera') {
        peer.zrtc_peer_switch_camera(peer.peerHandle);
        return;
    }

    if (message.command === 'setPartnerOffCamera') {
        const data = message.data || {};
        peer.zrtc_peer_set_partner_off_camera(peer.peerHandle, data.status, data.reason);
        return;
    }

    if (message.command === 'muteAudio' || message.command === 'muteCall') {
        for (const response of peer.zrtc_peer_mute_audio(peer.peerHandle, getBooleanValue(message.data, 'muted', 'mute', 'status'))) {
            sendToMain(response);
        }
        return;
    }

    if (message.command === 'unmuteAudio') {
        for (const response of peer.zrtc_peer_mute_audio(peer.peerHandle, false)) {
            sendToMain(response);
        }
        return;
    }

    if (message.command === 'holdAudio' || message.command === 'holdCall') {
        for (const response of peer.zrtc_peer_hold_audio(peer.peerHandle, getBooleanValue(message.data, 'held', 'hold', 'status'), true)) {
            sendToMain(response);
        }
        return;
    }

    if (message.command === 'resumeAudio' || message.command === 'unholdAudio' || message.command === 'unholdCall') {
        for (const response of peer.zrtc_peer_hold_audio(peer.peerHandle, false, true)) {
            sendToMain(response);
        }
        return;
    }

    if (message.command === 'setSpeakerOn') {
        sendToMain({
            type: 'response',
            command: 'setSpeakerOn',
            data: peer.zrtc_peer_set_speaker_on(peer.peerHandle, getBooleanValue(message.data, 'enabled', 'speakerOn', 'status'))
        });
        return;
    }

    if (message.command === 'changeVideoDevice') {
        peer.engine.changeVideoDevice(message.data && (message.data.id || message.data.deviceId));
        return;
    }

    if (message.command === 'startDesktopCapture') {
        peer.engine.startDesktopCapture();
        return;
    }

    if (message.command === 'stopDesktopCapture') {
        peer.engine.stopDesktopCapture();
        return;
    }

    if (message.command === 'setAudioVolume') {
        const data = message.data || {};
        sendToMain({
            type: 'response',
            command: 'setAudioVolume',
            data: peer.engine.setAudioVolume(data.input, data.output)
        });
        return;
    }

    if (message.command === 'setAgc') {
        const enabled = getBooleanValue(message.data, 'auto', 'enabled', 'status');
        peer.zrtc_peer_set_agc_mic_level(peer.peerHandle, enabled ? 1 : 0);
        peer.engine.setAgc(enabled);
        return;
    }

    if (message.command === 'changeMinMaxMobileBitrate') {
        const data = message.data || {};
        peer.engine.changeMinMaxMobileBitrate(data.minBitrate, data.maxBitrate);
        return;
    }

    if (message.command === 'setConfiguredTransport') {
        const data = message.data || {};
        peer.zrtc_peer_call_change_ZRTP(
            peer.peerHandle,
            data.session || '',
            data.rtpList || data.rtpAddress || data.rtp || '',
            data.rtcpList || data.rtcpAddress || data.rtcp || ''
        );
        return;
    }

    if (message.command === 'clearConfiguredTransport') {
        peer.engine.clearConfiguredTransport();
        return;
    }

    if (message.command === 'setMediaConfig') {
        const data = message.data || {};
        const mediaCodecInfo = createMediaCodecInfoFromData(data);
        try {
            peer.zrtc_peer_update_caller_info(peer.peerHandle, mediaCodecInfo, '');
        } finally {
            peer.zrtc_media_codec_info_delete(mediaCodecInfo);
        }
        return;
    }

    if (message.command === 'updateCallerInfo') {
        const data = message.data || {};
        const mediaCodecInfo = peer.zrtc_media_codec_info_create();
        peer.zrtc_media_codec_info_set_audio_partner_codec(mediaCodecInfo, data.audioConfig || data.codec || '');
        peer.zrtc_media_codec_info_set_extend_data(mediaCodecInfo, data.extendData || '');
        peer.zrtc_peer_update_caller_info(peer.peerHandle, mediaCodecInfo, '');
        peer.zrtc_media_codec_info_delete(mediaCodecInfo);
        return;
    }

    if (message.type === 'recvSignal') {
        clearCallTimeout();
        for (const response of peer.engine.handleRecvSignal(message.command, message.data)) {
            sendToMain(response);
        }
        scheduleCallTimeout();
        return;
    }

    if (message.command === 'init' || message.command === 'updateLocal') {
        if (message.command === 'init') {
            latestInitData = Object.assign({}, message.data || {});
        } else {
            latestLocalData = Object.assign({}, message.data || {});
        }
        peer.latestCallConfig = Object.assign({}, peer.latestCallConfig, message.data || {});
        if (message.command === 'init') {
            peer.zrtc_peer_init_call(peer.peerHandle, '');
        }
        sendToMain(peer.engine.init(message.data));
        if (message.command === 'updateLocal') {
            flushPendingMakeCall('updateLocal');
        }
        return;
    }

    if (message.type === 'control') {
        clearCallTimeout();
        if (message.data && message.data.act_type === 'voip' && message.data.act === 'request') {
            recreatePeerForNextCall('incoming-request');
            peer.zrtc_peer_init_call(peer.peerHandle, '');
            for (const response of handleIncomingRequestWithPeerJni(message.data)) {
                sendToMain(response);
            }
            scheduleCallTimeout();
            return;
        }
        const responses = peer.engine.handleControl(message.data);
        for (const response of responses) {
            sendToMain(response);
        }
        if (shouldRecreateIdleFromResponses(responses)) {
            recreatePeerForIdle(`control-${message.data && message.data.act || 'unknown'}`);
        }
        scheduleCallTimeout();
    }
}

function createPeer() {
    const generation = peerGeneration + 1;
    peerGeneration = generation;
    return new LinuxPeerJNI({
        log,
        send: (message) => sendToMainFromPeerGeneration(generation, message),
        onNativeEvent: (message) => sendToMainFromPeerGeneration(generation, message)
    });
}

function sendToMainFromPeerGeneration(generation, message) {
    if (generation !== peerGeneration) {
        log('stale peer send ignored', {
            generation,
            currentGeneration: peerGeneration,
            type: message && message.type,
            command: message && message.command
        });
        return;
    }

    sendToMain(message);
}

function bootstrapPeer(targetPeer) {
    targetPeer.zrtc_peer_create();
    targetPeer.zrtc_peer_set_app_context(targetPeer.peerHandle, {
        platform: process.platform,
        arch: process.arch,
        pid: process.pid
    });
    targetPeer.zrtc_peer_set_egl_context(targetPeer.peerHandle, null);
    targetPeer.zrtc_peer_set_log_level(targetPeer.peerHandle, 0);
    targetPeer.zrtc_peer_register_callback(targetPeer.peerHandle, {
        send: sendToMain
    });
}

function recreatePeerForNextCall(reason) {
    const oldPeer = peer;
    try {
        oldPeer.engine.send = null;
        oldPeer.engine.onNativeEvent = null;
        oldPeer.zrtc_peer_delete(oldPeer.peerHandle);
    } catch (error) {
        log('peer recreate old shutdown failed', {
            reason,
            message: error && error.message
        });
    }

    peer = createPeer();
    bootstrapPeer(peer);
    if (latestInitData) {
        peer.latestCallConfig = Object.assign({}, peer.latestCallConfig, latestInitData);
        peer.engine.init(latestInitData);
    }
    if (latestLocalData) {
        peer.latestCallConfig = Object.assign({}, peer.latestCallConfig, latestLocalData);
        peer.engine.init(latestLocalData);
    }
    log('peer recreated for next call', {
        reason,
        peerHandle: peer.peerHandle,
        hadInit: !!latestInitData,
        hadLocal: !!latestLocalData
    });
}

function recreatePeerForIdle(reason) {
    const oldPeer = peer;
    try {
        oldPeer.engine.send = null;
        oldPeer.engine.onNativeEvent = null;
        oldPeer.zrtc_peer_delete(oldPeer.peerHandle);
    } catch (error) {
        log('peer recreate idle old shutdown failed', {
            reason,
            message: error && error.message
        });
    }

    peer = createPeer();
    bootstrapPeer(peer);
    if (latestInitData) {
        peer.latestCallConfig = Object.assign({}, peer.latestCallConfig, latestInitData);
        peer.engine.init(latestInitData);
    }
    if (latestLocalData) {
        peer.latestCallConfig = Object.assign({}, peer.latestCallConfig, latestLocalData);
        peer.engine.init(latestLocalData);
    }
    log('peer recreated for idle', {
        reason,
        peerHandle: peer.peerHandle,
        hadInit: !!latestInitData,
        hadLocal: !!latestLocalData
    });
    requestHelperProcessRestart(reason);
}

function requestHelperProcessRestart(reason) {
    if (helperRestartTimer) {
        return;
    }

    helperRestartTimer = setTimeout(() => {
        helperRestartTimer = null;
        if (shuttingDown) {
            return;
        }

        log('request helper process restart', { reason });
        sendToMain({
            type: 'request',
            command: 'killMe',
            data: { reason }
        });
        setTimeout(() => shutdown(0), 30);
    }, Number(process.env.ZALO_CALL_HELPER_RESTART_DELAY_MS || 120));

    if (helperRestartTimer.unref) {
        helperRestartTimer.unref();
    }
}

function resetWeirdPeerEndStateBeforeMakeCall(data) {
    const endCallState = Number(peer.zrtc_peer_get_end_call_state(peer.peerHandle) || 0);
    if (endCallState === 0 || endCallState === 19) {
        return;
    }

    log('makeCall weird end state reset', {
        endCallState,
        nextCallId: data && (data.callId || data.id || data.providedCallId) || 0
    });

    try {
        peer.zrtc_peer_set_call_state(peer.peerHandle, 0);
    } catch (error) {
        log('makeCall weird end state set idle failed', {
            endCallState,
            message: error && error.message
        });
    }
}

function getLocalContext(data) {
    const initLocal = latestInitData && latestInitData.local || {};
    const latestLocal = latestLocalData && latestLocalData.local || latestLocalData || {};
    const commandLocal = data && data.local || {};
    return Object.assign({}, initLocal, latestLocal, commandLocal);
}

function getCommandLocalId(data) {
    const local = data && data.local || {};
    return Number(data && (data.userId || data.fromId || data.uidTo || data.reveiverId) || local.id || 0);
}

function shouldWaitForLocalData(data) {
    if (data && data.__localWaited) {
        return false;
    }

    if (getCommandLocalId(data)) {
        return false;
    }

    const storedLocal = getLocalContext(data);
    if (storedLocal && Number(storedLocal.id || storedLocal.uid || storedLocal.userId || 0)) {
        return false;
    }

    return !latestLocalData;
}

function scheduleMakeCallAfterLocalData(message) {
    if (pendingMakeCallTimer) {
        clearTimeout(pendingMakeCallTimer);
    }

    pendingMakeCallMessage = message;
    const waitMs = Number(process.env.ZALO_CALL_WAIT_LOCAL_MS || 650);
    log('makeCall waiting for local context', {
        waitMs,
        hadInit: !!latestInitData,
        hadLocal: !!latestLocalData,
        dataKeys: message && message.data ? Object.keys(message.data) : []
    });

    pendingMakeCallTimer = setTimeout(() => {
        pendingMakeCallTimer = null;
        const retry = Object.assign({}, pendingMakeCallMessage || message, {
            data: Object.assign({}, (pendingMakeCallMessage || message).data || {}, { __localWaited: true })
        });
        pendingMakeCallMessage = null;
        log('makeCall local wait expired', {
            hadInit: !!latestInitData,
            hadLocal: !!latestLocalData
        });
        handleCommand(retry);
    }, waitMs);

    if (pendingMakeCallTimer.unref) {
        pendingMakeCallTimer.unref();
    }
}

function flushPendingMakeCall(reason) {
    if (!pendingMakeCallTimer && !pendingMakeCallMessage) {
        return;
    }

    if (pendingMakeCallTimer) {
        clearTimeout(pendingMakeCallTimer);
    }
    pendingMakeCallTimer = null;
    const retry = Object.assign({}, pendingMakeCallMessage, {
        data: Object.assign({}, pendingMakeCallMessage && pendingMakeCallMessage.data || {}, { __localWaited: true })
    });
    pendingMakeCallMessage = null;
    log('makeCall local context arrived', { reason });
    setImmediate(() => handleCommand(retry));
}

function enrichCallDataWithStoredLocal(data) {
    const base = Object.assign({}, latestInitData || {}, latestLocalData || {});
    const local = getLocalContext(data);
    const enriched = Object.assign({}, base, data || {}, { local });
    const localId = Number(local && (local.id || local.uid || local.userId) || 0);

    if (!Number(enriched.userId || 0) && localId) {
        enriched.userId = localId;
    }
    if (!Number(enriched.fromId || 0) && localId) {
        enriched.fromId = localId;
    }

    if (data && Array.isArray(data.partner)) {
        enriched.partner = data.partner.slice();
    }
    if (data && Object.prototype.hasOwnProperty.call(data, 'type')) {
        enriched.type = data.type;
    }

    return enriched;
}

function getSessionValue(data) {
    const params = parseJsonObject(data && data.params);
    return data && (data.session || data.sessId || data.sessionId) || params.sessId || '';
}

function logOutgoingCallConfig(data) {
    const partner = data && Array.isArray(data.partner) ? data.partner[0] : null;
    log('makeCall android config gate', {
        hadInit: !!latestInitData,
        hadLocal: !!latestLocalData,
        userId: data && (data.userId || data.fromId || data.uidTo || data.reveiverId) || data && data.local && data.local.id || 0,
        partnerId: data && (data.calleeId || data.partnerId || data.uidFrom || data.uidTo || data.reveiverId) || partner && partner.id || 0,
        callId: data && (data.callId || data.id) || 0,
        hasSession: !!getSessionValue(data),
        hasListServer: !!(data && data.listServer),
        dataKeys: data ? Object.keys(data) : []
    });
}

function shouldRecreateIdleFromResponses(responses) {
    return Array.isArray(responses) && responses.some((response) => (
        response &&
        response.type === 'update' &&
        response.command === 'callState' &&
        response.data &&
        response.data.state === 'free'
    ));
}

function handlePeerJniCommand(message) {
    const data = message.data || {};
    const command = message.command;

    switch (command) {
        case 'getCurrentRtp':
            sendPeerJniResponse(command, peer.zrtc_peer_get_current_rtp(peer.peerHandle));
            return true;
        case 'getEndCallState':
            sendPeerJniResponse(command, peer.zrtc_peer_get_end_call_state(peer.peerHandle));
            return true;
        case 'getExtendDataRingring':
            sendPeerJniResponse(command, peer.zrtc_peer_get_extend_data_ringring(peer.peerHandle));
            return true;
        case 'getNativeTraceData':
            sendPeerJniResponse(command, parseJsonObject(peer.zrtc_peer_get_native_trace_data(peer.peerHandle)));
            return true;
        case 'getLoadingTimeBadConnection':
            sendPeerJniResponse(command, peer.zrtc_peer_get_loading_time_bad_connection(peer.peerHandle));
            return true;
        case 'getAutoHangupProcessTime':
            sendPeerJniResponse(command, peer.zrtc_peer_get_auto_hangup_process_time(peer.peerHandle));
            return true;
        case 'getAecInternal':
            sendPeerJniResponse(command, peer.zrtc_peer_get_aec_internal(peer.peerHandle));
            return true;
        case 'getAecExternal':
            sendPeerJniResponse(command, peer.zrtc_peer_get_aec_external(peer.peerHandle));
            return true;
        case 'getAgcMicLevel':
            sendPeerJniResponse(command, peer.zrtc_peer_get_agc_mic_level(peer.peerHandle));
            return true;
        case 'getAgcPlayLevel':
            sendPeerJniResponse(command, peer.zrtc_peer_get_agc_play_level(peer.peerHandle));
            return true;
        case 'getNsLevel':
            sendPeerJniResponse(command, peer.zrtc_peer_get_ns_level(peer.peerHandle));
            return true;
        case 'getSpectrumFiles': {
            const output = [];
            const ok = peer.zrtc_peer_get_spectrum_files(peer.peerHandle, output);
            sendPeerJniResponse(command, { ok, files: output });
            return true;
        }
        case 'hardwareEncoderSupport':
            sendPeerJniResponse(command, peer.zrtc_peer_hardware_encoder_support(peer.peerHandle));
            return true;
        case 'isRecordNetworkData':
            sendPeerJniResponse(command, peer.zrtc_peer_is_record_network_data(peer.peerHandle));
            return true;
        case 'checkCacheValid':
            sendPeerJniResponse(command, peer.zrtc_peer_check_cache_valid(peer.peerHandle, data.userId || 0, data.callId || 0));
            return true;
        case 'networkChange':
            peer.zrtc_peer_network_change(peer.peerHandle, getBooleanValue(data, 'available', 'enabled', 'status'));
            return true;
        case 'appStateChange':
            peer.zrtc_peer_on_app_state_change(peer.peerHandle, Number(data.state) || 0);
            return true;
        case 'receiveCallEvent':
            peer.zrtc_peer_receive_call_event(peer.peerHandle, Number(data.event || data.state) || 0);
            return true;
        case 'preIncoming':
            peer.zrtc_peer_pre_incoming(
                peer.peerHandle,
                Number(data.peerId || data.uidFrom || data.partnerId) || 0,
                Number(data.callId || data.id) || 0,
                data.payload || stringifyJson(data)
            );
            return true;
        case 'receiveChangeZrtpServerData':
            sendPeerJniResponse(command, peer.zrtc_peer_receive_change_zrtp_server_data(peer.peerHandle, data.payload || stringifyJson(data)));
            return true;
        case 'receivePartnerForwardData':
            sendPeerJniResponse(command, peer.zrtc_peer_receive_partner_forward_data(peer.peerHandle, data.payload || stringifyJson(data)));
            return true;
        case 'playDtmf':
            peer.zrtc_peer_play_dtmf(peer.peerHandle, Number(data.tone || data.value) || 0);
            return true;
        case 'setAecInternal':
            peer.zrtc_peer_set_aec_internal(peer.peerHandle, Number(data.value) || 0);
            return true;
        case 'setAecExternal':
            peer.zrtc_peer_set_aec_external(peer.peerHandle, Number(data.value) || 0);
            return true;
        case 'setAgcMicLevel':
            peer.zrtc_peer_set_agc_mic_level(peer.peerHandle, Number(data.value) || 0);
            return true;
        case 'setAgcPlayLevel':
            peer.zrtc_peer_set_agc_play_level(peer.peerHandle, Number(data.value) || 0);
            return true;
        case 'setNsLevel':
            peer.zrtc_peer_set_ns_level(peer.peerHandle, Number(data.value) || 0);
            return true;
        case 'setDevConfig':
            peer.zrtc_peer_set_dev_config(peer.peerHandle, data.value || data.config || stringifyJson(data));
            return true;
        case 'enableLowDataMode':
            peer.zrtc_peer_enable_low_data_mode(peer.peerHandle, getBooleanValue(data, 'enabled', 'status'), data.reason || '');
            return true;
        case 'startRecordAudio':
            peer.zrtc_peer_start_record_audio(peer.peerHandle, getBooleanValue(data, 'enabled', 'status'), data.filePath || data.path || '');
            return true;
        case 'recordAudioFromFile':
            peer.zrtc_peer_record_audio_from_file(peer.peerHandle, getBooleanValue(data, 'enabled', 'status'), data.filePath || data.path || '');
            return true;
        case 'registerInAudioStream':
            peer.zrtc_peer_register_in_audio_stream(peer.peerHandle, Number(data.sampleRate) || 16000, Number(data.channels) || 1, getBooleanValue(data, 'enabled', 'status'));
            return true;
        case 'registerOutAudioStream':
            peer.zrtc_peer_register_out_audio_stream(peer.peerHandle, Number(data.sampleRate) || 16000, Number(data.channels) || 1, getBooleanValue(data, 'enabled', 'status'));
            return true;
        case 'deregisterInAudioStream':
            peer.zrtc_peer_deregister_in_audio_stream(peer.peerHandle);
            return true;
        case 'deregisterOutAudioStream':
            peer.zrtc_peer_deregister_out_audio_stream(peer.peerHandle);
            return true;
        case 'reinitAudioDevice':
            sendPeerJniResponse(command, data.outputDevice !== undefined ?
                peer.zrtc_peer_reinit_audio_device(peer.peerHandle, data.inputDevice, data.outputDevice) :
                peer.zrtc_peer_reinit_audio_device(peer.peerHandle, data.reason || data.inputDevice || 0));
            return true;
        case 'restartCapture':
            peer.zrtc_peer_restart_capture(peer.peerHandle);
            return true;
        case 'stopCapture':
            peer.zrtc_peer_stop_capture(peer.peerHandle, getBooleanValue(data, 'keepLastFrame', 'keep'), Number(data.reason) || 0);
            return true;
        case 'saveLastCaptureFrame':
            sendPeerJniResponse(command, peer.zrtc_peer_save_last_capture_frame(peer.peerHandle, data.filePath || data.path || ''));
            return true;
        case 'saveLastRenderFrame':
            sendPeerJniResponse(command, peer.zrtc_peer_save_last_render_frame(peer.peerHandle, data.filePath || data.path || ''));
            return true;
        case 'setLastFrameIntoView':
            peer.zrtc_peer_set_last_frame_into_view(peer.peerHandle);
            return true;
        case 'setLocalRenderWnd':
            peer.zrtc_peer_set_local_render_wnd(peer.peerHandle, data.window || data.renderWindow || null);
            return true;
        case 'addRenderWnd':
            peer.zrtc_peer_add_render_wnd(peer.peerHandle, Number(data.index) || 0, data.window || data.renderWindow || null);
            return true;
        case 'onVideoFilterChange':
            peer.zrtc_peer_on_video_filter_change(peer.peerHandle, getBooleanValue(data, 'enabled', 'status'), Number(data.filterId || data.id) || 0);
            return true;
        case 'onByteBufferFrameAppliedFilter':
            peer.zrtc_peer_on_byte_buffer_frame_applied_filter(
                peer.peerHandle,
                data.buffer || null,
                Number(data.length) || 0,
                Number(data.width) || 0,
                Number(data.height) || 0,
                Number(data.rotation) || 0,
                Number(data.format) || 0,
                Number(data.stride) || 0,
                Number(data.timestamp) || Date.now()
            );
            return true;
        case 'onByteBufferFrameCaptured':
            peer.zrtc_peer_on_byte_buffer_frame_captured(
                peer.peerHandle,
                data.buffer || null,
                Number(data.length) || 0,
                Number(data.width) || 0,
                Number(data.height) || 0,
                Number(data.rotation) || 0,
                Number(data.timestamp) || Date.now()
            );
            return true;
        case 'onTextureFrameCaptured':
            peer.zrtc_peer_on_texture_frame_captured(
                peer.peerHandle,
                Number(data.width) || 0,
                Number(data.height) || 0,
                Number(data.rotation) || 0,
                data.transformMatrix || [],
                Number(data.textureId) || 0,
                Number(data.timestamp) || Date.now(),
                Number(data.mirror) || 0
            );
            return true;
        case 'onSwitchCameraDone':
            peer.zrtc_peer_on_switch_camera_done(peer.peerHandle, getBooleanValue(data, 'success', 'status'));
            return true;
        case 'switchAudioDeviceLayer':
            peer.zrtc_peer_switch_audio_device_layer(peer.peerHandle);
            return true;
        case 'switchToVideoCall':
            sendPeerJniResponse(command, peer.zrtc_peer_switch_to_video_call(peer.peerHandle, getBooleanValue(data, 'enabled', 'status'), data.payload || stringifyJson(data)));
            return true;
        case 'switchToVideoCallAnswer':
            sendPeerJniResponse(command, peer.zrtc_peer_switch_to_video_call_answer(peer.peerHandle, getBooleanValue(data, 'accepted', 'enabled', 'status')));
            return true;
        case 'testResetCodec':
            peer.zrtc_peer_test_reset_codec(peer.peerHandle, Number(data.codec || data.value) || 0);
            return true;
        case 'toggleCurrentServer':
            peer.zrtc_peer_toggle_current_server(peer.peerHandle);
            return true;
        case 'turnOffEncoderH265':
            sendPeerJniResponse(command, peer.zrtc_peer_turn_off_encoder_h265(peer.peerHandle, getBooleanValue(data, 'enabled', 'status')));
            return true;
        case 'updateCalleePreRinging':
            sendPeerJniResponse(command, peer.zrtc_peer_update_callee_pre_ringing(peer.peerHandle, data.payload || stringifyJson(data)));
            return true;
        case 'updateCallerNewRequest':
            sendPeerJniResponse(command, peer.zrtc_peer_update_caller_new_request(peer.peerHandle, data.payload || stringifyJson(data)));
            return true;
        case 'updateCallerRingring':
            sendPeerJniResponse(command, peer.zrtc_peer_update_caller_ringring(peer.peerHandle, data.payload || data.extendData || stringifyJson(data)));
            return true;
        case 'updateZrtcConfigInCall':
            sendPeerJniResponse(command, peer.zrtc_peer_update_zrtc_config_in_call(peer.peerHandle, data.payload || stringifyJson(data)));
            return true;
        default:
            return false;
    }
}

function sendPeerJniResponse(command, data) {
    sendToMain({
        type: 'response',
        command,
        data
    });
}

function handleIncomingRequestWithPeerJni(control) {
    const data = control && control.data || {};
    const callConfig = createCallConfigFromData(data, { incoming: true });
    const mediaCodecInfo = createMediaCodecInfoFromData(data);
    try {
        return peer.zrtc_peer_incoming_call(
            peer.peerHandle,
            callConfig,
            mediaCodecInfo,
            data.rtpAddress || data.rtpIP || data.rtpIp || '',
            data.rtcpAddress || data.rtcpIP || data.rtcpIp || data.rtpAddress || data.rtpIP || '',
            data.extraServer || data.rtpIP || data.rtpAddress || ''
        );
    } finally {
        peer.zrtc_media_codec_info_delete(mediaCodecInfo);
        peer.zrtc_call_config_delete(callConfig);
    }
}

function createCallConfigFromData(data, options = {}) {
    const handle = peer.zrtc_call_config_create();
    const params = parseJsonObject(data && data.params);
    const partner = data && Array.isArray(data.partner) ? data.partner[0] : null;
    const local = data && data.local || {};
    const zrtcConfig = data && (data.zrtc_config || data.zrtcConfig) || params.zrtc_config || params.zrtcConfig || {};
    const configJson = data && (data.configJson || data.config_json || data.settings) || params.settings || {};
    const callId = data && (data.callId || data.id) || 0;
    const partnerId = data && (data.calleeId || data.partnerId || data.uidFrom || data.uidTo || data.reveiverId) || partner && partner.id || 0;
    const userId = data && (data.userId || data.fromId || data.uidTo || data.reveiverId) || local.id || 0;
    const video = data && data.video || {};

    if (data && typeof data === 'object') {
        const current = peer.callConfigs.get(handle) || {};
        peer.callConfigs.set(handle, Object.assign(current, data, {
            partner: Array.isArray(data.partner) ? data.partner.slice() : data.partner,
            local: data.local,
            originalCommandData: data
        }));
    }

    peer.zrtc_call_config_set_protocol(handle, Number(data && data.protocol || params.protocol || 3));
    peer.zrtc_call_config_set_partner_id(handle, partnerId || 0);
    peer.zrtc_call_config_set_session(handle, data && (data.session || data.sessId || data.sessionId) || params.sessId || '');
    peer.zrtc_call_config_set_user_id(handle, userId || 0);
    peer.zrtc_call_config_set_zalo_call_id(handle, callId || 0);
    peer.zrtc_call_config_set_support_video_call(handle, data && data.supportVideoCall !== undefined ? !!data.supportVideoCall : true);
    peer.zrtc_call_config_set_video_call(handle, !!(data && (data.type === 1 || data.callType === 'video' || video.enable === 1 || video.enable === true)));
    peer.zrtc_call_config_set_fec_type(handle, Number(data && (data.fecType || data.fec && data.fec.enable) || 0));
    peer.zrtc_call_config_set_enable_change_ZRTP(handle, !!(data && data.enableChangeZRTP));
    peer.zrtc_call_config_set_config_json(handle, stringifyJson(configJson));
    peer.zrtc_call_config_set_zrtc_config_json(handle, stringifyJson(zrtcConfig));
    peer.zrtc_call_config_set_os_info(handle, `${process.platform}/${process.arch}`);
    peer.zrtc_call_config_set_client_version(handle, Number(data && data.clientVersion || 0));
    peer.zrtc_call_config_set_extra_info(handle, data && (data.extraInfo || data.extra_info || '') || '');
    peer.zrtc_call_config_set_protocol_type(handle, Number(data && data.protocolType || 0));
    peer.zrtc_call_config_set_loopback_mode(handle, Number(data && data.loopbackMode || 0));
    peer.zrtc_call_config_set_zrtc_packet_output_file(handle, data && data.zrtcPacketOutputFile || '');
    peer.zrtc_call_config_set_log_stat_filename(handle, data && data.logStatFilename || '');
    peer.zrtc_call_config_set_permission_start_camera(handle, data && data.permissionStartCamera !== undefined ? !!data.permissionStartCamera : true);

    if (Array.isArray(data && data.spectrumFilePath)) {
        peer.zrtc_call_config_set_spectrum_file_path(handle, data.spectrumFilePath);
    }

    return handle;
}

function createMediaCodecInfoFromData(data) {
    const handle = peer.zrtc_media_codec_info_create();
    const params = parseJsonObject(data && data.params);
    peer.zrtc_media_codec_info_set_audio_partner_codec(handle, data && (data.codec || data.audioConfig) || params.codec || '');
    peer.zrtc_media_codec_info_set_extend_data(handle, data && (data.extendData || data.extend_data) || params.extendData || params.extend_data || '');
    return handle;
}

function parseJsonObject(value) {
    if (!value || typeof value !== 'string') {
        return value && typeof value === 'object' ? value : {};
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

function stringifyJson(value) {
    if (!value) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch (_) {
        return '';
    }
}

function getBooleanValue(data, ...keys) {
    if (typeof data === 'boolean') {
        return data;
    }

    if (typeof data === 'number') {
        return data !== 0;
    }

    if (typeof data === 'string') {
        return data === '1' || data.toLowerCase() === 'true';
    }

    if (data && typeof data === 'object') {
        for (const key of keys) {
            if (data[key] !== undefined) {
                return getBooleanValue(data[key]);
            }
        }
    }

    return false;
}

function clearCallTimeout() {
    if (callTimeout) {
        clearTimeout(callTimeout);
        callTimeout = null;
    }
}

function scheduleCallTimeout() {
    const callId = peer.engine.getCurrentCallId();
    if (!callId) {
        return;
    }

    const timeoutPeer = peer;
    const timeoutGeneration = peerGeneration;
    // Before media starts there may be no remote control event. Free the call
    // state and write a missed/cancel log instead of leaving "in call" stuck.
    callTimeout = setTimeout(() => {
        callTimeout = null;
        if (timeoutGeneration !== peerGeneration || timeoutPeer !== peer) {
            log('stale call timeout ignored', {
                callId,
                generation: timeoutGeneration,
                currentGeneration: peerGeneration
            });
            return;
        }
        const responses = timeoutPeer.engine.handleCallTimeout(callId);
        for (const response of responses) {
            sendToMain(response);
        }
        if (shouldRecreateIdleFromResponses(responses)) {
            recreatePeerForIdle('call-timeout');
        }
    }, Number(process.env.ZALO_CALL_REQUEST_TIMEOUT_MS || 15000));
}

function connectSocket(socketPath, role, onConnect) {
    // The main app creates the socket server first. If the connection drops,
    // reconnect so dev reloads do not require restarting this helper manually.
    const socket = net.createConnection(socketPath);

    socket.on('connect', () => {
        log(`${role} connected`, { socketPath });
        onConnect(socket);
    });

    socket.on('error', (error) => {
        log(`${role} error`, { code: error.code, message: error.message });
    });

    socket.on('close', () => {
        log(`${role} closed`);
        if (!shuttingDown) {
            setTimeout(() => connectSocket(socketPath, role, onConnect), 1000);
        }
    });

    return socket;
}

function start() {
    const parser = createChunkParser((encrypted) => {
        try {
            handleCommand(JSON.parse(decrypt(encrypted).replace(/[\0]/g, '')));
        } catch (error) {
            log('parse error', { message: error.message });
        }
    });

    recvSocket = connectSocket(recvSocketPath, 'recv', () => {
        sendToMain({
            type: 'update',
            command: 'native-ready',
            data: { platform: process.platform, linux: true }
        });
    });

    sendSocket = connectSocket(sendSocketPath, 'send', (socket) => {
        socket.on('data', (data) => {
            socket.write('ack');
            parser(data);
        });
    });
}

function shutdown(code) {
    shuttingDown = true;
    clearCallTimeout();
    if (helperRestartTimer) {
        clearTimeout(helperRestartTimer);
        helperRestartTimer = null;
    }
    if (pendingMakeCallTimer) {
        clearTimeout(pendingMakeCallTimer);
        pendingMakeCallTimer = null;
    }
    pendingMakeCallMessage = null;
    peer.zrtc_peer_delete(peer.peerHandle);
    if (recvSocket && !recvSocket.destroyed) recvSocket.destroy();
    if (sendSocket && !sendSocket.destroyed) sendSocket.destroy();
    process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log('zalo call linux helper starting', { recvSocketPath, sendSocketPath, logPath });
start();
