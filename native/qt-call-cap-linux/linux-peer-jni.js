'use strict';

const crypto = require('crypto');
const LinuxCallEngine = require('./linux-call-engine');

class LinuxPeerJNI {
    constructor(options = {}) {
        this.engine = new LinuxCallEngine(options);
        this.engine.peerJni = this;
        this.latestCallConfig = {};
        this.nextNativeHandle = 2;
        this.peerHandle = 1;
        this.peerState = {};
        this.peerJniSeq = 0;
        this.peerHandles = new Map([[this.peerHandle, this.peerState]]);
        this.callConfigs = new Map();
        this.mediaCodecInfos = new Map();
    }

    zrtc_call_config_create() {
        const handle = this.#createNativeHandle(this.callConfigs, {});
        this.#recordPeerJniCall('zrtc_call_config_create', { handle });
        return handle;
    }

    zrtc_call_config_delete(handle) {
        const nativeHandle = Number(handle) || 0;
        const deleted = this.callConfigs.delete(nativeHandle);
        this.#recordPeerJniCall('zrtc_call_config_delete', {
            handle: nativeHandle,
            deleted
        });
    }

    zrtc_call_config_set_app_demo(handle, value) {
        this.#setCallConfig(handle, 'appDemo', !!value, 'zrtc_call_config_set_app_demo');
    }

    zrtc_call_config_set_client_version(handle, value) {
        this.#setCallConfig(handle, 'clientVersion', Number(value) || 0, 'zrtc_call_config_set_client_version');
    }

    zrtc_call_config_set_config_json(handle, value) {
        this.#setCallConfig(handle, 'configJson', value || '', 'zrtc_call_config_set_config_json');
        this.#mergeJsonCallConfig(handle, value);
    }

    zrtc_call_config_set_enable_change_ZRTP(handle, value) {
        this.#setCallConfig(handle, 'enableChangeZRTP', !!value, 'zrtc_call_config_set_enable_change_ZRTP');
    }

    zrtc_call_config_set_extra_info(handle, value) {
        this.#setCallConfig(handle, 'extraInfo', value || '', 'zrtc_call_config_set_extra_info');
    }

    zrtc_call_config_set_fec_type(handle, value) {
        this.#setCallConfig(handle, 'fecType', Number(value) || 0, 'zrtc_call_config_set_fec_type');
    }

    zrtc_call_config_set_log_stat_filename(handle, value) {
        this.#setCallConfig(handle, 'logStatFilename', value || '', 'zrtc_call_config_set_log_stat_filename');
    }

    zrtc_call_config_set_loopback_mode(handle, value) {
        this.#setCallConfig(handle, 'loopbackMode', Number(value) || 0, 'zrtc_call_config_set_loopback_mode');
    }

    zrtc_call_config_set_os_info(handle, value) {
        this.#setCallConfig(handle, 'osInfo', value || '', 'zrtc_call_config_set_os_info');
    }

    zrtc_call_config_set_partner_id(handle, value) {
        this.#setCallConfig(handle, 'partnerId', value, 'zrtc_call_config_set_partner_id');
        this.#setCallConfig(handle, 'calleeId', value);
    }

    zrtc_call_config_set_permission_start_camera(handle, value) {
        this.#setCallConfig(handle, 'permissionStartCamera', !!value, 'zrtc_call_config_set_permission_start_camera');
    }

    zrtc_call_config_set_protocol(handle, value) {
        this.#setCallConfig(handle, 'protocol', Number(value) || 0, 'zrtc_call_config_set_protocol');
    }

    zrtc_call_config_set_protocol_type(handle, value) {
        this.#setCallConfig(handle, 'protocolType', Number(value) || 0, 'zrtc_call_config_set_protocol_type');
    }

    zrtc_call_config_set_session(handle, value) {
        this.#setCallConfig(handle, 'session', value || '', 'zrtc_call_config_set_session');
    }

    zrtc_call_config_set_spectrum_file_path(handle, value) {
        this.#setCallConfig(handle, 'spectrumFilePath', Array.isArray(value) ? value.slice() : [], 'zrtc_call_config_set_spectrum_file_path');
    }

    zrtc_call_config_set_support_video_call(handle, value) {
        this.#setCallConfig(handle, 'supportVideoCall', !!value, 'zrtc_call_config_set_support_video_call');
    }

    zrtc_call_config_set_user_id(handle, value) {
        this.#setCallConfig(handle, 'userId', value, 'zrtc_call_config_set_user_id');
        this.#setCallConfig(handle, 'callerId', value);
    }

    zrtc_call_config_set_video_call(handle, value) {
        this.#setCallConfig(handle, 'videoCall', !!value, 'zrtc_call_config_set_video_call');
        this.#setCallConfig(handle, 'callType', value ? 'video' : 'audio');
    }

    zrtc_call_config_set_zalo_call_id(handle, value) {
        this.#setCallConfig(handle, 'callId', value, 'zrtc_call_config_set_zalo_call_id');
    }

    zrtc_call_config_set_zrtc_config_json(handle, value) {
        this.#setCallConfig(handle, 'zrtcConfigJson', value || '', 'zrtc_call_config_set_zrtc_config_json');
        this.#setCallConfig(handle, 'zrtc_config', this.#parseJson(value) || null);
    }

    zrtc_call_config_set_zrtc_packet_output_file(handle, value) {
        this.#setCallConfig(handle, 'zrtcPacketOutputFile', value || '', 'zrtc_call_config_set_zrtc_packet_output_file');
    }

    zrtc_media_codec_info_create() {
        const handle = this.#createNativeHandle(this.mediaCodecInfos, {});
        this.#recordPeerJniCall('zrtc_media_codec_info_create', { handle });
        return handle;
    }

    zrtc_media_codec_info_delete(handle) {
        const nativeHandle = Number(handle) || 0;
        const deleted = this.mediaCodecInfos.delete(nativeHandle);
        this.#recordPeerJniCall('zrtc_media_codec_info_delete', {
            handle: nativeHandle,
            deleted
        });
    }

    zrtc_media_codec_info_set_audio_partner_codec(handle, value) {
        this.#setMediaCodecInfo(handle, 'audioPartnerCodec', value || '', 'zrtc_media_codec_info_set_audio_partner_codec');
        this.#setMediaCodecInfo(handle, 'audioConfig', value || '');
        this.#setMediaCodecInfo(handle, 'codec', value || '');
    }

    zrtc_media_codec_info_set_extend_data(handle, value) {
        this.#setMediaCodecInfo(handle, 'extendData', value || '', 'zrtc_media_codec_info_set_extend_data');
    }

    zrtc_peer_create() {
        if (!this.peerHandles.has(this.peerHandle)) {
            this.peerState = {};
            this.peerHandles.set(this.peerHandle, this.peerState);
        }
        this.#recordPeerJniCall('zrtc_peer_create', { peerHandle: this.peerHandle });
        return this.peerHandle;
    }

    zrtc_peer_delete(peerHandle) {
        const handle = Number(peerHandle) || this.peerHandle;
        this.#recordPeerJniCall('zrtc_peer_delete', { peerHandle: handle });
        this.engine.destroyNativePeerSession('zrtc_peer_delete');
        this.#deletePeerConnector(handle, 'zrtc_peer_delete');
    }

    zrtc_peer_init_call(peerHandle, extraInfo) {
        const handle = Number(peerHandle) || this.peerHandle;
        this.latestCallConfig = {
            peerHandle: handle,
            extraInfo: extraInfo || ''
        };
        this.#resetPeerCallState(handle, {
            reason: 'zrtc_peer_init_call',
            extraInfo: extraInfo || ''
        });
        this.peerHandle = handle;
        this.#recordPeerJniCall('zrtc_peer_init_call', {
            peerHandle: handle,
            hasExtraInfo: !!extraInfo
        });
        return true;
    }

    zrtc_peer_make_call(peerHandle, callConfigHandleOrData, listServer) {
        const payload = this.#resolveCallConfig(callConfigHandleOrData);
        if (listServer !== undefined && listServer !== null) {
            payload.listServer = listServer;
        }
        payload.peerHandle = Number(peerHandle) || this.peerHandle;
        this.#recordPeerJniCall('zrtc_peer_make_call', {
            peerHandle: payload.peerHandle,
            callConfigHandle: typeof callConfigHandleOrData === 'number' ? callConfigHandleOrData : null,
            hasListServer: !!listServer,
            androidReadyMakeCall: !!payload.__androidReadyMakeCall,
            callId: payload.callId || payload.id || ''
        });
        if (payload.__androidReadyMakeCall) {
            this.latestCallConfig = Object.assign({}, this.latestCallConfig, payload);
            this.#setPeerState({
                outgoingCallConfig: payload,
                outgoingListServer: payload.listServer || '',
                outgoingNativeMakeCallAt: Date.now()
            });
            return this.engine.applyAndroidReadyMakeCall(payload);
        }
        return this.#makeCall(payload);
    }

    zrtc_peer_incoming_call(peerHandle, callConfigHandleOrData, mediaCodecInfoHandleOrData, rtpAddress, rtcpAddress, extraServer) {
        const payload = this.#resolveCallConfig(callConfigHandleOrData);
        const mediaCodecInfo = this.#resolveMediaCodecInfo(mediaCodecInfoHandleOrData);
        payload.peerHandle = Number(peerHandle) || this.peerHandle;
        payload.codec = payload.codec || mediaCodecInfo.audioPartnerCodec || mediaCodecInfo.codec;
        payload.extendData = payload.extendData || mediaCodecInfo.extendData;
        payload.rtpAddress = payload.rtpAddress || rtpAddress;
        payload.rtcpAddress = payload.rtcpAddress || rtcpAddress;
        payload.extraServer = payload.extraServer || extraServer;
        this.#recordPeerJniCall('zrtc_peer_incoming_call', {
            peerHandle: payload.peerHandle,
            callConfigHandle: typeof callConfigHandleOrData === 'number' ? callConfigHandleOrData : null,
            mediaCodecInfoHandle: typeof mediaCodecInfoHandleOrData === 'number' ? mediaCodecInfoHandleOrData : null,
            hasRtpAddress: !!payload.rtpAddress,
            hasRtcpAddress: !!payload.rtcpAddress,
            hasExtraServer: !!payload.extraServer,
            callId: payload.callId || payload.id || ''
        });
        return this.#incomingCall(payload);
    }

    zrtc_peer_end_call(peerHandle, force) {
        const handle = Number(peerHandle) || this.peerHandle;
        this.latestCallConfig = { peerHandle: handle };
        this.#resetPeerCallState(handle, {
            reason: 'zrtc_peer_end_call',
            ended: true
        });
        this.#recordPeerJniCall('zrtc_peer_end_call', {
            peerHandle: handle,
            force: !!force
        });
        return this.#endCall({
            peerHandle: handle,
            force: !!force,
            source: 'zrtc_peer_end_call'
        });
    }

    zrtc_peer_force_stop(peerHandle) {
        const handle = Number(peerHandle) || this.peerHandle;
        this.#recordPeerJniCall('zrtc_peer_force_stop', {
            peerHandle: handle
        });
        const result = this.engine.destroyNativePeerSession('zrtc_peer_force_stop');
        this.#resetPeerConnector(handle, {
            reason: 'zrtc_peer_force_stop',
            ended: true
        });
        return result;
    }

    resetRuntimeState(reason = 'engine-reset', options = {}) {
        this.#resetPeerConnector(this.peerHandle, {
            reason,
            ended: !!options.ended,
            extraInfo: options.extraInfo || ''
        });
    }

    zrtc_peer_receive_answer_preconnect(peerHandle, peerId, callId, payload) {
        this.#recordPeerJniCall('zrtc_peer_receive_answer_preconnect', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            peerId: peerId || 0,
            callId: callId || 0,
            hasPayload: !!payload
        });
        return this.#receiveAnswerPreconnect(peerId, callId, payload, {
            peerHandle: Number(peerHandle) || this.peerHandle,
            source: 'zrtc_peer_receive_answer_preconnect',
            _fromPeerJni: true
        });
    }

    zrtc_peer_receive_incoming_preconnect(peerHandle, peerId, callId, payload) {
        this.#recordPeerJniCall('zrtc_peer_receive_incoming_preconnect', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            peerId: peerId || 0,
            callId: callId || 0,
            hasPayload: !!payload
        });
        return this.#receiveIncomingPreconnect(peerId, callId, payload, {
            peerHandle: Number(peerHandle) || this.peerHandle,
            source: 'zrtc_peer_receive_incoming_preconnect',
            _fromPeerJni: true
        });
    }

    zrtc_peer_receive_msg_preconnect(peerHandle, peerId, payload) {
        this.#recordPeerJniCall('zrtc_peer_receive_msg_preconnect', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            peerId: Number(peerId) || 0,
            hasPayload: !!payload
        });
        return this.#receiveMsgPreconnect(peerId, payload, {
            peerHandle: Number(peerHandle) || this.peerHandle,
            source: 'zrtc_peer_receive_msg_preconnect',
            _fromPeerJni: true
        });
    }

    zrtc_peer_update_caller_info(peerHandle, mediaCodecInfoHandleOrData, extraInfo) {
        const mediaCodecInfo = this.#resolveMediaCodecInfo(mediaCodecInfoHandleOrData);
        this.#recordPeerJniCall('zrtc_peer_update_caller_info', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            mediaCodecInfoHandle: typeof mediaCodecInfoHandleOrData === 'number' ? mediaCodecInfoHandleOrData : null,
            hasAudioPartnerCodec: !!(mediaCodecInfo.audioPartnerCodec || mediaCodecInfo.audioConfig || mediaCodecInfo.codec),
            hasExtendData: !!mediaCodecInfo.extendData,
            hasExtraInfo: !!extraInfo
        });
        this.engine.updateCallerInfo(
            mediaCodecInfo.audioPartnerCodec || mediaCodecInfo.audioConfig || mediaCodecInfo.codec,
            mediaCodecInfo.extendData || extraInfo || ''
        );
        return true;
    }

    zrtc_peer_update_caller_ringring(peerHandle, extendData) {
        this.#setPeerState({
            ringringExtendData: extendData || ''
        });
        return true;
    }

    zrtc_peer_call_change_ZRTP(peerHandle, session, rtpList, rtcpList) {
        const rtpAddress = Array.isArray(rtpList) ? rtpList[0] : rtpList;
        const rtcpAddress = Array.isArray(rtcpList) ? rtcpList[0] : rtcpList;
        this.#recordPeerJniCall('zrtc_peer_call_change_ZRTP', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            hasSession: !!session,
            hasRtpAddress: !!rtpAddress,
            hasRtcpAddress: !!rtcpAddress
        });
        this.engine.setConfiguredTransport({ session, rtpAddress, rtcpAddress });
    }

    zrtc_peer_hold_audio(peerHandle, held, resumeLocalAudio) {
        this.#recordPeerJniCall('zrtc_peer_hold_audio', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            held: !!held,
            resumeLocalAudio: resumeLocalAudio !== undefined ? !!resumeLocalAudio : true
        });
        this.#setPeerState({
            audioHoldResumeLocal: resumeLocalAudio !== undefined ? !!resumeLocalAudio : true
        });
        return this.engine.holdAudio(!!held);
    }

    zrtc_peer_mute_audio(peerHandle, muted) {
        this.#recordPeerJniCall('zrtc_peer_mute_audio', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            muted: !!muted
        });
        return this.engine.muteAudio(!!muted);
    }

    zrtc_peer_set_speaker_on(peerHandle, enabled) {
        this.#recordPeerJniCall('zrtc_peer_set_speaker_on', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            enabled: !!enabled
        });
        return this.engine.setSpeakerOn(!!enabled);
    }

    zrtc_peer_set_partner_off_camera(peerHandle, status, reason) {
        this.#setPeerState({
            partnerOffCameraReason: Number(reason) || 0
        });
        return this.engine.setPartnerOffCamera(status);
    }

    zrtc_peer_switch_camera(peerHandle) {
        this.#setPeerState({
            peerHandle: Number(peerHandle) || this.peerHandle
        });
        return this.engine.switchCamera();
    }

    zrtc_peer_set_call_state(peerHandle, state) {
        const zrtcCallState = Number(state) || 0;
        const handle = Number(peerHandle) || this.peerHandle;
        if (zrtcCallState === 0) {
            this.latestCallConfig = { peerHandle: handle };
            this.#resetPeerCallState(handle, {
                reason: 'zrtc_peer_set_call_state',
                ended: true
            });
        }
        const nextPeerState = {
            peerHandle: handle,
            zrtcCallState
        };
        if (zrtcCallState === 0) {
            nextPeerState.endCallState = 19;
        } else {
            nextPeerState.endCallState = 0;
        }
        this.#recordPeerJniCall('zrtc_peer_set_call_state', {
            peerHandle: nextPeerState.peerHandle,
            zrtcCallState
        });
        this.peerState = Object.assign({}, this.peerState, nextPeerState);
        this.engine.record('zrtcPeerSetCallState', {
            peerHandle: nextPeerState.peerHandle,
            zrtcCallState,
            endCallState: nextPeerState.endCallState
        });
    }

    zrtc_peer_is_in_call(peerHandle) {
        return this.engine.isInCall();
    }

    zrtc_peer_is_in_video_call(peerHandle) {
        return this.engine.isInVideoCall();
    }

    zrtc_peer_get_json_stats406(peerHandle, startNetworkType, endNetworkType, extendJson) {
        const stats = this.engine.getJsonStats406(startNetworkType, endNetworkType);
        if (extendJson !== undefined && extendJson !== null && extendJson !== '') {
            stats.extend = this.#parseJson(extendJson) || String(extendJson);
        }
        return stats;
    }

    zrtc_peer_get_json_stats406_extend(peerHandle, startNetworkType, endNetworkType, extendJson) {
        return this.zrtc_peer_get_json_stats406(peerHandle, startNetworkType, endNetworkType, extendJson);
    }

    zrtc_peer_get_extend_data(peerHandle) {
        return this.engine.getExtendData();
    }

    zrtc_peer_get_active_audio_codecs(peerHandle) {
        return this.engine.getActiveAudioCodecs();
    }

    zrtc_peer_get_srtp_key(peerHandle) {
        return this.engine.getSrtpKey();
    }

    zrtc_peer_register_callback(peerHandle, callback) {
        this.#setPeerState({ callback: callback || null });
    }

    zrtc_peer_register_in_audio_stream(peerHandle, sampleRate, channels, enabled) {
        this.#setPeerState({
            inAudioStream: { sampleRate: Number(sampleRate) || 0, channels: Number(channels) || 0, enabled: !!enabled }
        });
    }

    zrtc_peer_register_out_audio_stream(peerHandle, sampleRate, channels, enabled) {
        this.#setPeerState({
            outAudioStream: { sampleRate: Number(sampleRate) || 0, channels: Number(channels) || 0, enabled: !!enabled }
        });
    }

    zrtc_peer_deregister_in_audio_stream(peerHandle) {
        this.#setPeerState({ inAudioStream: null });
    }

    zrtc_peer_deregister_out_audio_stream(peerHandle) {
        this.#setPeerState({ outAudioStream: null });
    }

    zrtc_peer_add_render_wnd(peerHandle, index, renderWindow) {
        this.#setPeerState({
            renderWindowIndex: Number(index) || 0,
            renderWindow: renderWindow || null
        });
    }

    zrtc_peer_check_cache_valid(peerHandle, userId, callId) {
        this.#recordPeerJniCall('zrtc_peer_check_cache_valid', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            userId: Number(userId) || 0,
            callId: Number(callId) || 0
        });
        return false;
    }

    zrtc_peer_enable_low_data_mode(peerHandle, enabled, reason) {
        this.#setPeerState({
            lowDataMode: !!enabled,
            lowDataModeReason: reason || ''
        });
    }

    zrtc_peer_get_aec_external(peerHandle) {
        return Number(this.peerState.aecExternal || 0);
    }

    zrtc_peer_get_aec_internal(peerHandle) {
        return Number(this.peerState.aecInternal || 0);
    }

    zrtc_peer_get_agc_mic_level(peerHandle) {
        return Number(this.peerState.agcMicLevel || 0);
    }

    zrtc_peer_get_agc_play_level(peerHandle) {
        return Number(this.peerState.agcPlayLevel || 0);
    }

    zrtc_peer_get_auto_hangup_process_time(peerHandle) {
        return 0;
    }

    zrtc_peer_get_call_info(peerHandle) {
        return JSON.stringify(this.engine.getCallInfo() || {});
    }

    zrtc_peer_get_client_cache_info(peerHandle, userId, callId) {
        return '';
    }

    zrtc_peer_get_current_rtp(peerHandle) {
        const call = this.engine.currentCall || {};
        const transport = call.transportConfig || this.engine.localState.configuredTransport || {};
        return String(transport.rtpAddress || '');
    }

    zrtc_peer_get_end_call_state(peerHandle) {
        return Number(this.peerState.endCallState || 0);
    }

    zrtc_peer_get_extend_data_ringring(peerHandle) {
        return String(this.peerState.ringringExtendData || this.latestCallConfig.ringringExtendData || '');
    }

    zrtc_peer_get_loading_time_bad_connection(peerHandle) {
        return 0;
    }

    zrtc_peer_get_native_trace_data(peerHandle) {
        return JSON.stringify({
            peerState: this.peerState,
            call: this.engine.getCallInfo()
        });
    }

    zrtc_peer_get_ns_level(peerHandle) {
        return Number(this.peerState.nsLevel || 0);
    }

    zrtc_peer_get_spectrum_files(peerHandle, output) {
        const files = this.peerState.spectrumFiles || [];
        if (Array.isArray(output)) {
            files.forEach((file, index) => {
                output[index] = file;
            });
        }
        return files.length > 0;
    }

    zrtc_peer_hardware_encoder_support(peerHandle) {
        return 0;
    }

    zrtc_peer_is_record_network_data(peerHandle) {
        return false;
    }

    zrtc_peer_network_change(peerHandle, available) {
        this.#setPeerState({ networkAvailable: !!available });
    }

    zrtc_peer_on_app_state_change(peerHandle, state) {
        this.#setPeerState({ appState: Number(state) || 0 });
    }

    zrtc_peer_on_byte_buffer_frame_applied_filter(peerHandle, buffer, length, width, height, rotation, format, stride, timestamp) {
        this.#setPeerState({ lastAppliedFilterFrameAt: Date.now(), lastAppliedFilterTimestamp: timestamp || 0 });
    }

    zrtc_peer_on_byte_buffer_frame_captured(peerHandle, buffer, length, width, height, rotation, timestamp) {
        this.#setPeerState({ lastCapturedByteFrameAt: Date.now(), lastCapturedByteFrameTimestamp: timestamp || 0 });
    }

    zrtc_peer_on_switch_camera_done(peerHandle, success) {
        this.#setPeerState({ lastSwitchCameraDone: !!success });
    }

    zrtc_peer_on_texture_frame_captured(peerHandle, width, height, rotation, transformMatrix, textureId, timestamp, mirror) {
        this.#setPeerState({ lastTextureFrameAt: Date.now(), lastTextureFrameTimestamp: timestamp || 0 });
    }

    zrtc_peer_on_video_filter_change(peerHandle, enabled, filterId) {
        this.#setPeerState({
            videoFilterEnabled: !!enabled,
            videoFilterId: Number(filterId) || 0
        });
    }

    zrtc_peer_play_dtmf(peerHandle, tone) {
        this.#setPeerState({ lastDtmfTone: Number(tone) || 0 });
    }

    zrtc_peer_pre_incoming(peerHandle, peerId, callId, payload) {
        this.#recordPeerJniCall('zrtc_peer_pre_incoming', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            peerId: Number(peerId) || 0,
            callId: Number(callId) || 0,
            hasPayload: !!payload
        });
        return this.#receiveIncomingPreconnect(peerId, callId, payload, {
            peerHandle: Number(peerHandle) || this.peerHandle,
            source: 'zrtc_peer_pre_incoming'
        });
    }

    zrtc_peer_receive_call_event(peerHandle, event) {
        this.#setPeerState({ lastCallEvent: Number(event) || 0 });
    }

    zrtc_peer_receive_change_zrtp_server_data(peerHandle, payload) {
        const data = this.#parseJson(payload) || {};
        const session = data.session || data.sessionId || data.sessId;
        const rtpAddress = this.#getFirstValue(data.rtp, data.rtpAddress, data.rtpAddr);
        const rtcpAddress = this.#getFirstValue(data.rtcp, data.rtcpAddress, data.rtcpAddr);
        if (session || rtpAddress || rtcpAddress) {
            this.engine.setConfiguredTransport({ session, rtpAddress, rtcpAddress });
        }
        return true;
    }

    zrtc_peer_receive_partner_forward_data(peerHandle, payload) {
        this.#setPeerState({ lastPartnerForwardData: payload || '' });
        return true;
    }

    zrtc_peer_record_audio_from_file(peerHandle, enabled, filePath) {
        this.#setPeerState({
            recordAudioFromFile: !!enabled,
            recordAudioFilePath: filePath || ''
        });
    }

    zrtc_peer_reinit_audio_device(peerHandle, inputDevice, outputDevice) {
        const argc = arguments.length;
        const reason = Number(inputDevice) || 0;
        const input = argc >= 3 ? Number(inputDevice) || 0 : 0;
        const output = argc >= 3 ? Number(outputDevice) || 0 : 0;
        this.#setPeerState({
            audioReinitArgc: argc,
            audioReinitReason: reason,
            audioInputDevice: input,
            audioOutputDevice: output
        });
        this.#recordPeerJniCall('zrtc_peer_reinit_audio_device', {
            peerHandle: Number(peerHandle) || this.peerHandle,
            argc,
            reason,
            inputDevice: input,
            outputDevice: output
        });
        return true;
    }

    zrtc_peer_restart_capture(peerHandle) {
        this.#setPeerState({ captureRestartedAt: Date.now() });
    }

    zrtc_peer_save_last_capture_frame(peerHandle, filePath) {
        this.#setPeerState({ lastCaptureFramePath: filePath || '' });
        return false;
    }

    zrtc_peer_save_last_render_frame(peerHandle, filePath) {
        this.#setPeerState({ lastRenderFramePath: filePath || '' });
        return false;
    }

    zrtc_peer_set_aec_external(peerHandle, value) {
        this.#setPeerState({ aecExternal: Number(value) || 0 });
    }

    zrtc_peer_set_aec_internal(peerHandle, value) {
        this.#setPeerState({ aecInternal: Number(value) || 0 });
    }

    zrtc_peer_set_agc_mic_level(peerHandle, value) {
        this.#setPeerState({ agcMicLevel: Number(value) || 0 });
    }

    zrtc_peer_set_agc_play_level(peerHandle, value) {
        this.#setPeerState({ agcPlayLevel: Number(value) || 0 });
    }

    zrtc_peer_set_app_context(peerHandle, appContext) {
        this.#setPeerState({ appContext: appContext || null });
        return 0;
    }

    zrtc_peer_set_dev_config(peerHandle, value) {
        this.#setPeerState({ devConfig: value || '' });
    }

    zrtc_peer_set_egl_context(peerHandle, eglContext) {
        this.#setPeerState({ eglContext: eglContext || null });
        return 0;
    }

    zrtc_peer_set_last_frame_into_view(peerHandle) {
        this.#setPeerState({ lastFrameIntoViewAt: Date.now() });
    }

    zrtc_peer_set_local_render_wnd(peerHandle, renderWindow) {
        this.#setPeerState({ localRenderWindow: renderWindow || null });
    }

    zrtc_peer_set_log_file(peerHandle, logFile, statFile, level) {
        this.#setPeerState({
            logFile: logFile || '',
            statFile: statFile || '',
            logFileLevel: Number(level) || 0
        });
    }

    zrtc_peer_set_log_level(peerHandle, level) {
        this.#setPeerState({ logLevel: Number(level) || 0 });
    }

    zrtc_peer_set_ns_level(peerHandle, level) {
        this.#setPeerState({ nsLevel: Number(level) || 0 });
    }

    zrtc_peer_start_record_audio(peerHandle, enabled, filePath) {
        this.#setPeerState({
            recordAudio: !!enabled,
            recordAudioPath: filePath || ''
        });
    }

    zrtc_peer_stop_capture(peerHandle, shouldKeepLastFrame, reason) {
        this.#setPeerState({
            captureStopped: true,
            keepLastFrame: !!shouldKeepLastFrame,
            stopCaptureReason: Number(reason) || 0
        });
    }

    zrtc_peer_switch_audio_device_layer(peerHandle) {
        this.#setPeerState({
            audioDeviceLayerSwitches: Number(this.peerState.audioDeviceLayerSwitches || 0) + 1
        });
    }

    zrtc_peer_switch_to_video_call(peerHandle, enabled, payload) {
        this.#setPeerState({
            switchToVideoRequested: !!enabled,
            switchToVideoPayload: payload || ''
        });
        const responses = this.engine.upgradeToVideoCall ?
            this.engine.upgradeToVideoCall({ enabled: !!enabled, payload }) :
            [];
        this.#dispatchResponses(responses);
        return 0;
    }

    zrtc_peer_switch_to_video_call_answer(peerHandle, accepted) {
        this.#setPeerState({ switchToVideoAccepted: !!accepted });
        return accepted ? 0 : -1;
    }

    zrtc_peer_test_reset_codec(peerHandle, codec) {
        this.#setPeerState({ testResetCodec: Number(codec) || 0 });
    }

    zrtc_peer_toggle_current_server(peerHandle) {
        this.#setPeerState({
            serverToggleCount: Number(this.peerState.serverToggleCount || 0) + 1
        });
    }

    zrtc_peer_turn_off_encoder_h265(peerHandle, enabled) {
        this.#setPeerState({ h265EncoderOff: !!enabled });
        return true;
    }

    zrtc_peer_update_callee_pre_ringing(peerHandle, payload) {
        this.#setPeerState({ calleePreRingingData: payload || '' });
        return true;
    }

    zrtc_peer_update_caller_new_request(peerHandle, payload) {
        this.#setPeerState({ callerNewRequestData: payload || '' });
        const data = this.#parseJson(payload);
        if (data && typeof data === 'object') {
            this.latestCallConfig = Object.assign({}, this.latestCallConfig, data);
        }
        return true;
    }

    zrtc_peer_update_zrtc_config_in_call(peerHandle, payload) {
        const zrtcConfig = this.#parseJson(payload);
        if (this.engine.currentCall && zrtcConfig) {
            this.engine.currentCall.transportConfig = Object.assign(
                {},
                this.engine.currentCall.transportConfig || {},
                { zrtcConfig }
            );
        }
        this.#setPeerState({ zrtcConfigInCall: payload || '' });
        return true;
    }

    #makeCall(data) {
        return this.engine.makeCall(this.#buildMakeCallPayload(data));
    }

    #incomingCall(data) {
        return this.engine.handleControl({
            act_type: 'voip',
            act: 'request',
            data
        });
    }

    #endCall(details) {
        return this.engine.handleEndCall(details);
    }

    #receiveAnswerPreconnect(peerId, callId, payload, details) {
        return this.engine.receiveAnswerPreconnect(peerId, callId, payload, details);
    }

    #receiveIncomingPreconnect(peerId, callId, payload, details) {
        return this.engine.receiveIncomingPreconnect(peerId, callId, payload, details);
    }

    #receiveMsgPreconnect(peerId, payload, details) {
        return this.engine.receiveMsgPreconnect(peerId, payload, details);
    }

    #buildMakeCallPayload(data) {
        const payload = Object.assign({}, this.latestCallConfig || {}, data || {});
        const callId = this.#getFirstValue(payload.callId, payload.id);
        const calleeId = this.#getFirstValue(
            payload.calleeId,
            payload.partnerId,
            payload.reveiverId,
            payload.receiverId,
            payload.uidTo
        );

        if (!callId || String(callId) === '0') {
            payload.callId = this.#generateCallId();
        }

        if ((!Array.isArray(payload.partner) || !payload.partner[0] || !payload.partner[0].id) && calleeId) {
            payload.partner = [{
                id: String(calleeId),
                name: payload.calleeName || payload.partnerName || ''
            }];
        }

        if (!payload.type && payload.callType) {
            payload.type = payload.callType === 'video' ? 1 : 0;
        }

        return payload;
    }

    #getFirstValue(...values) {
        for (const value of values) {
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
    }

    #generateCallId() {
        try {
            const value = crypto.randomBytes(4).readUInt32BE(0);
            return String(100000000 + (value % 900000000));
        } catch (_) {
            return String(100000000 + (Date.now() % 900000000));
        }
    }

    #createNativeHandle(store, value) {
        const handle = this.nextNativeHandle++;
        store.set(handle, Object.assign({}, value || {}));
        return handle;
    }

    #setCallConfig(handle, key, value, methodName) {
        if (methodName) {
            this.#recordPeerJniCall(methodName, {
                handle: Number(handle) || 0,
                key,
                valueType: Array.isArray(value) ? 'array' : typeof value,
                hasValue: Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ''
            });
        }
        this.#setNativeHandleValue(this.callConfigs, handle, key, value);
    }

    #setMediaCodecInfo(handle, key, value, methodName) {
        if (methodName) {
            this.#recordPeerJniCall(methodName, {
                handle: Number(handle) || 0,
                key,
                valueType: typeof value,
                hasValue: value !== undefined && value !== null && value !== ''
            });
        }
        this.#setNativeHandleValue(this.mediaCodecInfos, handle, key, value);
    }

    #setNativeHandleValue(store, handle, key, value) {
        const numericHandle = Number(handle);
        const current = store.get(numericHandle) || {};
        current[key] = value;
        store.set(numericHandle, current);
    }

    #resolveCallConfig(handleOrData) {
        if (typeof handleOrData === 'number') {
            return Object.assign({}, this.callConfigs.get(handleOrData) || {});
        }

        return Object.assign({}, handleOrData || {});
    }

    #resolveMediaCodecInfo(handleOrData) {
        if (typeof handleOrData === 'number') {
            return Object.assign({}, this.mediaCodecInfos.get(handleOrData) || {});
        }

        return Object.assign({}, handleOrData || {});
    }

    #mergeJsonCallConfig(handle, value) {
        const parsed = this.#parseJson(value);
        if (!parsed || typeof parsed !== 'object') {
            return;
        }

        const current = this.callConfigs.get(Number(handle)) || {};
        this.callConfigs.set(Number(handle), Object.assign(current, parsed));
    }

    #setPeerState(values) {
        this.peerState = Object.assign({}, this.peerState, values || {});
        this.peerHandles.set(this.peerHandle, this.peerState);
    }

    #resetPeerCallState(peerHandle, options = {}) {
        const preserved = {
            peerHandle,
            endCallState: options.ended ? 19 : 0,
            zrtcCallState: 0,
            appContext: this.peerState.appContext,
            callback: this.peerState.callback,
            devConfig: this.peerState.devConfig,
            eglContext: this.peerState.eglContext,
            localRenderWindow: this.peerState.localRenderWindow,
            logLevel: this.peerState.logLevel,
            aecExternal: this.peerState.aecExternal,
            aecInternal: this.peerState.aecInternal,
            agcMicLevel: this.peerState.agcMicLevel,
            agcPlayLevel: this.peerState.agcPlayLevel,
            nsLevel: this.peerState.nsLevel,
            networkAvailable: this.peerState.networkAvailable,
            appState: this.peerState.appState
        };

        this.peerState = Object.fromEntries(
            Object.entries(preserved).filter(([, value]) => value !== undefined)
        );
        this.peerHandles.set(peerHandle, this.peerState);
        this.engine.record('peerJniCallStateReset', {
            peerHandle,
            ended: !!options.ended,
            preservedKeys: Object.keys(this.peerState)
        });
    }

    #resetPeerConnector(peerHandle, options = {}) {
        const handle = Number(peerHandle) || this.peerHandle;
        const oldCallConfigCount = this.callConfigs.size;
        const oldMediaCodecInfoCount = this.mediaCodecInfos.size;
        const oldPeerHandleCount = this.peerHandles.size;

        this.callConfigs.clear();
        this.mediaCodecInfos.clear();
        this.peerHandles.clear();
        this.#resetPeerCallState(handle, options);
        this.peerHandle = handle;
        this.latestCallConfig = {
            peerHandle: handle,
            extraInfo: options.extraInfo || ''
        };
        this.engine.record('peerJniConnectorReset', {
            peerHandle: handle,
            reason: options.reason || '',
            ended: !!options.ended,
            clearedCallConfigs: oldCallConfigCount,
            clearedMediaCodecInfos: oldMediaCodecInfoCount,
            oldPeerHandleCount,
            preservedKeys: Object.keys(this.peerState)
        });
    }

    #deletePeerConnector(peerHandle, reason) {
        const handle = Number(peerHandle) || this.peerHandle;
        const oldCallConfigCount = this.callConfigs.size;
        const oldMediaCodecInfoCount = this.mediaCodecInfos.size;
        const oldPeerHandleCount = this.peerHandles.size;

        this.callConfigs.clear();
        this.mediaCodecInfos.clear();
        this.peerHandles.clear();
        this.peerState = {};
        this.latestCallConfig = {};
        this.peerHandle = handle;

        this.engine.record('peerJniConnectorDeleted', {
            peerHandle: handle,
            reason,
            clearedCallConfigs: oldCallConfigCount,
            clearedMediaCodecInfos: oldMediaCodecInfoCount,
            oldPeerHandleCount
        });
    }

    #recordPeerJniCall(name, data) {
        this.peerJniSeq += 1;
        if (this.engine && typeof this.engine.record === 'function') {
            this.engine.record('peerJniCall', Object.assign({
                seq: this.peerJniSeq,
                name
            }, data || {}));
        }
    }

    #dispatchResponses(responses) {
        if (!Array.isArray(responses) || typeof this.engine.send !== 'function') {
            return;
        }

        for (const response of responses) {
            this.engine.send(response);
        }
    }

    #parseJson(value) {
        if (!value || typeof value !== 'string') {
            return null;
        }

        try {
            return JSON.parse(value);
        } catch (_) {
            return null;
        }
    }
}

module.exports = LinuxPeerJNI;
