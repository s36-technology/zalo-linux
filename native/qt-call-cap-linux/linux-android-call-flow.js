'use strict';

// Port of zalo_android/app/src/main/java/j62/i0.java call-session state flow.
// Keep this file limited to rules visible in i0.java. Linux IPC/window/media
// side effects stay in linux-call-engine.js.

const AndroidCallState = Object.freeze({
    // i0.G() reset and default f76519b = 0.
    FREE: 0,
    // i0.D(): VOICE_REQUEST_CALL 401 sets f76519b = 1.
    READY_REQUEST: 1,
    // i0.E(): makeCallCommand sets f76519b = 2.
    OUTGOING_INIT: 2,
    // i0.D(): IncomingCallCommand sets f76519b = 3.
    INCOMING_INIT: 3,
    // i0.p(): AnswerCallResponse 402/status=0 sets f76519b = 4.
    WAIT_ANSWER_ACK: 4,
    // i0.F(): 416 sets f76519b = 5.
    WAIT_TRANSPORT: 5,
    // i0.y(): 409 while state 5 sets f76519b = 6 before cleanup.
    ENDING: 6,
    // i0.h(): confirmed/established sets f76519b = 7.
    CONFIRMED: 7,
    // i0.o(): 409 while state 7 sets f76519b = 8 before cleanup.
    ENDED: 8
});

const AndroidSignal = Object.freeze({
    MEDIA_CONNECTED: 300,
    REQUEST_CALL: 401,
    ANSWER_INCOMING: 402,
    CANCEL_CALL: 405,
    END_CALL_LOG: 406,
    RINGING: 407,
    ANSWER_ACK: 408,
    END_CALL: 409,
    HOLD_REQUEST: 411,
    UNHOLD_REQUEST: 413,
    NETWORK_PROGRESS: 415,
    REQUEST_TRANSPORT: 416,
    REQUEST_CHANGE_ZRTP: 417,
    CHANGE_ZRTP: 418,
    CHANGE_ZRTP_ACK: 419,
    PARTNER_CAMERA: 421,
    VIDEO_QUALITY: 443,
    UNKNOWN_444: 444,
    UNKNOWN_412: 412,
    UNKNOWN_447: 447,
    UNKNOWN_432: 432,
    UNKNOWN_433: 433,
    UNKNOWN_448: 448,
    UNKNOWN_449: 449
});

function isOutgoingAnswerConfirmedStatus(status) {
    // i0.y(): AnswerCallResponse responseCode == 0 -> update caller info;
    // on success h(true).
    return status === 0;
}

function isOutgoingAnswerFailureStatus(status) {
    // i0.y(): responseCode 1/3/5/6 maps to errors and n().
    return status === 1 || status === 3 || status === 5 || status === 6;
}

function isTerminalSignal(command) {
    // i0 handles 409 as terminal in D/E/F/p/q/y/o and 405 in q/o.
    return command === AndroidSignal.END_CALL ||
        command === AndroidSignal.CANCEL_CALL;
}

function transitionCall(call, nextState, reason, record) {
    if (!call) {
        return;
    }

    const previousState = call.androidState;
    call.androidState = nextState;
    if (previousState !== nextState && typeof record === 'function') {
        record('androidCallState', {
            callId: call.callId,
            from: previousState,
            to: nextState,
            reason
        });
    }
}

function reduceRecvSignal({ call, command, status, subCode }) {
    if (!call) {
        return { type: 'ignore', reason: 'no-call' };
    }

    switch (call.androidState) {
        case AndroidCallState.FREE:
            return reduceReadyForCallState({ command });
        case AndroidCallState.READY_REQUEST:
            return reduceReadyRequestState({ command });
        case AndroidCallState.OUTGOING_INIT:
            return reduceOutgoingInitState({ command, status });
        case AndroidCallState.INCOMING_INIT:
            return reduceIncomingInitState({ command, status, subCode });
        case AndroidCallState.WAIT_ANSWER_ACK:
            return reduceWaitAnswerAckState({ command, subCode });
        case AndroidCallState.WAIT_TRANSPORT:
            return reduceWaitTransportState({ command, status, subCode });
        case AndroidCallState.CONFIRMED:
            return reduceConfirmedState({ command });
        default:
            return reduceCommonTerminalSignal({ command });
    }
}

