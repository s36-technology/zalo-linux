'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LinuxCallWindow = require('./linux-call-window');
const LinuxMediaEngine = require('./linux-media-engine');

const SIGNAL_COMMAND = Object.freeze({
    REQUEST_CALL: 401,
    ANSWER_INCOMING: 402,
    CANCEL_CALL: 405,
    END_CALL_LOG: 406,
    RINGING: 407,
    ANSWER_ACK: 408,
    END_CALL: 409,
    REQUEST_TRANSPORT: 416
});

const VIDEO_STATE = Object.freeze({
    LOCAL_ON: 8,
    LOCAL_OFF: 9,
    REMOTE_ON: 10,
    REMOTE_OFF: 11
});

class LinuxCallEngine {
    constructor({ log, send, nativeEvents }) {
        this.log = log;
        this.send = send;
        this.callRunning = false;
        this.currentCall = null;
        this.currentMediaState = null;
        this.nativeEventsEnabled = nativeEvents === true;
        this.nativeEventQueue = [];
        this.localState = {};
        this.lastOutgoingCallId = null;
        this.connectedRemoteSilenceTimer = null;
        this.experimental = process.env.ZALO_LINUX_CALL_EXPERIMENTAL === '1';
        this.mediaEngineEnabled = process.env.ZALO_LINUX_CALL_MEDIA_ENGINE !== '0';
        this.protocolLogPath = process.env.ZALO_CALL_PROTOCOL_LOG ||
            path.join(os.tmpdir(), 'zalo-call-linux-protocol.jsonl');
        // Keep signaling/media/window concerns separate. This class only owns
        // call state and decides which protocol message should be emitted next.
        this.mediaEngine = new LinuxMediaEngine({
            log: this.log,
            record: this.record.bind(this),
            onRemoteEnd: (details) => {
                for (const response of this.handleRemoteMediaEnd(details)) {
                    if (this.send) this.send(response);
                }
            }
        });
        this.callWindow = new LinuxCallWindow({
            log: this.log,
            record: this.record.bind(this),
            onAnswer: () => {
                for (const response of this.handleAnswerIncomingCall()) {
                    if (this.send) this.send(response);
                }
            },
            onHangup: (details) => {
                for (const response of this.handleEndCall(details)) {
                    if (this.send) this.send(response);
                }
            },
            onUnexpectedExit: (details) => {
                for (const response of this.handleCallWindowUnexpectedExit(details)) {
                    if (this.send) this.send(response);
                }
            }
        });
    }

    getDeviceList() {
        return this.mediaEngine.getDeviceList();
    }

    getNativeDeviceList() {
        const devices = this.getDeviceList() || {};
        const result = [];

        for (const item of devices.videoInputDevices || []) {
            result.push(this.buildNativeDevice(0, item));
        }

        for (const item of devices.audioInputDevices || []) {
            result.push(this.buildNativeDevice(1, item));
        }

        for (const item of devices.audioOutputDevices || []) {
            result.push(this.buildNativeDevice(2, item));
        }

        return result;
    }

    buildNativeDevice(type, item) {
        if (item && typeof item === 'object') {
            return {
                t: type,
                n: String(item.name || item.displayName || item.label || item.id || ''),
                i: String(item.id !== undefined ? item.id : item.device || item.name || '')
            };
        }

        return {
            t: type,
            n: String(item || ''),
            i: String(item || '')
        };
    }

    init(data) {
        this.localState = data || null;
        return {
            type: 'update',
            command: 'callState',
            data: { state: 'free' }
        };
    }

    makeCall(data) {
        this.record('makeCall', data);
        this.emitNativeEvent('onMakeCall');
        this.log('linux call makeCall', {
            type: data && data.type,
            partners: data && data.partner && data.partner.length,
            experimental: this.experimental
        });

        if (!this.experimental) {
            this.callRunning = false;

            return [
                {
                    type: 'request',
                    command: 'popup',
                    data: {
                        header: 'ZaloCall Linux',
                        content: 'Linux call IPC is wired, but experimental signaling is disabled.'
                    }
                },
                this.buildCallState('free', {
                    reason: 'linux-call-experimental-disabled'
                })
            ];
        }

        const partner = data && Array.isArray(data.partner) ? data.partner[0] : null;
        if (!partner || !partner.id) {
            this.callRunning = false;
            return [
                this.buildPopup('ZaloCall Linux', 'Cannot start call: missing callee id.'),
                this.buildCallState('free', { reason: 'missing-callee-id' })
            ];
        }

        const callId = this.createOutgoingCallId(data);
        const callType = data.type || 1;
        const statusFiveRedialAttempt = Number(data.__linuxStatus5RedialAttempt || 0);

        this.currentCall = {
            callId,
            calleeId: partner.id,
            calleeSignalId: null,
            calleeNoisedId: partner.id,
            localUserId: data.fromId || data.userId || null,
            zrtcToken: 0,
            calleeName: partner.name,
            callType,
            protocol: data.protocol,
            session: data.sessId || data.session,
            startedAt: Date.now(),
            answeredAt: null,
            loggedBubble: false,
            requestData: data,
            statusFiveRedialAttempt,
            state: 'requesting'
        };
        if (this.localState.configuredTransport) {
            this.currentCall.transportConfig = Object.assign(
                {},
                this.localState.configuredTransport,
                {
                    callId,
                    session: this.getFirstValue(
                        this.localState.configuredTransport.session,
                        data.sessId,
                        data.session
                    )
                }
            );
        }
        this.currentMediaState = null;
        this.callRunning = true;
        // Show the Linux call UI as soon as dialing starts. Waiting for the
        // 416/media handshake makes a failed or slow signaling path look like
        // the call button did nothing.
        this.callWindow.open(this.currentCall, this.currentMediaState);

        // 401 is the initial Zalo requestCall signal. The renderer sends the
        // HTTP/API call and later feeds the response back through recvSignal.
        const requestSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.REQUEST_CALL,
            data: {
                calleeId: partner.id,
                callId,
                codec: this.getAudioCodec(),
                type: callType
            }
        };

        this.record('sendSignal', {
            command: requestSignal.command,
            data: requestSignal.data
        });