function reduceCommonTerminalSignal({ command }) {
    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', reason: 'signal-409' };
    }

    if (command === AndroidSignal.CANCEL_CALL) {
        return { type: 'remote-end', reason: 'signal-405' };
    }

    return { type: 'ignore', reason: 'unhandled-command' };
}

function reduceReadyForCallState({ command }) {
    // i0.D(): 401 initializes native peer; incoming command is handled through
    // handleIncomingRequest/buildIncomingCall before currentCall exists.
    if (command === AndroidSignal.REQUEST_CALL) {
        return { type: 'ready-request', nextState: AndroidCallState.READY_REQUEST };
    }

    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', reason: 'ready-for-call-409' };
    }

    return { type: 'ignore', reason: 'D-unhandled-command' };
}

function reduceReadyRequestState({ command }) {
    // i0.E(): makeCallCommand is local app input. In Linux the 401 response is
    // the point where the adapter has enough data to synthesize that local
    // makeCallCommand and move to state 2.
    if (command === AndroidSignal.REQUEST_CALL) {
        return { type: 'request-call-response', nextState: AndroidCallState.OUTGOING_INIT };
    }

    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', reason: 'ready-request-409' };
    }

    return { type: 'ignore', reason: 'E-unhandled-command' };
}

function reduceOutgoingInitState({ command, status }) {
    // i0.F(): 416 moves caller into state 5 and sends R1/request transport.
    if (command === AndroidSignal.REQUEST_TRANSPORT) {
        return { type: 'transport-accepted', nextState: AndroidCallState.WAIT_TRANSPORT };
    }

    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', reason: 'outgoing-init-409' };
    }

    if (status === 5) {
        return { type: 'remote-end', reason: 'outgoing-init-m0-status-5' };
    }

    return { type: 'ignore', reason: 'F-unhandled-command' };
}

function reduceIncomingInitState({ command, status, subCode }) {
    // i0.p(): answer response 402/status=0 moves to state 4.
    if (command === AndroidSignal.ANSWER_INCOMING) {
        return { type: 'incoming-answer-response' };
    }

    if (command === AndroidSignal.RINGING) {
        if (subCode === 4070) {
            return { type: 'native-call-state', state: 3, reason: 'incoming-ring-4070' };
        }

        if (subCode === -4070) {
            return { type: 'retry-ring', reason: 'incoming-ring-retry--4070' };
        }

        return { type: 'incoming-ring', reason: 'incoming-ring-407' };
    }

    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', reason: 'incoming-init-409' };
    }

    if (command === AndroidSignal.VIDEO_QUALITY) {
        return { type: 'android-event', reason: 'incoming-video-quality-443' };
    }

    if (status === 5) {
        return { type: 'remote-end', reason: 'incoming-init-m0-status-5' };
    }

    return { type: 'ignore', reason: 'p-unhandled-command' };
}

function reduceWaitAnswerAckState({ command, subCode }) {
    // i0.q(): 408 establishes incoming answer.
    if (command === AndroidSignal.ANSWER_ACK) {
        return { type: 'incoming-answer-ack' };
    }

    if (command === AndroidSignal.END_CALL || command === AndroidSignal.CANCEL_CALL) {
        return { type: 'remote-end', reason: command === AndroidSignal.END_CALL ? 'wait-answer-409' : 'wait-answer-405' };
    }

    if (command === AndroidSignal.ANSWER_INCOMING && subCode === -4020) {
        return { type: 'retry-answer', reason: 'answer-response-retry--4020' };
    }

    if (command === AndroidSignal.RINGING && subCode === 4070) {
        return { type: 'native-call-state', state: 3, reason: 'wait-answer-ring-4070' };
    }

    return { type: 'ignore', reason: 'q-unhandled-command' };
}

function reduceWaitTransportState({ command, status, subCode }) {
    // i0.y(): 415/407/4160 are progress/ringing; 300 or answer status 0
    // establishes; 409 ends; -4080/-4160 retry via e1 timers.
    if (command === AndroidSignal.NETWORK_PROGRESS) {
        return { type: 'android-progress', reason: status === 1 ? 'network-progress-audio' : 'network-progress-video' };
    }

    if (command === AndroidSignal.RINGING) {
        return { type: 'outgoing-ring', reason: 'outgoing-ring-407' };
    }

    if (command === AndroidSignal.ANSWER_INCOMING) {
        return reduceOutgoingAnswerControl(status);
    }

    if (command === AndroidSignal.ANSWER_ACK) {
        if (subCode === 4080) {
            return { type: 'android-progress', reason: 'answer-ack-4080' };
        }

        if (subCode === -4080) {
            return { type: 'retry-answer-ack', reason: 'answer-ack-retry--4080' };
        }

        return { type: 'android-progress', reason: 'answer-ack-408' };
    }

    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', nextState: AndroidCallState.ENDING, reason: 'wait-transport-409' };
    }

    if (command === AndroidSignal.REQUEST_TRANSPORT) {
        if (subCode === 4160) {
            return { type: 'android-progress', reason: 'transport-progress-4160' };
        }

        if (subCode === -4160) {
            return { type: 'retry-transport', reason: 'transport-retry--4160' };
        }

        return { type: 'transport-accepted', nextState: AndroidCallState.WAIT_TRANSPORT };
    }

    if (command === AndroidSignal.MEDIA_CONNECTED) {
        return { type: 'answer-confirmed', nextState: AndroidCallState.CONFIRMED };
    }

    return { type: 'ignore', reason: 'y-unhandled-command' };
}

function reduceConfirmedState({ command }) {
    if (command === AndroidSignal.END_CALL) {
        return { type: 'remote-end', nextState: AndroidCallState.ENDED, reason: 'confirmed-409' };
    }

    if (command === AndroidSignal.CANCEL_CALL) {
        return { type: 'remote-end', reason: 'confirmed-405' };
    }

    if (command === AndroidSignal.HOLD_REQUEST || command === AndroidSignal.UNHOLD_REQUEST) {
        return { type: 'hold' };
    }

    if (
        command === AndroidSignal.REQUEST_CHANGE_ZRTP ||
        command === AndroidSignal.CHANGE_ZRTP ||
        command === AndroidSignal.CHANGE_ZRTP_ACK
    ) {
        return { type: 'change-zrtp' };
    }

    if (
        command === AndroidSignal.PARTNER_CAMERA ||
        command === AndroidSignal.VIDEO_QUALITY ||
        command === AndroidSignal.UNKNOWN_444 ||
        command === AndroidSignal.UNKNOWN_412 ||
        command === AndroidSignal.UNKNOWN_447 ||
        command === AndroidSignal.UNKNOWN_432 ||
        command === AndroidSignal.UNKNOWN_433 ||
        command === AndroidSignal.UNKNOWN_448 ||
        command === AndroidSignal.UNKNOWN_449
    ) {
        return { type: 'android-event', reason: `confirmed-event-${command}` };
    }

    return { type: 'ignore', reason: 'o-unhandled-command' };
}

function reduceOutgoingAnswerControl(status) {
    if (isOutgoingAnswerFailureStatus(status)) {
        return { type: 'answer-failed' };
    }

    if (isOutgoingAnswerConfirmedStatus(status)) {
        return { type: 'answer-confirmed', nextState: AndroidCallState.CONFIRMED };
    }

    return { type: 'answer-ignored' };
}

function reduceIncomingAnswerResponse(status) {
    if (Number.isFinite(status) && status !== 0) {
        return { type: 'incoming-answer-failed', nextState: AndroidCallState.ENDING };
    }

    return { type: 'incoming-answer-accepted', nextState: AndroidCallState.WAIT_ANSWER_ACK };
}

function reduceIncomingAnswerRequest({ call, hasTransport, mediaEngineEnabled, mediaActive }) {
    if (!call || !call.incoming) {
        return { type: 'ignore', reason: 'not-incoming-call' };
    }

    if (!hasTransport) {
        return { type: 'missing-transport' };
    }

    if (call.answeredAt) {
        if (!mediaEngineEnabled) {
            return { type: 'ignore', reason: 'answered-without-media-engine' };
        }

        return mediaActive ?
            { type: 'confirmed-update-media' } :
            { type: 'confirmed-start-media', reason: 'incoming-answer-confirmed' };
    }

    if (!mediaEngineEnabled) {
        return { type: 'unsupported-media', reason: 'incoming-answer-without-media-engine' };
    }

    if (call.incomingAnswerAckPending) {
        return mediaActive ?
            { type: 'waiting-ack-update-media' } :
            { type: 'waiting-ack-start-media', reason: 'incoming-answer-waiting-ack' };
    }

    return {
        type: 'send-answer',
        nextState: AndroidCallState.WAIT_ANSWER_ACK,
        reason: 'incoming-answer-send-402'
    };
}