        return [
            this.buildCallState('calling', {
                callId,
                calleeId: partner.id,
                callType,
                stage: 'requestCall'
            }),
            requestSignal
        ];
    }

    handleRecvSignal(command, data) {
        this.record('recvSignal', { command, data });
        this.log('linux call recvSignal', { command, hasCall: !!this.currentCall });

        if (!this.currentCall) {
            return [];
        }

        if (data && data.error) {
            const callId = this.currentCall.callId;
            this.clearConnectedRemoteSilenceWatchdog();
            this.callRunning = false;
            this.currentMediaState = null;
            this.mediaEngine.stop();
            this.callWindow.close();
            this.currentCall = null;
            this.emitNativeEvent('onCallAudioState', { state: '0' });
            this.emitNativeEvent('onCallErr', {
                errCode: String(data.error.code || data.error)
            });
            return [
                this.buildCallState('free', {
                    callId,
                    reason: 'send-signal-error',
                    error: data.error
                })
            ];
        }

        if (this.isRemoteEndRecvSignal(command, data)) {
            return this.handleRemoteSignalEnd(command, data);
        }

        if (command === SIGNAL_COMMAND.REQUEST_CALL) {
            this.currentCall.state = 'requestCallResponse';
            // The 401 response contains server RTP/RTCP/session info. We map it
            // into the 416 sendRequestCall payload below.
            return this.tryBuildRequestSignal(data);
        }

        if (command === SIGNAL_COMMAND.REQUEST_TRANSPORT) {
            this.currentCall.state = 'requestAccepted';
            this.emitNativeCallState('connected', {
                command,
                stage: 'request-accepted'
            });

            if (!this.mediaEngineEnabled) {
                return this.stopUnsupportedMediaCall('linux-media-engine-missing');
            }

            return this.startMediaCall('request-accepted');
        }

        return [];
    }

    isRemoteEndRecvSignal(command, data) {
        if (command !== SIGNAL_COMMAND.END_CALL && command !== SIGNAL_COMMAND.CANCEL_CALL) {
            return false;
        }

        const payload = this.unwrapSignalData(data);
        const params = this.parseParams(payload.params);
        const callId = this.getFirstValue(
            payload.callId,
            payload.id,
            params.callId,
            params.id
        );

        if (callId && this.currentCall && this.currentCall.callId !== String(callId)) {
            return false;
        }

        if (command === SIGNAL_COMMAND.END_CALL) {
            return !!(callId || payload.uidFrom || payload.uidTo);
        }

        if (!callId) {
            return this.isCurrentCallPeerSignal(payload, params);
        }

        const status = Number(this.getFirstValue(
            payload.status,
            params.status
        ));

        return !Number.isFinite(status) || status === 3 || status === 6;
    }

    handleRemoteSignalEnd(command, data) {
        const payload = this.unwrapSignalData(data);
        const params = this.parseParams(payload.params);
        const callId = this.getFirstValue(
            payload.callId,
            payload.id,
            params.callId,
            params.id,
            this.currentCall && this.currentCall.callId
        );

        this.record('remoteSignalEnd', {
            command,
            callId,
            data
        });

        return this.handleRemoteEndControl({
            act_type: 'voip',
            act: `signal_${command}`,
            data: Object.assign({}, payload, {
                callId,
                status: this.getFirstValue(
                    payload.status,
                    params.status,
                    command === SIGNAL_COMMAND.END_CALL ? 3 : 6
                )
            })
        });
    }

    isCurrentCallPeerSignal(payload, params) {
        const call = this.currentCall;
        if (!call) {
            return false;
        }

        const signalIds = this.collectIds(
            payload.uidFrom,
            payload.uidTo,
            payload.callerId,
            payload.calleeId,
            payload.fromId,
            payload.toId,
            payload.receiverId,
            params.uidFrom,
            params.uidTo,
            params.callerId,
            params.calleeId,
            params.fromId,
            params.toId,
            params.receiverId
        );
        const peerIds = this.collectIds(
            call.calleeSignalId,
            call.calleeId,
            call.calleeNoisedId,
            call.callerId,
            call.callerNoisedId,
            call.peerNoisedId
        );
        const localIds = this.collectIds(call.localUserId);

        if (!signalIds.length || !peerIds.length) {
            return false;
        }

        const hasPeer = signalIds.some((id) => peerIds.includes(id));
        const hasLocal = !localIds.length || signalIds.some((id) => localIds.includes(id));

        return hasPeer && hasLocal;
    }

    handleCallTimeout(callId) {
        if (!this.currentCall || this.currentCall.callId !== callId) {
            return [];
        }

        if (this.currentCall.answeredAt) {
            return [];
        }

        this.record('timeout', {
            callId,
            state: this.currentCall.state
        });
        this.log('linux call timeout', {
            callId,
            state: this.currentCall.state
        });

        const call = this.currentCall;
        const bubble = this.buildCallBubble(call, 'request-timeout');
        const cancelSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.CANCEL_CALL,
            data: {
                toId: this.getEndSignalToId(call),
                callId: call.callId,
                callType: call.callType
            }
        };
        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop({ zrtcEndCall: call });
        this.callWindow.close();
        this.currentCall = null;

        this.record('sendSignal', {
            command: cancelSignal.command,
            data: cancelSignal.data
        });

        return [
            cancelSignal,
            bubble,
            this.buildEndCallLogSignal(call, 'request-timeout'),
            this.buildCallState('free', {
                callId,
                reason: 'request-timeout'
            })
        ].filter(Boolean);
    }

    getCurrentCallId() {
        if (!this.currentCall || this.currentCall.answeredAt) {
            return null;
        }

        return this.currentCall.callId;
    }

    handleCallWindowUnexpectedExit(details) {
        if (!this.currentCall) {
            return [];
        }

        this.record('callWindowUnexpectedExit', {
            callId: this.currentCall.callId,
            state: this.currentCall.state,
            details
        });

        return this.handleEndCall();
    }

    handleControl(data) {
        this.record('control', data);
        this.log('linux call control', {
            act: data && data.act,
            act_type: data && data.act_type
        });

        if (!data) {
            return [];
        }

        if (data.act === 'request') {
            return this.handleIncomingRequest(data);
        }

        if (data.act === 'start_capture' && this.currentCall && !this.isVideoCall(this.currentCall)) {
            return this.upgradeToVideoCall(data.data || {});
        }

        if (this.handleLocalMediaControl(data)) {
            return [
                this.buildCallState(this.currentCall ? 'calling' : 'free', {
                    callId: this.currentCall && this.currentCall.callId,
                    reason: data.act
                })
            ];
        }

        if (this.isRemoteHangupControl(data)) {
            return this.handleRemoteEndControl(data);
        }

        if (data.act === 'answer' && this.currentCall) {
            if (this.currentCall.incoming) {
                return this.handleAnswerIncomingCall(data);
            }

            this.rememberRemoteIdsFromControl(data);

            const answerStatus = this.getControlStatus(data);
            if (answerStatus === 5) {
                return this.handleStatusFiveRemoteAnswer(data, answerStatus);
            }

            if (!this.isConnectedAnswerControl(data)) {
                this.record('remoteAnswerIgnored', {
                    callId: this.currentCall.callId,
                    status: answerStatus,
                    reason: 'non-connected-status'
                });

                return [
                    this.buildCallState('calling', {
                        callId: this.currentCall.callId,
                        reason: 'remote-answer-provisional',
                        status: answerStatus
                    })
                ];
            }

            // Remote answer marks the call as connected. From this point local
            // hangup should send 409 endcall instead of 405 cancel.
            const answerAckSignal = this.buildAnswerAckSignal(this.currentCall);
            this.currentCall.state = 'remoteAnswer';
            this.currentCall.answeredAt = Date.now();
            this.emitNativeCallState('connected', {
                callId: this.currentCall.callId,
                stage: 'remote-answer'
            });
            const mediaTransportChanged = this.updateCurrentTransportFromControl(data);

            if (!this.mediaEngineEnabled) {
                return [
                    answerAckSignal,
                    ...this.stopUnsupportedMediaCall('remote-answer-without-media-engine')
                ].filter(Boolean);
            }

            if (mediaTransportChanged && this.mediaEngine.active) {
                this.currentMediaState = null;
                this.mediaEngine.stop();
            }

            if (!this.mediaEngine.active) {
                return [
                    answerAckSignal,
                    ...this.startMediaCall(
                        mediaTransportChanged ? 'remote-answer-transport-update' : 'remote-answer'
                    )
                ].filter(Boolean);
            }

            this.callWindow.update(this.currentCall, this.currentMediaState);
            this.scheduleConnectedRemoteSilenceWatchdog('remote-answer-media-running');

            return [
                answerAckSignal,
                this.buildCallState('calling', {
                    callId: this.currentCall.callId,
                    reason: 'remote-answer',
                    stage: 'media-running'
                })
            ];
        }

        return [];
    }

    handleStatusFiveRemoteAnswer(data, answerStatus) {
        if (!this.currentCall) {
            return [];
        }

        const call = this.currentCall;
        const callId = call.callId;
        call.state = 'remoteAnswerStatus5';
        call.statusFiveNoMedia = true;
        call.answeredAt = call.answeredAt || Date.now();
        this.emitNativeCallState('connected', {
            callId,
            status: answerStatus,
            stage: 'remote-answer-status-5'
        });
        const mediaTransportChanged = this.updateCurrentTransportFromControl(data);
        const answerAckSignal = this.buildAnswerAckSignal(call);
        const redialResponses = this.tryStatusFiveRedial(call, answerStatus, mediaTransportChanged);
        if (redialResponses) {
            return redialResponses;
        }

        this.record('remoteAnswerStatus5', {
            callId,
            status: answerStatus,
            ack: !!answerAckSignal,
            mediaWasActive: this.mediaEngine.active,
            mediaTransportChanged
        });
        this.emitCallQualityChanged(answerStatus);

        if (!this.mediaEngineEnabled) {
            return [
                answerAckSignal,
                ...this.stopUnsupportedMediaCall('remote-answer-status-5-without-media-engine')
            ].filter(Boolean);
        }

        if (mediaTransportChanged && this.mediaEngine.active) {
            this.currentMediaState = null;
            this.mediaEngine.stop();
        }

        if (!this.mediaEngine.active) {
            return [
                answerAckSignal,
                ...this.startMediaCall(
                    mediaTransportChanged ? 'remote-answer-status-5-transport-update' : 'remote-answer-status-5'
                )
            ].filter(Boolean);
        }

        this.callWindow.update(call, this.currentMediaState);
        this.scheduleConnectedRemoteSilenceWatchdog('remote-answer-status-5-media-running');

        return [
            answerAckSignal,
            this.buildCallState('calling', {
                callId,
                reason: 'remote-answer-status-5',
                stage: 'media-running',
                status: answerStatus
            })
        ].filter(Boolean);
    }

    tryStatusFiveRedial(call, answerStatus, mediaTransportChanged) {
        if (process.env.ZALO_CALL_STATUS_5_AUTO_REDIAL !== '1') {
            return null;
        }

        const maxAttempts = Math.max(0, Number(process.env.ZALO_CALL_STATUS_5_AUTO_REDIAL_MAX || 3));
        const attempt = Number(call.statusFiveRedialAttempt || 0);
        if (attempt >= maxAttempts) {
            return this.cancelStatusFiveCall(call, answerStatus, {
                reason: 'status-5-redial-exhausted',
                mediaTransportChanged
            });
        }

        const requestData = call.requestData;
        if (!requestData || !Array.isArray(requestData.partner) || !requestData.partner.length) {
            return null;
        }

        const redialDelayMs = Math.max(0, Number(process.env.ZALO_CALL_STATUS_5_AUTO_REDIAL_MS || 1600));
        const cancelSignal = this.buildStatusFiveCancelSignal(call);

        this.record('remoteAnswerStatus5Redial', {
            callId: call.callId,
            status: answerStatus,
            attempt,
            nextAttempt: attempt + 1,
            delayMs: redialDelayMs,
            mediaWasActive: this.mediaEngine.active,
            mediaTransportChanged
        });
        this.teardownStatusFiveCall(call, cancelSignal, 'status-5-redial-cancel');

        this.scheduleStatusFiveRedial(requestData, attempt + 1, redialDelayMs);

        return [
            cancelSignal,
            this.buildCallState('calling', {
                callId: call.callId,
                reason: 'remote-answer-status-5-redial',
                stage: 'redialing',
                status: answerStatus
            })
        ];
    }

    cancelStatusFiveCall(call, answerStatus, details = {}) {
        const cancelSignal = this.buildStatusFiveCancelSignal(call);

        this.record('remoteAnswerStatus5Cancel', {
            callId: call.callId,
            status: answerStatus,
            reason: details.reason,
            attempt: call.statusFiveRedialAttempt || 0,
            mediaWasActive: this.mediaEngine.active,
            mediaTransportChanged: details.mediaTransportChanged
        });

        this.teardownStatusFiveCall(call, cancelSignal, details.reason || 'status-5-cancel');

        return [
            cancelSignal,
            this.buildCallState('free', {
                callId: call.callId,
                reason: details.reason || 'remote-answer-status-5-cancelled',
                status: answerStatus
            })
        ];
    }

    buildStatusFiveCancelSignal(call) {
        return {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.CANCEL_CALL,
            data: {
                toId: this.getEndSignalToId(call),
                callId: call.callId,
                callType: call.callType
            }
        };
    }

    teardownStatusFiveCall(call, cancelSignal, reason) {
        this.record('sendSignal', {
            command: cancelSignal.command,
            data: cancelSignal.data,
            reason
        });

        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop({ zrtcEndCall: call });
        this.callWindow.close();
        if (this.currentCall && this.currentCall.callId === call.callId) {
            this.currentCall = null;
        }
    }

    scheduleStatusFiveRedial(requestData, attempt, delayMs) {
        if (!this.send) {
            return;
        }

        const timer = setTimeout(() => {
            const nextRequest = Object.assign({}, requestData, {
                callId: undefined,
                id: undefined,
                __linuxStatus5RedialAttempt: attempt
            });

            this.record('statusFiveRedialStart', {
                attempt,
                partnerCount: Array.isArray(nextRequest.partner) ? nextRequest.partner.length : 0,
                type: nextRequest.type
            });

            for (const response of this.makeCall(nextRequest)) {
                if (this.send) this.send(response);
            }
        }, delayMs);

        if (timer.unref) {
            timer.unref();
        }
    }

    isRemoteHangupControl(data) {
        if (!data || (data.act_type && data.act_type !== 'voip')) {
            return false;
        }

        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const callId = this.getFirstValue(
            payload.callId,
            payload.id,
            params.callId,
            params.id
        );

        if (this.currentCall && callId && this.currentCall.callId !== String(callId)) {
            return false;
        }

        if (this.isRemoteCancelAct(data.act) || this.isRemoteEndAct(data.act)) {
            return true;
        }

        const payloadAct = this.getFirstValue(
            payload.act,
            payload.action,
            payload.event,
            params.act,
            params.action,
            params.event
        );

        if (this.isRemoteCancelAct(payloadAct) || this.isRemoteEndAct(payloadAct)) {
            return true;
        }

        const status = Number(this.getFirstValue(
            payload.status,
            params.status
        ));

        // endcall API sends status 3; cancel/reject controls commonly use 6.
        return status === 3 || status === 6;
    }

    normalizeControlAct(act) {
        return String(act || '')
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_');
    }

    isRemoteCancelAct(act) {
        act = this.normalizeControlAct(act);
        return act === 'cancel' ||
            act === 'cancel_call' ||
            act === 'call_cancel' ||
            act === 'cancelcall' ||
            act === 'canceled' ||
            act === 'cancelled' ||
            act === 'reject' ||
            act === 'reject_call' ||
            act === 'call_reject' ||
            act === 'rejected' ||
            act === 'decline' ||
            act === 'declined' ||
            act === 'busy';
    }

    isRemoteEndAct(act) {
        act = this.normalizeControlAct(act);
        return act === 'end' ||
            act === 'end_call' ||
            act === 'call_end' ||
            act === 'endcall' ||
            act === 'finish' ||
            act === 'finish_call' ||
            act === 'finished' ||
            act === 'hangup' ||
            act === 'hang_up' ||
            act === 'hangup_call' ||
            act === 'terminate' ||
            act === 'terminated';
    }

    handleRemoteEndControl(data) {
        // Remote cancellation/end does not necessarily come with a rendered
        // chat item, so we synthesize the same bubble/log used by macOS.
        const call = this.currentCall;
        const reason = `remote-${data && data.act || 'end'}`;
        const ackSignal = this.shouldAckRemoteEnd(data) ?
            this.buildEndAckSignal(call, data) :
            null;
        const bubble = this.buildCallBubble(call, reason);

        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop();
        this.callWindow.close();
        this.currentCall = null;
        this.emitNativeEvent('onCallAudioState', { state: '0' });
        this.emitNativeEvent('onCallAutoHangup');

        return [
            ackSignal,
            bubble,
            this.buildEndCallLogSignal(call, reason),
            this.buildCallState('free', {
                callId: call && call.callId,
                reason
            })
        ].filter(Boolean);
    }

    handleRemoteMediaEnd(details) {
        const call = this.currentCall;

        this.record('remoteMediaEnd', {
            callId: details && details.callId,
            remoteUserId: details && details.remoteUserId,
            token: details && details.token,
            currentCallId: call && call.callId
        });

        if (!call) {
            return [];
        }

        if (details && details.callId && String(details.callId) !== String(call.callId)) {
            this.record('remoteMediaEndIgnored', {
                callId: details.callId,
                currentCallId: call.callId
            });
            return [];
        }

        return this.handleRemoteEndControl({
            act_type: 'voip',
            act: 'media_end_call',
            data: {
                callId: call.callId,
                status: '3'
            }
        });
    }

    shouldAckRemoteEnd(data) {
        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        return payload.needACK === 1 ||
            payload.needACK === '1' ||
            params.needACK === 1 ||
            params.needACK === '1';
    }

    buildEndAckSignal(call, data) {
        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const callId = this.getFirstValue(
            call && call.callId,
            payload.callId,
            params.callId,
            params.id
        );
        const toId = this.getFirstValue(
            payload.uidN,
            params.uidN,
            call && call.calleeNoisedId,
            call && call.calleeId,
            payload.uidFrom,
            payload.callerId,
            payload.fromId,
            params.uidFrom,
            params.callerId,
            params.fromId,
            params.receiverId,
            call && call.calleeSignalId,
            call && call.callerId
        );

        if (!callId || !toId) {
            return null;
        }

        const signal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.END_CALL,
            data: {
                toId,
                callId
            }
        };

        this.record('sendSignal', {
            command: signal.command,
            data: signal.data
        });

        return signal;
    }

    buildAnswerAckSignal(call) {
        if (!call || call.answerAckSent) {
            return null;
        }

        call.answerAckSent = true;
        const signal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.ANSWER_ACK,
            data: {
                calleeId: call.calleeId,
                callId: call.callId
            }
        };

        this.record('sendSignal', {
            command: signal.command,
            data: signal.data
        });

        return signal;
    }

    updateCurrentTransportFromControl(data) {
        if (!this.currentCall) {
            return false;
        }

        const previous = Object.assign({}, this.currentCall.transportConfig || {});
        const next = this.buildIncomingTransportConfig(data, this.currentCall);
        if (!next) {
            return false;
        }

        const merged = Object.assign({}, previous, next, {
            calleeId: previous.calleeId || this.currentCall.calleeId,
            callId: this.currentCall.callId
        });

        if (!this.currentCall.incoming && previous.zrtcMedia === true && next.zrtcMedia === false) {
            this.record('transportZrtcMediaPreserved', {
                callId: this.currentCall.callId,
                previousSrtpMode: previous.srtpMode,
                previousNewZrtc: previous.newZrtc,
                answerSrtpMode: next.srtpMode,
                answerNewZrtc: next.newZrtc
            });
            merged.zrtcMedia = true;
            merged.srtpMode = previous.srtpMode;
            merged.newZrtc = previous.newZrtc;
            merged.answerSrtpMode = next.srtpMode;
            merged.answerNewZrtc = next.newZrtc;
            merged.zrtcAnswerDowngraded = true;
            // The answer can downgrade srtp/newZrtc while still telling us the
            // actual packet framing mode. Keep ZRTC enabled from the request,
            // but keep the downgrade flag so LinuxMediaEngine can dual-send
            // plain RTP for peers that reject wrapped uplink audio.
            merged.packetMode = next.packetMode !== undefined ? next.packetMode : previous.packetMode;
        }

        this.currentCall.transportConfig = merged;

        return previous.rtpAddress !== merged.rtpAddress ||
            previous.rtcpAddress !== merged.rtcpAddress ||
            this.normalizeCodecForCompare(previous.codec) !== this.normalizeCodecForCompare(merged.codec) ||
            previous.session !== merged.session ||
            previous.zrtcMedia !== merged.zrtcMedia ||
            previous.packetMode !== merged.packetMode;
    }

    normalizeCodecForCompare(codec) {
        if (codec === undefined || codec === null || codec === '') {
            return '';
        }

        try {
            const parsed = typeof codec === 'string' ? JSON.parse(codec) : codec;
            const codecs = Array.isArray(parsed) ? parsed : [parsed];
            return codecs
                .filter((item) => item && typeof item === 'object')
                .map((item) => [
                    item.payload,
                    item.name,
                    item.frmPtime,
                    item.dynamicFptime
                ].map((value) => value === undefined || value === null ? '' : String(value)).join(':'))
                .join('|');
        } catch (_) {
            return String(codec).trim();
        }
    }

    handleIncomingRequest(data) {
        if (!this.experimental) {
            return [
                this.buildPopup(
                    'ZaloCall Linux',
                    'Incoming call received, but experimental signaling is disabled.'
                ),
                this.buildCallState('free', {
                    reason: 'linux-call-experimental-disabled'
                })
            ];
        }

        const incomingCall = this.buildIncomingCall(data, false);
        if (!incomingCall) {
            this.record('incomingRequestMissingFields', data);
            return [
                this.buildPopup(
                    'ZaloCall Linux',
                    'Incoming call metadata was incomplete. Details were logged for mapping.'
                )
            ];
        }

        if (
            this.currentCall &&
            this.currentCall.callId !== incomingCall.callId &&
            this.currentCall.answeredAt &&
            this.isSameCallPeer(this.currentCall, incomingCall)
        ) {
            return this.handleIncomingPeerReset(incomingCall);
        }

        if (this.currentCall && this.currentCall.callId !== incomingCall.callId) {
            const busySignal = {
                type: 'sendSignal',
                command: SIGNAL_COMMAND.CANCEL_CALL,
                data: {
                    toId: this.getCallControlPeerId(incomingCall),
                    callId: incomingCall.callId,
                    callType: incomingCall.callType
                }
            };
            this.record('sendSignal', {
                command: busySignal.command,
                data: busySignal.data
            });
            return [
                busySignal,
                this.buildCallState('calling', {
                    callId: this.currentCall.callId,
                    reason: 'incoming-while-busy'
                })
            ];
        }

        if (this.currentCall && this.currentCall.callId === incomingCall.callId) {
            this.currentCall = Object.assign(this.currentCall, incomingCall, {
                answeredAt: this.currentCall.answeredAt,
                loggedBubble: this.currentCall.loggedBubble,
                state: this.currentCall.state
            });
        } else {
            this.currentCall = incomingCall;
        }

        this.currentMediaState = null;
        this.callRunning = true;
        this.emitNativeEvent('onIncomingCall');
        if (this.currentCall.transportConfig) {
            this.emitInitZrtpWithServer(
                this.currentCall.transportConfig.rtcpAddress,
                this.currentCall.transportConfig.rtpAddress
            );
        }
        this.callWindow.open(this.currentCall, this.currentMediaState);

        const ringSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.RINGING,
            data: {
                callerId: this.getCallControlPeerId(this.currentCall),
                callId: this.currentCall.callId
            }
        };

        this.record('sendSignal', {
            command: ringSignal.command,
            data: ringSignal.data
        });

        return [
            ringSignal,
            this.buildCallState('calling', {
                callId: this.currentCall.callId,
                callerId: this.currentCall.callerId,
                callType: this.currentCall.callType,
                direction: 'incoming',
                stage: 'incoming-request'
            })
        ];
    }

    handleIncomingPeerReset(incomingCall) {
        const staleCall = this.currentCall;
        const rejectSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.CANCEL_CALL,
            data: {
                toId: this.getCallControlPeerId(incomingCall),
                callId: incomingCall.callId,
                callType: incomingCall.callType
            }
        };

        this.record('incomingPeerReset', {
            currentCallId: staleCall && staleCall.callId,
            incomingCallId: incomingCall && incomingCall.callId,
            peerId: incomingCall && incomingCall.callerId
        });
        this.record('sendSignal', {
            command: rejectSignal.command,
            data: rejectSignal.data
        });

        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop();
        this.callWindow.close();
        this.currentCall = null;

        return [
            rejectSignal,
            this.buildCallBubble(staleCall, 'remote-peer-reset'),
            this.buildEndCallLogSignal(staleCall, 'remote-peer-reset'),
            this.buildCallState('free', {
                callId: staleCall && staleCall.callId,
                reason: 'remote-peer-reset',
                incomingCallId: incomingCall && incomingCall.callId
            })
        ].filter(Boolean);
    }

    handleAnswerIncomingCall(data) {
        if (!this.currentCall && data) {
            this.currentCall = this.buildIncomingCall(data, true);
            this.currentMediaState = null;
            this.callRunning = !!this.currentCall;
        }

        if (!this.currentCall || !this.currentCall.incoming) {
            return [];
        }

        if (data) {
            const transportConfig = this.buildIncomingTransportConfig(data, this.currentCall);
            if (transportConfig) {
                this.currentCall.transportConfig = transportConfig;
                this.emitInitZrtpWithServer(
                    transportConfig.rtcpAddress,
                    transportConfig.rtpAddress
                );
            }
        }

        const transport = this.currentCall.transportConfig;
        if (!transport || !transport.rtpAddress || !transport.rtcpAddress || !transport.session) {
            this.record('incomingAnswerMissingTransport', {
                callId: this.currentCall.callId,
                transport
            });
            this.emitNativeEvent('onInitZrtpRequestFailed', { retCode: '-1' });
            return [
                this.buildPopup(
                    'ZaloCall Linux',
                    'Cannot answer call: missing RTP/session metadata.'
                ),
                this.buildCallState('calling', {
                    callId: this.currentCall.callId,
                    reason: 'missing-answer-transport',
                    stage: 'incoming-answer'
                })
            ];
        }

        if (this.currentCall.answeredAt) {
            if (!this.mediaEngineEnabled) {
                return [];
            }

            if (!this.mediaEngine.active) {
                return this.startMediaCall('incoming-answer-confirmed');
            }

            this.callWindow.update(this.currentCall, this.currentMediaState);
            this.scheduleConnectedRemoteSilenceWatchdog('incoming-answer-confirmed');

            return [
                this.buildCallState('calling', {
                    callId: this.currentCall.callId,
                    reason: 'incoming-answer-confirmed',
                    stage: 'media-running'
                })
            ];
        }

        if (!this.mediaEngineEnabled) {
            return this.stopUnsupportedMediaCall('incoming-answer-without-media-engine');
        }

        this.currentCall.state = 'incomingAnswer';
        this.currentCall.answeredAt = this.currentCall.answeredAt || Date.now();
        this.emitNativeCallState('connected', {
            callId: this.currentCall.callId,
            stage: 'incoming-answer'
        });

        const answerSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.ANSWER_INCOMING,
            data: {
                callerId: this.getCallControlPeerId(this.currentCall),
                callId: this.currentCall.callId,
                status: this.getIncomingAnswerStatus(),
                codec: transport.codec || this.getAudioCodec(),
                extendData: transport.answerExtendData || transport.extendData || '',
                rtcpAddress: transport.rtcpAddress,
                rtpAddress: transport.rtpAddress,
                session: transport.session
            }
        };

        this.record('sendSignal', {
            command: answerSignal.command,
            data: answerSignal.data
        });

        return [
            answerSignal,
            ...this.startMediaCall('incoming-answer')
        ];
    }

    startMediaCall(reason) {
        // The Linux media engine handles RTP/Opus through GStreamer.
        // Signaling can work even if media startup later fails.
        const result = this.mediaEngine.startOutgoingCall(this.currentCall);
        if (!result.ok) {
            this.record('mediaStartFailed', result);
            return this.stopUnsupportedMediaCall(result.reason || reason);
        }

        if (!this.currentCall.answeredAt) {
            this.currentCall.state = 'mediaStarted';
        }
        this.currentMediaState = result.data || this.currentMediaState || null;
        this.emitNativeEvent('onCallAudioState', { state: '1' });
        if (this.isVideoCall(this.currentCall)) {
            this.emitCallVideoState(VIDEO_STATE.LOCAL_ON);
            this.emitCallVideoState(VIDEO_STATE.REMOTE_ON);
        }
        this.callWindow.open(this.currentCall, this.currentMediaState);
        if (this.currentCall.answeredAt) {
            this.scheduleConnectedRemoteSilenceWatchdog(reason);
        }

        return [
            this.buildCallState('calling', {
                callId: this.currentCall.callId,
                reason,
                stage: 'media-started',
                media: this.currentMediaState
            })
        ];
    }

    handleEndCall(details = {}) {
        if (this.shouldIgnoreFreshIncomingHangup(this.currentCall, details)) {
            this.record('localHangupIgnored', {
                callId: this.currentCall && this.currentCall.callId,
                source: details && details.source,
                answeredAgeMs: Date.now() - this.currentCall.answeredAt
            });
            this.callWindow.update(this.currentCall, this.currentMediaState);
            return [
                this.buildCallState('calling', {
                    callId: this.currentCall.callId,
                    reason: 'fresh-incoming-hangup-ignored'
                })
            ];
        }

        this.record('endCall', {
            callId: this.currentCall && this.currentCall.callId,
            source: details && details.source
        });

        const call = this.currentCall;
        const mediaSummaryBeforeStop = this.getMediaActivitySummary();
        const shouldCancelStatusFiveNoMedia = this.shouldCancelStatusFiveNoMediaCall(
            call,
            mediaSummaryBeforeStop
        );
        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop({ zrtcEndCall: call });
        this.callWindow.close();
        this.currentCall = null;
        this.emitNativeEvent('onCallAudioState', { state: '0' });
        this.emitNativeEvent('onCallAutoHangup');

        if (!call) {
            return [this.buildCallState('free', { reason: 'local-end-no-call' })];
        }

        // 409 is the normal connected hangup. A delayed 405 after successful
        // outgoing calls can poison the next call into the status=5/no-media
        // path, so keep that cancel fallback opt-in only.
        const endToId = this.getEndSignalToId(call);
        let signals;

        if (call.answeredAt && !shouldCancelStatusFiveNoMedia) {
            signals = [
                {
                    type: 'sendSignal',
                    command: SIGNAL_COMMAND.END_CALL,
                    data: {
                        toId: endToId,
                        callId: call.callId
                    }
                }
            ];

            if (!call.incoming) {
                const cancelFallbackDelayMs = Number(
                    process.env.ZALO_CALL_CONNECTED_CANCEL_FALLBACK_MS || 0
                );
                if (cancelFallbackDelayMs > 0) {
                    this.scheduleDelayedSignal(
                        {
                            type: 'sendSignal',
                            command: SIGNAL_COMMAND.CANCEL_CALL,
                            data: {
                                toId: endToId,
                                callId: call.callId,
                                callType: call.callType
                            }
                        },
                        cancelFallbackDelayMs,
                        'caller-connected-cancel-fallback'
                    );
                }
            } else {
                const numericToId = this.getIncomingNumericPeerId(call);
                const endFallbackDelayMs = Number(
                    process.env.ZALO_CALL_INCOMING_END_FALLBACK_MS || 700
                );

                if (numericToId && String(numericToId) !== String(endToId)) {
                    this.scheduleDelayedSignal(
                        {
                            type: 'sendSignal',
                            command: SIGNAL_COMMAND.END_CALL,
                            data: {
                                toId: numericToId,
                                callId: call.callId
                            }
                        },
                        endFallbackDelayMs,
                        'callee-connected-end-numeric-fallback'
                    );
                }

                this.scheduleDelayedSignal(
                    {
                        type: 'sendSignal',
                        command: SIGNAL_COMMAND.CANCEL_CALL,
                        data: {
                            toId: endToId,
                            callId: call.callId,
                            callType: call.callType
                        }
                    },
                    Number(process.env.ZALO_CALL_INCOMING_CANCEL_FALLBACK_MS || 1400),
                    'callee-connected-cancel-fallback'
                );
            }
        } else {
            if (shouldCancelStatusFiveNoMedia) {
                this.record('statusFiveNoMediaCancelOnHangup', {
                    callId: call.callId,
                    media: mediaSummaryBeforeStop
                });
            }

            signals = [
                {
                    type: 'sendSignal',
                    command: SIGNAL_COMMAND.CANCEL_CALL,
                    data: {
                        toId: endToId,
                        callId: call.callId,
                        callType: call.callType
                    }
                }
            ];
        }

        for (const signal of signals) {
            this.record('sendSignal', {
                command: signal.command,
                data: signal.data
            });
        }

        return [
            ...signals,
            this.buildCallBubble(call, 'local-end'),
            this.buildEndCallLogSignal(call, 'local-end'),
            this.buildCallState('free', {
                callId: call.callId,
                reason: 'local-end'
            })
        ].filter(Boolean);
    }

    shouldCancelStatusFiveNoMediaCall(call, summary) {
        if (!call || !call.statusFiveNoMedia) {
            return false;
        }

        return this.getRemoteMediaActivityCounter(summary) === 0;
    }

    shouldIgnoreFreshIncomingHangup(call, details) {
        if (!call || !call.incoming || !call.answeredAt) {
            return false;
        }

        if (!details || details.source !== 'button') {
            return false;
        }

        const guardMs = Number(process.env.ZALO_CALL_INCOMING_ANSWER_HANGUP_GUARD_MS || 5000);
        if (!Number.isFinite(guardMs) || guardMs <= 0) {
            return false;
        }

        return Date.now() - call.answeredAt < guardMs;
    }

    scheduleDelayedSignal(signal, delayMs, reason) {
        if (!this.send || !signal) {
            return;
        }

        const scheduledCallId = signal.data && signal.data.callId;
        const safeDelayMs = Math.max(0, Number.isFinite(delayMs) ? delayMs : 1200);
        const timer = setTimeout(() => {
            if (
                scheduledCallId &&
                this.currentCall &&
                String(this.currentCall.callId) !== String(scheduledCallId)
            ) {
                this.record('delayedSignalSkipped', {
                    command: signal.command,
                    callId: scheduledCallId,
                    currentCallId: this.currentCall.callId,
                    reason
                });
                return;
            }

            this.record('sendSignal', {
                command: signal.command,
                data: signal.data,
                delayed: true,
                reason
            });
            this.send(signal);
        }, safeDelayMs);

        if (timer.unref) {
            timer.unref();
        }
    }

    scheduleConnectedRemoteSilenceWatchdog(reason) {
        this.clearConnectedRemoteSilenceWatchdog();

        const call = this.currentCall;
        if (!call || !call.answeredAt || !this.mediaEngineEnabled) {
            return;
        }

        if (call.incoming && !this.shouldEndIncomingOnRemoteSilence()) {
            this.record('connectedRemoteSilenceWatchdogSkipped', {
                callId: call.callId,
                reason: `incoming-${reason}`,
                media: this.getMediaActivitySummary()
            });
            return;
        }

        const timeoutMs = this.getConnectedRemoteSilenceTimeoutMs();
        if (!timeoutMs) {
            return;
        }

        const summary = this.getMediaActivitySummary();
        if (!this.hasMediaActivityRelays(summary)) {
            this.record('connectedRemoteSilenceWatchdogSkipped', {
                callId: call.callId,
                reason,
                media: summary
            });
            return;
        }

        const remoteMediaCounter = this.getRemoteMediaActivityCounter(summary);
        const callId = call.callId;

        this.record('connectedRemoteSilenceWatchdogScheduled', {
            callId,
            reason,
            timeoutMs,
            remoteMediaCounter,
            media: summary
        });

        this.connectedRemoteSilenceTimer = setTimeout(() => {
            this.connectedRemoteSilenceTimer = null;
            const responses = this.handleConnectedRemoteSilenceTimeout(
                callId,
                remoteMediaCounter
            );

            for (const response of responses) {
                if (this.send) this.send(response);
            }
        }, timeoutMs);

        if (this.connectedRemoteSilenceTimer.unref) {
            this.connectedRemoteSilenceTimer.unref();
        }
    }

    clearConnectedRemoteSilenceWatchdog() {
        if (!this.connectedRemoteSilenceTimer) {
            return;
        }

        clearTimeout(this.connectedRemoteSilenceTimer);
        this.connectedRemoteSilenceTimer = null;
    }

    getConnectedRemoteSilenceTimeoutMs() {
        const value = process.env.ZALO_CALL_CONNECTED_REMOTE_SILENCE_TIMEOUT_MS;
        // Do not auto-end connected calls by default. Linux media support is
        // still best-effort and some peers only send ZRTC control packets while
        // audio/video decoding is being mapped, so a media-silence watchdog can
        // incorrectly close a valid call window after ~15s. Developers can opt
        // back in with ZALO_CALL_CONNECTED_REMOTE_SILENCE_TIMEOUT_MS.
        const timeoutMs = Number(value === undefined ? 0 : value);

        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return 0;
        }

        return Math.max(1000, timeoutMs);
    }

    shouldEndIncomingOnRemoteSilence() {
        return process.env.ZALO_CALL_INCOMING_REMOTE_SILENCE_END === '1';
    }

    getIncomingAnswerStatus() {
        const value = process.env.ZALO_CALL_INCOMING_ANSWER_STATUS;
        const status = Number(value === undefined ? 0 : value);
        return Number.isFinite(status) ? status : 0;
    }

    handleConnectedRemoteSilenceTimeout(callId, previousRemoteMediaCounter) {
        const call = this.currentCall;
        if (!call || call.callId !== callId || !call.answeredAt) {
            return [];
        }

        const summary = this.getMediaActivitySummary();
        if (call.incoming && !this.shouldEndIncomingOnRemoteSilence()) {
            this.record('connectedRemoteSilenceTimeoutIgnored', {
                callId,
                reason: 'incoming-call',
                previousRemoteMediaCounter,
                remoteMediaCounter: this.getRemoteMediaActivityCounter(summary),
                media: summary
            });
            return [];
        }

        if (!this.hasMediaActivityRelays(summary)) {
            this.record('connectedRemoteSilenceWatchdogSkipped', {
                callId,
                reason: 'no-media-relay',
                media: summary
            });
            return [];
        }

        const remoteMediaCounter = this.getRemoteMediaActivityCounter(summary);
        if (remoteMediaCounter > previousRemoteMediaCounter) {
            this.record('connectedRemoteMediaActive', {
                callId,
                previousRemoteMediaCounter,
                remoteMediaCounter,
                media: summary
            });
            this.scheduleConnectedRemoteSilenceWatchdog('remote-media-active');
            return [];
        }

        const reason = 'remote-media-timeout';
        const endSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.END_CALL,
            data: {
                toId: this.getEndSignalToId(call),
                callId: call.callId
            }
        };

        this.record('connectedRemoteSilenceTimeout', {
            callId,
            previousRemoteMediaCounter,
            remoteMediaCounter,
            media: summary
        });
        this.record('sendSignal', {
            command: endSignal.command,
            data: endSignal.data
        });

        this.scheduleDelayedSignal(
            {
                type: 'sendSignal',
                command: SIGNAL_COMMAND.CANCEL_CALL,
                data: {
                    toId: this.getEndSignalToId(call),
                    callId: call.callId,
                    callType: call.callType
                }
            },
            Number(process.env.ZALO_CALL_REMOTE_MEDIA_TIMEOUT_CANCEL_FALLBACK_MS || 1200),
            'remote-media-timeout-cancel-fallback'
        );

        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop({ zrtcEndCall: call });
        this.callWindow.close();
        this.currentCall = null;

        return [
            endSignal,
            this.buildCallBubble(call, reason),
            this.buildEndCallLogSignal(call, reason),
            this.buildCallState('free', {
                callId: call.callId,
                reason
            })
        ].filter(Boolean);
    }

    getMediaActivitySummary() {
        if (!this.mediaEngine || typeof this.mediaEngine.getActivitySummary !== 'function') {
            return null;
        }

        return this.mediaEngine.getActivitySummary();
    }

    hasMediaActivityRelays(summary) {
        return !!(
            summary &&
            Array.isArray(summary.relays) &&
            summary.relays.length > 0
        );
    }

    getRemoteMediaActivityCounter(summary) {
        if (!summary || !Array.isArray(summary.relays)) {
            return 0;
        }

        return summary.relays.reduce((total, relay) => {
            const remotePackets = this.toSafeCounter(relay.remotePackets);
            const remoteAudio = this.toSafeCounter(relay.zrtcRemoteAudioPackets);
            const remoteRtcp = this.toSafeCounter(relay.zrtcRemoteRtcpPackets);
            const remoteControl = this.toSafeCounter(relay.zrtcRemoteControlPackets);
            const plainMedia = Math.max(0, remotePackets - remoteAudio - remoteRtcp - remoteControl);

            return total + remoteAudio + remoteRtcp + plainMedia;
        }, 0);
    }

    toSafeCounter(value) {
        const number = Number(value || 0);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    stopUnsupportedMediaCall(reason) {
        const call = this.currentCall;
        if (!call) {
            return [];
        }

        this.record('unsupportedMediaCall', {
            reason,
            callId: call.callId,
            calleeId: call.calleeId,
            callType: call.callType
        });

        this.clearConnectedRemoteSilenceWatchdog();
        this.callRunning = false;
        this.currentMediaState = null;
        this.mediaEngine.stop();
        this.callWindow.close();
        this.currentCall = null;
        this.emitNativeEvent('onCallAudioState', { state: '0' });
        this.emitNativeEvent('onCallErr', {
            errCode: String(reason || 'unsupported-media')
        });

        return [
            // Even unsupported media should clean up server state and write a
            // call bubble, otherwise the UI looks like the call never happened.
            {
                type: 'sendSignal',
                command: SIGNAL_COMMAND.CANCEL_CALL,
                data: {
                    toId: this.getEndSignalToId(call),
                    callId: call.callId,
                    callType: call.callType
                }
            },
            this.buildCallBubble(call, reason),
            this.buildEndCallLogSignal(call, reason),
            this.buildCallState('free', {
                callId: call.callId,
                reason
            })
        ].filter(Boolean);
    }

    buildCallBubble(call, reason) {
        if (!call || call.loggedBubble) {
            return null;
        }

        // The renderer consumes this "bubble" update only when server-side call
        // sync is disabled. We still send 406 below for the normal sync path.
        call.loggedBubble = true;

        const duration = call.answeredAt ?
            Math.max(1, Math.floor((Date.now() - call.answeredAt) / 1000)) :
            0;
        const isCaller = !call.incoming;
        const isMissed = duration === 0;
        const action = isMissed ? 'recommened.misscall' : 'recommened.calling';
        const params = this.buildCallLogParams(call, reason, duration);
        const title = isMissed ? 'Cuoc goi nho' : (isCaller ? 'Cuoc goi di' : 'Cuoc goi den');

        this.record('callBubble', {
            callId: call.callId,
            partnerId: call.calleeId,
            action,
            duration,
            reason
        });

        return {
            type: 'update',
            command: 'bubble',
            data: {
                role: isCaller,
                partnerId: call.calleeId,
                duration,
                action,
                title,
                description: title,
                params: JSON.stringify(params)
            }
        };
    }

    buildEndCallLogSignal(call, reason) {
        if (!call) {
            return null;
        }

        // 406 sendLogEndCall persists/syncs the call message through Zalo. The
        // logdata schema must match the renderer call-message parser.
        const duration = call.answeredAt ?
            Math.max(1, Math.floor((Date.now() - call.answeredAt) / 1000)) :
            0;
        const params = this.buildCallLogParams(call, reason, duration);
        const signal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.END_CALL_LOG,
            data: {
                callId: call.callId,
                partnerId: call.calleeId,
                status: duration > 0 ? 1 : 0,
                data: JSON.stringify(params),
                duration,
                role: call.incoming ? 0 : 1
            }
        };

        this.record('sendSignal', {
            command: signal.command,
            data: signal.data
        });

        return signal;
    }

    buildCallLogParams(call, reason, duration) {
        const isVideo = call.callType === 3 || call.callType === 6;

        // reason uses Zalo's numeric enum:
        // 2 timeout, 4 caller cancelled after ringing, 0 default/connected.
        return {
            isEnableCallback: 1,
            isCaller: !call.incoming,
            calltype: isVideo ? 1 : 0,
            duration,
            reason: duration === 0 ? this.getMissedReason(reason) : 0
        };
    }

    getMissedReason(reason) {
        if (reason === 'request-timeout') {
            return 2;
        }

        if (reason === 'local-end') {
            return 4;
        }

        return 0;
    }

    tryBuildRequestSignal(data) {
        const requestData = this.buildRequestCallPayload(data);
        if (!requestData) {
            this.record('sendRequestCall-missing-params', data);
            return [
                this.buildPopup(
                    'ZaloCall Linux',
                    'Zalo returned a signaling response. Transport parameters were logged for mapping.'
                )
            ];
        }

        this.currentCall.state = 'sendRequestCall';

        // 416 confirms the transport selected from the 401 response.
        const requestSignal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.REQUEST_TRANSPORT,
            data: requestData
        };

        this.record('sendSignal', {
            command: requestSignal.command,
            data: requestSignal.data
        });

        return [requestSignal];
    }

    buildRequestCallPayload(data) {
        const response = this.unwrapSignalData(data);
        // Different app versions place RTP/session fields at different nesting
        // levels, so keep a defensive fallback scanner.
        const nestedCandidate = this.findTransportCandidate(response);
        const rtpAddress = response.rtpIP ||
            response.rtpAddress ||
            response.rtpaddr ||
            response.rtp_ip ||
            (nestedCandidate && nestedCandidate.rtpAddress);
        const rtcpAddress = response.rtcpIP ||
            response.rtcpAddress ||
            response.rtcpaddr ||
            response.rtcp_ip ||
            (nestedCandidate && nestedCandidate.rtcpAddress);
        const session = response.sessId ||
            response.session ||
            response.session_id ||
            response.sessionId ||
            (nestedCandidate && nestedCandidate.session);

        if (!rtpAddress || !rtcpAddress || !session) {
            return null;
        }

        const callId = String(response.id || response.callId || this.currentCall.callId);
        if (this.currentCall.callId !== callId) {
            this.record('callIdUpdatedFromRequestResponse', {
                previousCallId: this.currentCall.callId,
                callId
            });
            this.currentCall.callId = callId;
            this.lastOutgoingCallId = callId;
        }
        this.rememberRemoteIdsFromSignalResponse(response);
        this.rememberLocalZrtcFieldsFromSignalResponse(response);
        const codec = this.selectAudioCodec(
            response.codec,
            nestedCandidate && nestedCandidate.codec,
            this.getAudioCodec()
        );
        const extendData = response.extendData ||
            response.extend_data ||
            (nestedCandidate && nestedCandidate.extendData) ||
            '';
        const mediaMode = this.buildTransportMediaMode(
            response,
            {},
            nestedCandidate,
            extendData
        );
        const videoCodec = this.selectVideoCodec(
            extendData,
            response,
            nestedCandidate,
            this.currentCall
        );
        const selectedVideoCodec = videoCodec || (
            this.isVideoCall(this.currentCall) ? this.getDefaultVideoCodec() : null
        );
        const videoEnabled = this.isVideoCall(this.currentCall) || !!videoCodec;
        const selectedExtendData = videoEnabled ?
            this.buildOutgoingExtendData(response, rtpAddress, rtcpAddress, mediaMode, selectedVideoCodec) :
            extendData;

        const payload = {
            calleeId: this.currentCall.calleeId,
            rtcpAddress,
            rtpAddress,
            codec,
            extendData: selectedExtendData,
            session,
            callId,
            zrtcMedia: mediaMode.zrtcMedia,
            srtpMode: mediaMode.srtpMode,
            newZrtc: mediaMode.newZrtc,
            packetMode: mediaMode.packetMode
        };

        // Keep Linux-only runtime hints out of the 416 payload. The renderer
        // sends payload as signaling data, while transportConfig is only read
        // locally by the media engine.
        this.currentCall.transportConfig = {
            ...payload,
            videoEnabled,
            videoCodec: selectedVideoCodec,
            zrtcConfig: response.zrtc_config || null
        };
        this.emitInitZrtpWithServer(rtcpAddress, rtpAddress);

        return payload;
    }

    rememberRemoteIdsFromSignalResponse(response) {
        if (!this.currentCall || !response) {
            return;
        }

        const signalId = this.getFirstValue(
            response.toId,
            response.uidTo,
            response.calleeId,
            response.userId
        );

        if (signalId) {
            this.currentCall.calleeSignalId = String(signalId);
        }
    }

    rememberLocalZrtcFieldsFromSignalResponse(response) {
        if (!this.currentCall || !response) {
            return;
        }

        const localUserId = this.getFirstValue(
            response.fromId,
            response.uidFrom,
            response.userId,
            response.callerId
        );
        const token = this.getFirstValue(
            response.token,
            response.callToken,
            response.CallToken,
            response.zrtcToken,
            response.zrtc_token
        );

        if (localUserId) {
            this.currentCall.localUserId = String(localUserId);
        }

        if (token !== undefined) {
            this.currentCall.zrtcToken = token;
        }
    }

    rememberRemoteIdsFromControl(data) {
        if (!this.currentCall) {
            return;
        }

        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const signalId = this.getFirstValue(
            payload.uidFrom,
            payload.callerId,
            payload.fromId,
            params.uidFrom,
            params.callerId,
            params.fromId
        );
        const noisedId = this.getFirstValue(
            payload.uidN,
            params.uidN
        );

        if (signalId) {
            this.currentCall.calleeSignalId = String(signalId);
        }

        if (noisedId) {
            this.currentCall.calleeNoisedId = String(noisedId);
        }
    }

    getEndSignalToId(call) {
        return this.getCallControlPeerId(call);
    }

    getIncomingNumericPeerId(call) {
        if (!call || !call.incoming) {
            return null;
        }

        return this.getFirstValue(
            call.callerId,
            call.calleeSignalId
        );
    }

    isSameCallPeer(call, incomingCall) {
        const currentIds = new Set([
            call && call.calleeId,
            call && call.calleeSignalId,
            call && call.calleeNoisedId,
            call && call.callerId,
            call && call.callerNoisedId,
            call && call.peerNoisedId
        ].filter((value) => value !== undefined && value !== null && value !== '').map(String));
        const incomingIds = [
            incomingCall && incomingCall.callerId,
            incomingCall && incomingCall.calleeId,
            incomingCall && incomingCall.calleeSignalId,
            incomingCall && incomingCall.calleeNoisedId,
            incomingCall && incomingCall.callerNoisedId,
            incomingCall && incomingCall.peerNoisedId
        ];

        return incomingIds.some((value) => currentIds.has(String(value)));
    }

    getCallControlPeerId(call) {
        // Voicecall HTTP endpoints use the opaque/noised Zalo id. The numeric
        // uidFrom/toId from signaling is only useful for media/session mapping.
        return this.getFirstValue(
            call && call.calleeNoisedId,
            call && call.calleeId,
            call && call.callerNoisedId,
            call && call.peerNoisedId,
            call && call.calleeSignalId,
            call && call.callerId
        );
    }

    buildIncomingCall(data, answered) {
        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const callerId = this.getFirstValue(
            payload.callerId,
            payload.uidFrom,
            payload.fromId,
            params.callerId,
            params.uidFrom,
            params.fromId
        );
        const callId = this.getFirstValue(
            payload.callId,
            params.callId,
            params.id
        );

        if (!callerId || !callId) {
            return null;
        }

        const peerId = String(callerId);
        const explicitCallType = Number(this.getFirstValue(
            payload.callType,
            payload.type,
            payload.calltype,
            params.callType,
            params.type,
            params.calltype
        ));
        const hasVideo = this.hasVideoMedia(payload, params);
        // Incoming control "type" can describe the signaling/protocol shape,
        // not the user-facing call kind. If the offer carries video media,
        // force the local state to a video call so the call window and media
        // engine do not treat it as an audio-only call.
        const callType = hasVideo ? 3 : (
            Number.isFinite(explicitCallType) && explicitCallType > 0 ?
                explicitCallType :
                1
        );
        const displayName = this.getFirstValue(
            payload.callerName,
            payload.displayName,
            payload.name,
            params.callerName,
            params.displayName,
            params.name,
            peerId
        );

        const call = {
            callId: String(callId),
            callerId: peerId,
            calleeId: peerId,
            calleeSignalId: peerId,
            calleeNoisedId: this.getFirstValue(payload.uidN, params.uidN),
            localUserId: this.getFirstValue(
                payload.receiverId,
                payload.reveiverId,
                payload.uidTo,
                params.receiverId,
                params.reveiverId,
                params.uidTo
            ),
            zrtcToken: this.getFirstValue(
                payload.token,
                payload.callToken,
                params.token,
                params.callToken,
                0
            ),
            calleeName: displayName,
            callType,
            startedAt: Date.now(),
            answeredAt: answered ? Date.now() : null,
            loggedBubble: false,
            state: answered ? 'incomingAnswer' : 'incomingRequest',
            direction: 'incoming',
            incoming: true
        };

        const transportConfig = this.buildIncomingTransportConfig(data, call);
        if (transportConfig) {
            call.transportConfig = transportConfig;
        }

        return call;
    }

    buildIncomingTransportConfig(data, call) {
        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const nestedCandidate = this.findTransportCandidate({
            payload,
            params
        });
        const rtpAddress = this.getFirstValue(
            payload.rtpAddress,
            payload.rtpaddr,
            payload.rtpIP,
            payload.rtp_ip,
            payload.rtpSerIp,
            params.rtpAddress,
            params.rtpaddr,
            params.rtpIP,
            params.rtp_ip,
            params.rtpSerIp,
            nestedCandidate && nestedCandidate.rtpAddress
        );
        const rtcpAddress = this.getFirstValue(
            payload.rtcpAddress,
            payload.rtcpaddr,
            payload.rtcpIP,
            payload.rtcp_ip,
            params.rtcpAddress,
            params.rtcpaddr,
            params.rtcpIP,
            params.rtcp_ip,
            nestedCandidate && nestedCandidate.rtcpAddress,
            rtpAddress
        );
        const session = this.getFirstValue(
            payload.sessId,
            payload.session,
            payload.session_id,
            payload.sessionId,
            params.sessId,
            params.session,
            params.session_id,
            params.sessionId,
            nestedCandidate && nestedCandidate.session
        );

        if (!rtpAddress || !session) {
            return null;
        }

        const extendData = this.getFirstValue(
            payload.extendData,
            payload.extend_data,
            params.extendData,
            params.extend_data,
            nestedCandidate && nestedCandidate.extendData,
            ''
        );
        const mediaMode = this.buildTransportMediaMode(
            payload,
            params,
            nestedCandidate,
            extendData
        );
        const videoCodec = this.selectVideoCodec(
            extendData,
            payload,
            params,
            nestedCandidate
        );
        const videoEnabled = this.hasVideoMedia(payload, params, extendData) || !!videoCodec;
        const selectedVideoCodec = videoCodec || (videoEnabled ? this.getDefaultVideoCodec() : null);
        const answerExtendData = this.buildIncomingAnswerExtendData(
            extendData,
            rtpAddress,
            rtcpAddress,
            mediaMode,
            selectedVideoCodec
        );

        return {
            callerId: call && call.callerId,
            rtcpAddress,
            rtpAddress,
            codec: this.selectAudioCodec(
                // Incoming control can expose a short top-level codec while
                // params keeps the full offer. Prefer the full offer so Linux
                // answers with the same payload the peer is actually sending.
                params.codec,
                payload.codec,
                nestedCandidate && nestedCandidate.codec,
                this.getAudioCodec()
            ),
            extendData,
            answerExtendData,
            session,
            callId: call && call.callId,
            zrtcMedia: mediaMode.zrtcMedia,
            srtpMode: mediaMode.srtpMode,
            newZrtc: mediaMode.newZrtc,
            packetMode: mediaMode.packetMode,
            videoEnabled,
            videoCodec: selectedVideoCodec,
            zrtcConfig: params.zrtc_config || payload.zrtc_config || null
        };
    }

    buildOutgoingExtendData(response, rtpAddress, rtcpAddress, mediaMode, videoCodec) {
        const zrtcConfig = this.getFirstObject(response && response.zrtc_config);
        const selectedVideoCodec = videoCodec || this.getDefaultVideoCodec();
        const server = {
            bonus: 0,
            rtcp: rtcpAddress,
            rtp: rtpAddress,
            tpType: 0
        };

        // The copied desktop bundle/server wraps this object into params.extraData
        // for the peer. For video calls it must advertise callType=1 and H264,
        // otherwise the peer accepts audio only even when the UI button was video.
        return JSON.stringify({
            callType: 1,
            gccAudio: this.getFirstValue(zrtcConfig.gccAudio ? 1 : undefined, 1),
            gccMode: this.getFirstValue(zrtcConfig.gccMode, 1),
            gccSVLR: 1,
            maxFT: this.getFirstValue(zrtcConfig.maxFT, 0),
            negoVidQual: 1,
            newZrtc: this.getFirstValue(mediaMode.newZrtc, zrtcConfig.newZrtc, 1),
            packetMode: this.getFirstValue(mediaMode.packetMode, zrtcConfig.packetMode, 2),
            platform: 1,
            sP2P: 0,
            select2side: 0,
            serverAddr: [server],
            spTcp: 0,
            srtcp: 0,
            srtpMode: this.getLinuxSrtpMode(),
            supportCallBusy: 1,
            supportHevcDecode: this.getLinuxHevcDecodeSupport(),
            tpType: 0,
            video: {
                codec: selectedVideoCodec ? [selectedVideoCodec] : []
            }
        });
    }

    buildIncomingAnswerExtendData(offerExtendData, rtpAddress, rtcpAddress, mediaMode, videoCodec) {
        const offer = this.parseJsonObject(offerExtendData);
        if (!Object.keys(offer).length) {
            return '';
        }

        const server = this.buildAnswerServerAddress(offer, rtpAddress, rtcpAddress);
        const selectedVideoCodec = videoCodec || this.selectVideoCodec(offer);
        const answer = {
            callType: selectedVideoCodec ? 1 : (this.toOptionalNumber(offer.callType) || 0),
            gccAudio: this.getFirstValue(offer.gccAudio, 1),
            gccMode: this.getFirstValue(offer.gccMode, 1),
            gccSVLR: this.getFirstValue(offer.gccSVLR, 1),
            maxFT: this.getFirstValue(offer.maxFT, 0),
            negoVidQual: this.getFirstValue(offer.negoVidQual, 1),
            newZrtc: this.getFirstValue(mediaMode.newZrtc, offer.newZrtc, 1),
            packetMode: this.getFirstValue(mediaMode.packetMode, offer.packetMode, 2),
            platform: this.getFirstValue(offer.platform, 1),
            sP2P: 0,
            select2side: 0,
            serverAddr: [server],
            spTcp: 0,
            srtcp: this.getFirstValue(offer.srtcp, 0),
            srtpMode: this.getLinuxSrtpMode(),
            supportCallBusy: this.getFirstValue(offer.supportCallBusy, 1),
            supportHevcDecode: this.getLinuxHevcDecodeSupport(),
            tpType: this.getFirstValue(offer.tpType, server.tpType || 0),
            video: {
                codec: selectedVideoCodec ? [selectedVideoCodec] : []
            }
        };

        if (offer.fromNoti !== undefined) {
            answer.fromNoti = offer.fromNoti;
        }

        return JSON.stringify(answer);
    }

    buildAnswerServerAddress(offer, rtpAddress, rtcpAddress) {
        const offeredServer = this.findOfferServerAddress(offer, rtpAddress, rtcpAddress) || {};
        return {
            bonus: this.getFirstValue(offeredServer.bonus, 0),
            rtcp: this.getFirstValue(offeredServer.rtcp, offeredServer.rtcpaddr, rtcpAddress, rtpAddress),
            rtcpIPv6: this.getFirstValue(offeredServer.rtcpIPv6, offeredServer.rtcpipv6),
            rtp: this.getFirstValue(offeredServer.rtp, offeredServer.rtpaddr, rtpAddress),
            rtpIPv6: this.getFirstValue(offeredServer.rtpIPv6, offeredServer.rtpipv6),
            tpType: this.getFirstValue(offeredServer.tpType, offer.tpType, 0)
        };
    }

    findOfferServerAddress(offer, rtpAddress, rtcpAddress) {
        const candidates = []
            .concat(Array.isArray(offer.serverAddr) ? offer.serverAddr : [])
            .concat(Array.isArray(offer.serverResult) ? offer.serverResult : []);

        return candidates.find((candidate) => {
            if (!candidate || typeof candidate !== 'object') {
                return false;
            }

            const candidateRtp = this.getFirstValue(candidate.rtp, candidate.rtpaddr);
            const candidateRtcp = this.getFirstValue(candidate.rtcp, candidate.rtcpaddr);
            return candidateRtp === rtpAddress || candidateRtcp === rtcpAddress;
        }) || candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
    }

    hasVideoMedia(...values) {
        return !!this.selectVideoCodec(...values) ||
            values.some((value) => {
                const item = this.parseJsonObject(value);
                const video = item.video && typeof item.video === 'object' ? item.video : null;
                return video && Number(video.enable) === 1;
            });
    }

    isVideoCall(call) {
        return !!(call && (Number(call.callType) === 3 || Number(call.callType) === 6));
    }

    getDefaultVideoCodec() {
        return {
            name: 'h264',
            payload: Number(process.env.ZALO_LINUX_CALL_VIDEO_PAYLOAD || 97)
        };
    }

    getLinuxSrtpMode() {
        // The JavaScript Linux media path can route ZRTC-wrapped RTP, but it does
        // not implement the native SRTP decrypt/encrypt layer from zcall_mac.node.
        // Advertise plain RTP by default so peers do not send encrypted video
        // payloads that GStreamer cannot depayload.
        const configured = Number(process.env.ZALO_LINUX_CALL_SRTP_MODE);
        return Number.isInteger(configured) ? configured : 0;
    }

    getLinuxHevcDecodeSupport() {
        // Keep Linux negotiation on H264 until the receive path has an HEVC
        // decoder/depayloader wired end-to-end.
        const configured = Number(process.env.ZALO_LINUX_CALL_HEVC_DECODE);
        return Number.isInteger(configured) ? configured : 0;
    }

    selectVideoCodec(...values) {
        const codecs = [];
        for (const value of values) {
            codecs.push(...this.collectVideoCodecs(value));
        }

        const normalized = codecs
            .filter((codec) => codec && typeof codec === 'object')
            .map((codec) => Object.assign({}, codec, {
                payload: Number(codec.payload)
            }))
            .filter((codec) => Number.isInteger(codec.payload) && codec.payload >= 0 && codec.payload <= 127);

        if (!normalized.length) {
            return null;
        }

        const explicitPayload = Number(process.env.ZALO_LINUX_CALL_VIDEO_PAYLOAD);
        if (Number.isInteger(explicitPayload)) {
            const explicit = normalized.find((codec) => codec.payload === explicitPayload);
            if (explicit) {
                return explicit;
            }
        }

        return normalized.find((codec) => /h264/i.test(String(codec.name || ''))) ||
            normalized.find((codec) => codec.payload === 97) ||
            normalized[0];
    }

    collectVideoCodecs(value, seen = new WeakSet()) {
        if (!value) {
            return [];
        }

        if (typeof value === 'string') {
            const parsed = this.parseJsonObject(value);
            return Object.keys(parsed).length ? this.collectVideoCodecs(parsed, seen) : [];
        }

        if (Array.isArray(value)) {
            return value.filter((item) => item && typeof item === 'object');
        }

        if (typeof value !== 'object') {
            return [];
        }

        if (seen.has(value)) {
            return [];
        }
        seen.add(value);

        const codecs = [];
        if (value.video && Array.isArray(value.video.codec)) {
            codecs.push(...value.video.codec);
        }

        if (value.extendData || value.extend_data) {
            codecs.push(...this.collectVideoCodecs(value.extendData || value.extend_data, seen));
        }

        if (value.extraData) {
            const extra = this.parseJsonObject(value.extraData);
            codecs.push(...this.collectVideoCodecs(extra.extendData || extra.extend_data || extra, seen));
        }

        if (value.params) {
            codecs.push(...this.collectVideoCodecs(this.parseParams(value.params), seen));
        }

        return codecs;
    }

    unwrapControlData(data) {
        if (!data || typeof data !== 'object') {
            return {};
        }

        if (data.data && typeof data.data === 'object') {
            return data.data;
        }

        return data;
    }

    parseParams(value) {
        if (!value) {
            return {};
        }

        if (typeof value === 'object') {
            return value;
        }

        if (typeof value !== 'string') {
            return {};
        }

        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    buildTransportMediaMode(payload, params, nestedCandidate, extendData) {
        const extend = this.parseJsonObject(extendData);
        const nestedExtend = this.parseJsonObject(
            nestedCandidate && (nestedCandidate.extendData || nestedCandidate.extend_data)
        );
        const zrtcConfig = this.getFirstObject(
            payload && payload.zrtc_config,
            params && params.zrtc_config
        );
        const srtpMode = this.toOptionalNumber(this.getFirstValue(
            extend.srtpMode,
            nestedExtend.srtpMode,
            payload && payload.srtpMode,
            params && params.srtpMode,
            zrtcConfig && zrtcConfig.srtpMode
        ));
        const newZrtc = this.toOptionalNumber(this.getFirstValue(
            extend.newZrtc,
            nestedExtend.newZrtc,
            payload && payload.newZrtc,
            params && params.newZrtc,
            zrtcConfig && zrtcConfig.newZrtc
        ));
        const packetMode = this.toOptionalNumber(this.getFirstValue(
            extend.packetMode,
            nestedExtend.packetMode,
            payload && payload.packetMode,
            params && params.packetMode,
            zrtcConfig && zrtcConfig.packetMode
        ));

        const zrtcMedia = !(srtpMode === 0 && newZrtc === 0);

        return {
            srtpMode,
            newZrtc,
            // Current Linux mapping only sees successful two-way media with
            // packetMode=2 peers. Some outgoing responses omit the field even
            // though the remote later expects short type-4 ZRTC media packets.
            packetMode: packetMode !== undefined ? packetMode : (zrtcMedia ? 2 : undefined),
            zrtcMedia
        };
    }

    parseJsonObject(value) {
        if (!value) {
            return {};
        }

        if (typeof value === 'object' && !Array.isArray(value)) {
            return value;
        }

        if (typeof value !== 'string') {
            return {};
        }

        try {
            const parsed = JSON.parse(value.trim());
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    getFirstObject(...values) {
        for (const value of values) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                return value;
            }
        }

        return {};
    }

    toOptionalNumber(value) {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }

        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }

    getControlStatus(data) {
        const payload = this.unwrapControlData(data);
        const params = this.parseParams(payload.params);
        const status = this.toOptionalNumber(this.getFirstValue(
            payload.status,
            params.status
        ));

        return status === undefined ? null : status;
    }

    isConnectedAnswerControl(data) {
        const status = this.getControlStatus(data);

        if (status === null) {
            return true;
        }

        // Zalo is not consistent across accounts/builds: remote accept may
        // arrive as status 0, while some PC/mobile flows send status 5 after
        // media transport has already been accepted. Treat both as connected so
        // the caller window stops ringing and switches to in-call state.
        const connectedStatuses = this.getConnectedAnswerStatuses();
        return connectedStatuses.includes(status);
    }

    getConnectedAnswerStatuses() {
        const list = process.env.ZALO_CALL_CONNECTED_ANSWER_STATUSES;
        if (list) {
            return list
                .split(',')
                .map((value) => this.toOptionalNumber(value.trim()))
                .filter((value) => value !== undefined);
        }

        const single = this.toOptionalNumber(process.env.ZALO_CALL_CONNECTED_ANSWER_STATUS);
        if (single !== undefined) {
            return [single];
        }

        return [0, 5];
    }

    collectIds(...values) {
        const ids = [];
        for (const value of values) {
            if (value === undefined || value === null || value === '') {
                continue;
            }

            ids.push(String(value));
        }

        return ids;
    }

    getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return undefined;
    }

    unwrapSignalData(data) {
        if (!data || typeof data !== 'object') {
            return {};
        }

        if (
            data.data &&
            typeof data.data === 'object' &&
            !data.rtpIP &&
            !data.rtcpIP &&
            !data.sessId
        ) {
            return data.data;
        }

        return data;
    }

    findTransportCandidate(input) {
        // Breadth-first search avoids coupling to one minified bundle shape.
        const queue = [input];
        while (queue.length) {
            const value = queue.shift();
            if (!value) continue;
            if (Array.isArray(value)) {
                queue.push(...value);
                continue;
            }
            if (typeof value !== 'object') continue;

            const rtpAddress = value.rtpAddress || value.rtpaddr || value.rtpIP || value.rtp_ip;
            const rtcpAddress = value.rtcpAddress || value.rtcpaddr || value.rtcpIP || value.rtcp_ip;
            if (rtpAddress && rtcpAddress) {
                return {
                    rtpAddress,
                    rtcpAddress,
                    codec: value.codec,
                    extendData: value.extendData || value.extend_data,
                    session: value.session || value.session_id || value.sessionId
                };
            }

            queue.push(...Object.values(value));
        }

        return null;
    }

    buildPopup(header, content) {
        return {
            type: 'request',
            command: 'popup',
            data: { header, content }
        };
    }

    buildCallState(state, extra = {}) {
        this.emitNativeCallState(state, extra);
        return {
            type: 'update',
            command: 'callState',
            data: Object.assign({ state }, extra)
        };
    }

    handleLocalMediaControl(data) {
        if (!data || data.act_type !== 'voip') {
            return false;
        }

        switch (data.act) {
            case 'mute_audio':
                this.localState.audioMuted = true;
                this.emitNativeEvent('onCallAudioState', { state: '0' });
                return true;
            case 'unmute_audio':
                this.localState.audioMuted = false;
                this.emitNativeEvent('onCallAudioState', { state: '1' });
                return true;
            case 'hold_audio':
                this.localState.audioHeld = true;
                this.emitNativeEvent('onCallAudioState', { state: '2' });
                return true;
            case 'resume_audio':
                this.localState.audioHeld = false;
                this.emitNativeEvent('onCallAudioState', { state: '1' });
                return true;
            case 'stop_capture':
                this.localState.captureStopped = true;
                this.emitCallVideoState(VIDEO_STATE.LOCAL_OFF);
                return true;
            case 'start_capture':
                this.localState.captureStopped = false;
                this.emitCallVideoState(VIDEO_STATE.LOCAL_ON);
                return true;
            default:
                return false;
        }
    }

    changeAudioDevice(inputId, outputId) {
        this.localState.defaultAudInputDevice = inputId;
        this.localState.defaultAudOutputDevice = outputId;
        this.record('changeAudioDevice', { inputId, outputId });
    }

    changeVideoDevice(id) {
        this.localState.defaultVidDevice = id;
        if (this.mediaEngine && typeof this.mediaEngine.setVideoDevice === 'function') {
            this.mediaEngine.setVideoDevice(id);
        }
        this.record('changeVideoDevice', { id });
    }

    setAudioVolume(input, output) {
        this.localState.audioInputVolume = input;
        this.localState.audioOutputVolume = output;
        this.record('setAudioVolume', { input, output });
        return true;
    }

    setAgc(auto) {
        this.localState.autoGainControl = !!auto;
        this.record('setAgc', { auto: !!auto });
    }

    startDesktopCapture() {
        this.localState.desktopCapture = true;
        if (this.mediaEngine && typeof this.mediaEngine.setDesktopCapture === 'function') {
            this.mediaEngine.setDesktopCapture(true);
        }
        if (!this.currentCall || this.isVideoCall(this.currentCall)) {
            this.emitCallVideoState(VIDEO_STATE.LOCAL_ON);
        }
        this.record('startDesktopCapture', {});
    }

    stopDesktopCapture() {
        this.localState.desktopCapture = false;
        if (this.mediaEngine && typeof this.mediaEngine.setDesktopCapture === 'function') {
            this.mediaEngine.setDesktopCapture(false);
        }
        this.emitCallVideoState(VIDEO_STATE.LOCAL_OFF);
        this.record('stopDesktopCapture', {});
    }

    upgradeToVideoCall(options = {}) {
        const call = this.currentCall;
        if (!call) {
            this.emitCallVideoState(VIDEO_STATE.LOCAL_OFF);
            return [this.buildCallState('free', { reason: 'upgrade-video-no-call' })];
        }

        const transport = call.transportConfig || {};
        const rtpAddress = this.getFirstValue(transport.rtpAddress, options.rtpAddress, options.rtpIP);
        const rtcpAddress = this.getFirstValue(transport.rtcpAddress, options.rtcpAddress, options.rtcpIP, rtpAddress);
        const videoCodec = this.selectVideoCodec(options, transport, options.extendData) ||
            transport.videoCodec ||
            this.getDefaultVideoCodec();
        const mediaMode = {
            zrtcMedia: transport.zrtcMedia,
            srtpMode: transport.srtpMode,
            newZrtc: transport.newZrtc,
            packetMode: transport.packetMode
        };
        const extendData = call.incoming ?
            this.buildIncomingAnswerExtendData(
                this.getFirstValue(options.extendData, transport.extendData, '{}'),
                rtpAddress,
                rtcpAddress,
                mediaMode,
                videoCodec
            ) :
            this.buildOutgoingExtendData(
                Object.assign({}, transport.zrtcConfig ? { zrtc_config: transport.zrtcConfig } : {}),
                rtpAddress,
                rtcpAddress,
                mediaMode,
                videoCodec
            );

        call.callType = 3;
        call.transportConfig = Object.assign({}, transport, {
            rtpAddress,
            rtcpAddress,
            videoEnabled: true,
            videoCodec,
            extendData
        });
        this.currentMediaState = null;
        this.localState.captureStopped = false;
        this.emitCallVideoState(VIDEO_STATE.LOCAL_ON);
        this.emitCallChangeZRTP(0, {
            rtpAddress,
            rtcpAddress,
            session: call.transportConfig.session
        });
        this.record('upgradeToVideoCall', {
            callId: call.callId,
            rtpAddress,
            rtcpAddress,
            videoCodec,
            mediaActive: this.mediaEngine.active
        });

        const upgradeSignal = this.buildVideoUpgradeSignal(call);

        if (!this.mediaEngineEnabled) {
            return [
                upgradeSignal,
                this.buildCallState('calling', {
                    callId: call.callId,
                    reason: 'upgrade-video-without-media-engine',
                    stage: 'video-enabled'
                })
            ].filter(Boolean);
        }

        if (this.mediaEngine.active) {
            this.mediaEngine.stop();
        }

        return [
            upgradeSignal,
            ...this.startMediaCall('upgrade-to-video')
        ].filter(Boolean);
    }

    buildVideoUpgradeSignal(call) {
        if (!call || !call.transportConfig) {
            return null;
        }

        const transport = call.transportConfig;
        if (!transport.rtpAddress || !transport.rtcpAddress || !transport.session) {
            return null;
        }

        const signal = {
            type: 'sendSignal',
            command: SIGNAL_COMMAND.REQUEST_TRANSPORT,
            data: {
                calleeId: this.getCallControlPeerId(call),
                callId: call.callId,
                rtcpAddress: transport.rtcpAddress,
                rtpAddress: transport.rtpAddress,
                codec: transport.codec || this.getAudioCodec(),
                extendData: transport.extendData || '',
                session: transport.session,
                video: { enable: 1 }
            }
        };

        this.record('sendSignal', {
            command: signal.command,
            data: signal.data,
            reason: 'upgrade-to-video'
        });

        return signal;
    }

    changeMinMaxMobileBitrate(minBitrate, maxBitrate) {
        this.localState.minMobileBitrate = minBitrate;
        this.localState.maxMobileBitrate = maxBitrate;
        this.record('changeMinMaxMobileBitrate', { minBitrate, maxBitrate });
    }

    setConfiguredTransport(config = {}) {
        const next = {
            rtpAddress: this.getFirstValue(config.rtpAddress, config.rtpIP),
            rtcpAddress: this.getFirstValue(config.rtcpAddress, config.rtcpIP, config.rtpAddress, config.rtpIP),
            session: this.getFirstValue(config.session, config.sessId),
            codec: config.codec,
            extendData: config.extendData,
            callId: config.callId
        };

        this.localState.configuredTransport = Object.assign(
            {},
            this.localState.configuredTransport || {},
            next
        );

        if (this.currentCall) {
            this.currentCall.transportConfig = Object.assign(
                {},
                this.currentCall.transportConfig || {},
                next
            );
        }

        if (this.currentCall && next.rtpAddress && next.rtcpAddress) {
            this.emitInitZrtpWithServer(next.rtcpAddress, next.rtpAddress);
        }

        this.record('setConfiguredTransport', next);
    }

    setMediaConfig(audioConfig, extendData) {
        this.localState.mediaConfig = { audioConfig, extendData };

        if (this.currentCall) {
            this.currentCall.transportConfig = Object.assign(
                {},
                this.currentCall.transportConfig || {},
                {
                    codec: audioConfig || this.currentCall.transportConfig && this.currentCall.transportConfig.codec,
                    extendData
                }
            );
        }

        this.record('setMediaConfig', { hasAudioConfig: !!audioConfig, hasExtendData: !!extendData });
    }

    updateCallerInfo(audioConfig, extendData) {
        this.setMediaConfig(audioConfig, extendData);
        const transport = this.currentCall && this.currentCall.transportConfig || this.localState.configuredTransport || {};
        this.emitCallChangeZRTP(0, {
            rtpAddress: transport.rtpAddress,
            rtcpAddress: transport.rtcpAddress,
            session: transport.session
        });
    }

    emitInitZrtpWithServer(rtcpAddress, rtpAddress) {
        if (!rtcpAddress || !rtpAddress) {
            this.emitNativeEvent('onInitZrtpRequestFailed', { retCode: '-1' });
            return;
        }

        this.emitNativeEvent('onInitZrtpWithServer', {
            rtcp: String(rtcpAddress),
            rtp: String(rtpAddress)
        });
    }

    emitCallChangeZRTP(retCode, data = {}) {
        this.emitNativeEvent('onCallChangeZRTP', {
            retCode: String(retCode),
            rtpAddr: String(data.rtpAddress || data.rtpAddr || ''),
            rtcpAddr: String(data.rtcpAddress || data.rtcpAddr || ''),
            sessionId: String(data.session || data.sessionId || '')
        });
    }

    emitCallQualityChanged(quality) {
        this.emitNativeEvent('onCallQualityChanged', {
            quality: String(quality)
        });
    }

    emitCallVideoState(state) {
        const numeric = Number(state);
        if (
            numeric !== VIDEO_STATE.LOCAL_ON &&
            numeric !== VIDEO_STATE.LOCAL_OFF &&
            numeric !== VIDEO_STATE.REMOTE_ON &&
            numeric !== VIDEO_STATE.REMOTE_OFF
        ) {
            return;
        }

        this.emitNativeEvent('onCallVideoState', {
            state: String(numeric)
        });
    }

    getCallInfo() {
        const call = this.currentCall || {};
        return {
            callId: call.callId || null,
            peerId: this.getCallControlPeerId(call) || null,
            direction: call.incoming ? 'incoming' : (call.callId ? 'outgoing' : null),
            state: call.state || (this.callRunning ? 'calling' : 'free'),
            callType: call.callType || null,
            startedAt: call.startedAt || null,
            answeredAt: call.answeredAt || null,
            media: this.currentMediaState || null,
            local: this.localState || {}
        };
    }

    getJsonStats406(startNetworkType = 0, endNetworkType = 0) {
        return {
            platform: 'linux',
            startNetworkType,
            endNetworkType,
            call: this.getCallInfo(),
            media: this.getMediaActivitySummary(),
            ts: Date.now()
        };
    }

    getExtendData() {
        const transport = this.currentCall && this.currentCall.transportConfig;
        return transport && transport.extendData ? transport.extendData : {};
    }

    emitNativeCallState(state, extra = {}) {
        this.emitNativeEvent('onCallState', {
            state: String(this.mapNativeCallState(state, extra))
        });
    }

    mapNativeCallState(state, extra = {}) {
        if (state === 'free') {
            return 0;
        }

        if (
            state === 'connected' ||
            extra.stage === 'media-running' ||
            extra.stage === 'media-started' ||
            extra.stage === 'remote-answer' ||
            extra.stage === 'incoming-answer' ||
            extra.stage === 'request-accepted'
        ) {
            return 3;
        }

        if (extra.direction === 'incoming' || extra.stage === 'incoming-request') {
            return 2;
        }

        return 1;
    }

    emitNativeEvent(type, data = {}) {
        const event = Object.assign({ type }, data);
        this.record('nativeEvent', event);
        if (this.nativeEventsEnabled) {
            this.nativeEventQueue.push(event);
        }
    }

    drainNativeEvents() {
        return this.nativeEventQueue.splice(0);
    }

    shutdown() {
        this.clearConnectedRemoteSilenceWatchdog();
        this.mediaEngine.stop();
        this.callWindow.close();
        this.emitNativeCallState('free', { reason: 'shutdown' });
    }

    createCallId() {
        return String(100000000 + crypto.randomInt(900000000));
    }

    createOutgoingCallId(data = {}) {
        if (process.env.ZALO_LINUX_CALL_TRUST_CONFIG_CALL_ID === '1' && data.callId) {
            this.lastOutgoingCallId = String(data.callId);
            return this.lastOutgoingCallId;
        }

        let callId = this.createCallId();
        while (callId === this.lastOutgoingCallId || (data.callId && callId === String(data.callId))) {
            callId = this.createCallId();
        }

        if (data.callId && String(data.callId) !== callId) {
            this.record('outgoingCallIdReplaced', {
                providedCallId: String(data.callId),
                callId
            });
        }

        this.lastOutgoingCallId = callId;
        return callId;
    }

    getAudioCodec() {
        const codecs = [
            {
                frmPtime: 20,
                payload: 112,
                name: 'opus/16000/1',
                dynamicFptime: 0
            },
            {
                frmPtime: 20,
                payload: 113,
                name: 'opus/48000/2',
                dynamicFptime: 0
            }
        ];
        const explicitPayload = Number(process.env.ZALO_LINUX_CALL_AUDIO_PAYLOAD);

        // Linux uplink has been verified with mono/16 kHz payload 112. Keep it
        // first so peers answer with the codec our GStreamer pipeline encodes.
        if (Number.isInteger(explicitPayload)) {
            codecs.sort((left, right) => {
                if (Number(left.payload) === explicitPayload) return -1;
                if (Number(right.payload) === explicitPayload) return 1;
                return 0;
            });
        }

        return JSON.stringify(codecs);
    }

    selectAudioCodec(...values) {
        const offered = [];

        for (const value of values) {
            offered.push(...this.parseCodecList(value));
        }

        const selected = this.pickPreferredAudioCodec(offered);
        return JSON.stringify([selected || {
            frmPtime: 20,
            payload: 112,
            name: 'opus/16000/1',
            dynamicFptime: 0
        }]);
    }

    pickPreferredAudioCodec(codecs) {
        const normalized = (codecs || [])
            .filter((codec) => codec && typeof codec === 'object')
            .map((codec) => Object.assign({}, codec, {
                payload: Number(codec.payload)
            }))
            .filter((codec) => Number.isInteger(codec.payload) && /opus\//i.test(String(codec.name || '')));

        if (!normalized.length) {
            return null;
        }

        const explicitPayload = Number(process.env.ZALO_LINUX_CALL_AUDIO_PAYLOAD);
        if (Number.isInteger(explicitPayload)) {
            const explicit = normalized.find((codec) => codec.payload === explicitPayload);
            if (explicit) {
                return explicit;
            }
        }

        return normalized.find((codec) => codec.payload === 112) ||
            normalized.find((codec) => /opus\/16000\/1/i.test(String(codec.name || ''))) ||
            normalized.find((codec) => codec.payload === 113) ||
            normalized[0];
    }

    parseCodecList(value) {
        if (!value) {
            return [];
        }

        if (Array.isArray(value)) {
            return value;
        }

        if (typeof value === 'object') {
            return [value];
        }

        if (typeof value !== 'string') {
            return [];
        }

        try {
            const parsed = JSON.parse(value.trim());
            return Array.isArray(parsed) ? parsed : [parsed];
        } catch (_) {
            return [];
        }
    }

    record(event, data) {
        const entry = {
            ts: new Date().toISOString(),
            event,
            data
        };
        try {
            fs.appendFileSync(this.protocolLogPath, `${JSON.stringify(entry)}\n`);
        } catch (_) {}
    }
}

module.exports = LinuxCallEngine;