function reduceHoldSignal({ command }) {
    if (command === AndroidSignal.HOLD_REQUEST) {
        // i0.o(): 411 -> PeerJNI.zrtc_peer_hold_audio(peer, true, true).
        return {
            type: 'remote-hold-audio',
            held: true,
            nativeAudioState: '2',
            reason: 'remote-hold-audio'
        };
    }

    if (command === AndroidSignal.UNHOLD_REQUEST) {
        // i0.o(): 413 -> PeerJNI.zrtc_peer_hold_audio(peer, false, true).
        return {
            type: 'remote-hold-audio',
            held: false,
            nativeAudioState: '1',
            reason: 'remote-resume-audio'
        };
    }

    return { type: 'ignore', reason: 'not-hold-signal' };
}

function reduceChangeZrtpSignal({ command, hasTransport }) {
    if (
        command !== AndroidSignal.REQUEST_CHANGE_ZRTP &&
        command !== AndroidSignal.CHANGE_ZRTP &&
        command !== AndroidSignal.CHANGE_ZRTP_ACK
    ) {
        return { type: 'ignore', reason: 'not-change-zrtp-signal' };
    }

    if (!hasTransport) {
        // i0.o(): k0 without session/address arrays returns false.
        return { type: 'change-zrtp-missing-transport' };
    }

    return {
        type: 'change-zrtp-apply',
        // Android receives 418/419 and calls PeerJNI. Linux still has to ACK
        // the request-form 418 because this wrapper replaces PeerJNI signaling.
        shouldAck: command === AndroidSignal.CHANGE_ZRTP
    };
}

function reduceRemoteRingControl({ call, isRingControl, callIdMismatch }) {
    if (!isRingControl) {
        return { type: 'not-ring-control' };
    }

    if (!call || call.incoming) {
        return { type: 'ignore', reason: 'no-outgoing-call' };
    }

    if (callIdMismatch) {
        return { type: 'ignore', reason: 'call-id-mismatch' };
    }

    // i0.y(): 407 updates caller ringring while staying in state 5.
    return { type: 'remote-ring-ring' };
}

function reduceLocalEnd({ call }) {
    if (!call) {
        return { type: 'local-end-no-call' };
    }

    const shouldSendEndCall =
        call.androidState === AndroidCallState.WAIT_ANSWER_ACK ||
        call.androidState === AndroidCallState.WAIT_TRANSPORT ||
        call.androidState === AndroidCallState.CONFIRMED ||
        call.answeredAt;

    if (shouldSendEndCall) {
        // Android connected/connecting terminal path uses 409 then cleanup.
        // i0.y() state 5 sets f76519b = 6; i0.o() state 7 sets f76519b = 8.
        return {
            type: 'send-local-end',
            command: AndroidSignal.END_CALL,
            nextState: call.androidState === AndroidCallState.CONFIRMED ?
                AndroidCallState.ENDED :
                AndroidCallState.ENDING,
            reason: 'local-end-409'
        };
    }

    // Pending unanswered calls are canceled with 405.
    return {
        type: 'send-local-end',
        command: AndroidSignal.CANCEL_CALL,
        nextState: AndroidCallState.ENDING,
        reason: 'local-cancel-405'
    };
}

module.exports = {
    AndroidCallState,
    AndroidSignal,
    isOutgoingAnswerConfirmedStatus,
    isOutgoingAnswerFailureStatus,
    isTerminalSignal,
    transitionCall,
    reduceRecvSignal,
    reduceOutgoingAnswerControl,
    reduceIncomingAnswerResponse,
    reduceIncomingAnswerRequest,
    reduceHoldSignal,
    reduceChangeZrtpSignal,
    reduceRemoteRingControl,
    reduceLocalEnd
};
