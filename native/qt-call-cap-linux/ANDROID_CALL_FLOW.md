# Android Zalo 1-1 Call Flow

This note maps the decompiled Android call path in
`zalo_android/app/src/main/java` to the Linux replacement in this directory.
The Android source is obfuscated, so names below are decompiled class names.

## Main Android Classes

- `j62.i0`: 1-1 VoIP session state machine.
- `j62.q`: outgoing `VOICE_REQUEST_CALL` command, protocol command `401`.
- `j62.k`: incoming `VOICE_REQUEST_ANSWER` command, protocol command `402`.
- `j62.b`: successful answer response for `402`.
- `j62.u`: failed/delayed answer response for `402/4020`.
- `j62.t`: ringing response for `407`.
- `j62.j`: remote/local end-call wrapper for `409`.
- `j62.m0`: ZRTP init failure wrapper under `402` with response `5`.
- `j62.s`: command wrapper and command-name table.
- `v52.r1`: `com.vng.zing.vn.zrtc.CallCallback` implementation.
- `v52.s0`, `v52.l0`, `v52.m0`: controller/request callback path for sending
  signal commands through the app service layer.
- `com.vng.zing.vn.zrtc.PeerJNI`: JNI bridge into ZRTC native media/signaling.

## Command Map

`j62.s.toString()` exposes the useful protocol names:

| Command | Android name | Linux adapter constant |
| --- | --- | --- |
| `401` | `VOICE_REQUEST_CALL` | `REQUEST_CALL` |
| `402` | `VOICE_REQUEST_ANSWER` | `ANSWER_INCOMING` |
| `405` | `VOICE_CALL_CANCEL` | `CANCEL_CALL` |
| `406` | `VOICE_CALL_FINISH` | `END_CALL_LOG` |
| `407` | `VOICE_CALL_RINGING` | `RINGING` |
| `408` | `VOICE_REQUEST_ANSWER_ACK` | `ANSWER_ACK` |
| `409` | `VOICE_END_CALL` | `END_CALL` |
| `411` | `VOICE_HOLD_REQUEST` | `HOLD_REQUEST` |
| `413` | `VOICE_UNHOLD_REQUEST` | `UNHOLD_REQUEST` |
| `416` | `VOICE_REQUEST_CALL_ZRTP` | `REQUEST_TRANSPORT` |
| `417` | `VOICE_REQUEST_CHANGE_ZRTP` | `REQUEST_CHANGE_ZRTP` |
| `418` | `VOICE_CHANGE_ZRTP` | `CHANGE_ZRTP` |
| `419` | `VOICE_CHANGE_ZRTP_ACK` | `CHANGE_ZRTP_ACK` |

## Outgoing Call

Android path:

1. Controller creates `j62.q` from `j52.t` with command `401`.
2. `j62.i0.E(...)` handles `q` as outgoing make-call.
3. It rejects missing peer id, missing session, or missing server list.
4. It builds a native call config:
   - `zrtc_call_config_set_protocol(..., 3)`
   - `zrtc_call_config_set_partner_id(...)`
   - `zrtc_call_config_set_session(...)`
   - `zrtc_call_config_set_user_id(...)`
   - `zrtc_call_config_set_zalo_call_id(...)`
   - `zrtc_call_config_set_support_video_call(...)`
   - `zrtc_call_config_set_video_call(...)`
   - `zrtc_call_config_set_fec_type(...)`
   - `zrtc_call_config_set_enable_change_ZRTP(...)`
   - `zrtc_call_config_set_config_json(...)`
   - `zrtc_call_config_set_zrtc_config_json(...)`
   - `zrtc_call_config_set_os_info(...)`
   - `zrtc_call_config_set_client_version(...)`
   - `zrtc_call_config_set_extra_info(...)`
   - `zrtc_call_config_set_protocol_type(..., 0)`
   - `zrtc_call_config_set_loopback_mode(..., 0)`
5. It sets the Android/WebRTC sample rate from the command.
6. It calls `PeerJNI.zrtc_peer_make_call(peer, callConfig, listServer)`.
7. If video is enabled, it registers render windows/camera state and opens the
   in-call UI.

Linux rule:

- `linux-call-engine.makeCall()` is equivalent to creating `j62.q`.
- It must emit `onMakeCall`, keep one active call, send `401`, then send `416`
  after RTP/RTCP/session are known.
- It must not mark the call connected from the click or from `401` alone.

## Incoming Call

Android path:

1. Incoming request arrives as `j62.k` under command `402`.
2. `j62.i0.D(...)` handles `k` as incoming-call setup.
3. It stores session, RTP, RTCP, timer and server config fields.
4. It builds native call config with the same core fields as outgoing, but sets
   `enable_change_ZRTP` to `false`.
5. It builds native media codec info:
   - `zrtc_media_codec_info_set_audio_partner_codec(...)`
   - `zrtc_media_codec_info_set_extend_data(...)`
6. It calls
   `PeerJNI.zrtc_peer_incoming_call(peer, callConfig, mediaCodecInfo, rtp, rtcp, extraServer)`.
7. `v52.r1.onIncomingCall()` then:
   - emits the incoming UI path,
   - wakes/rings the UI,
   - pushes `new j62.i(407)` into the session, which sends ringing.

Linux rule:

- `handleIncomingRequest()` is equivalent to Android receiving `j62.k`.
- It must build one incoming call context, emit `onIncomingCall`, open the Linux
  call window, and send `407`.
- User answer must send `402` with codec, `extendData`, RTP, RTCP, and session.

## Connected State

Android has two important state transitions:

- In outgoing answer handling, `j62.i0.p(...)` receives successful `402`, sets
  session state to `4`, then calls `PeerJNI.zrtc_peer_set_call_state(..., 4)`.
- In established-call setup, `j62.i0.h(...)` logs the confirmed call transition
  and then calls `PeerJNI.zrtc_peer_set_call_state(..., 5)`.
- Preconnect traffic is passed to native through `v52.i0`: outgoing uses
  `PeerJNI.zrtc_peer_receive_answer_preconnect(peer, uid, callId, json)` and
  incoming uses `PeerJNI.zrtc_peer_receive_incoming_preconnect(...)`.

`v52.r1.onInitZrtpWithServer(rtcp, rtp)` stores the selected RTCP/RTP servers and
pushes `new j62.i(416)` into the session. `onInitZrtpRequestFailed(retCode)`
pushes `new j62.m0(retCode)`.

Android change-ZRTP path:

- `v52.s0` sends `voiceRequestChangeZRTP(...)` from local session id, RTP, and
  RTCP values.
- The service response is parsed as command `418` or `419`.
- `j62.k0` carries the new session id plus RTP and RTCP `LinkedList` values.
- `j62.i0.o(...)` passes those lists to
  `PeerJNI.zrtc_peer_call_change_ZRTP(peer, session, rtpList, rtcpList)`.
- Native callback result is represented by `j62.j0`; when successful, Android
  updates local session/RTP/RTCP and can send the follow-up ACK path.

Linux rule:

- JS-visible connected is native event `onCallState(4)`.
- Internal/native state `5` follows actual connected progress. A remote web
  `status=5` answer is only answer-preconnect input in Linux; do not promote it
  to `onCallState(4)`, do not start the counter, and do not send `408` unless a
  later confirmed answer or native/media-connected event succeeds.
- `onInitZrtpWithServer` must use native payload names: `rtcp` and `rtp`.
- `onInitZrtpRequestFailed` must use native payload name `retCode`.
- `418` should update the current RTP/RTCP/session, emit
  `onCallChangeZRTP`, and answer with `419`.
- `419` should update the current RTP/RTCP/session and emit
  `onCallChangeZRTP` without another ACK.

## Transport And Extend Data

Android passes two JSON blobs to native:

- `config_json`: call/server config from the command object.
- `zrtc_config_json`: ZRTC runtime/media config from the command object.

The media codec object carries:

- partner audio codec string,
- `extendData`.

Fields that Linux must preserve or synthesize compatibly:

- `callType`
- `newZrtc`
- `packetMode`
- `srtpMode`
- `supportCallBusy`
- `serverAddr[].rtp`
- `serverAddr[].rtcp`
- video codec list under `video.codec` for video calls.

The current Linux implementation builds these in:

- `buildOutgoingExtendData(...)`
- `buildIncomingAnswerExtendData(...)`
- `buildTransportMediaMode(...)`
- `buildIncomingTransportConfig(...)`
- `buildRequestCallPayload(...)`

## JNI Surface To Reimplement

The Android app depends on `PeerJNI` for the real media engine. A Linux rewrite
does not need the Android JNI ABI, but it needs equivalent behavior for:

- create/delete peer and call/media config objects,
- register callbacks,
- set app/context/log/device options,
- make outgoing call,
- accept incoming call,
- end/force-stop call,
- set call state,
- mute/hold/speaker/camera controls,
- expose active codec/extend data/SRTP key/stats,
- receive/update caller/ringing/ZRTP data,
- render local/remote video or provide equivalent UI surfaces.

In this repo those responsibilities are split:

- `linux-peer-jni.js`: PeerJNI-style compatibility facade and the single API
  entry point used by the socket bridge.
- `linux-call-engine.js`: session state, command mapping, native event shape.
- `linux-media-engine.js`: GStreamer RTP/Opus/H264 media path.
- `linux-call-window.js` plus `call-window-*`: Linux call UI.
- `zalo-call-mock.js`: socket bridge compatible with the copied desktop app.

Compatibility commands currently exposed by the Linux bridge include:

- call/session: `makeCall`, `endCall`, `getCallInfo`, `isInCall`,
  `isInVideoCall`.
- native data: `getJsonStats406`, `getExtendData`, `getActiveAudioCodecs`,
  `getSrtpKey`.
- audio controls: `muteAudio`, `unmuteAudio`, `holdAudio`, `resumeAudio`,
  `setSpeakerOn`, `setAudioVolume`, `setAgc`.
- video controls: `switchCamera`, `setPartnerOffCamera`, `changeVideoDevice`,
  `startDesktopCapture`, `stopDesktopCapture`.
- transport/config: `setConfiguredTransport`, `clearConfiguredTransport`,
  `setMediaConfig`, `updateCallerInfo`, and ZRTP change commands
  `417/418/419`.

Audio routing note:

- Android/native ZRTC can reinitialize explicit audio devices through JNI.
- The Linux adapter intentionally follows the OS default audio input/output
  route instead of exposing device selection in the call window.
- `listDevice` can still report devices for compatibility, but call media does
  not pass explicit `device=` or `target-object=` values to GStreamer audio
  source/sink elements.

## Porting Checklist

- Keep command names and numeric command IDs aligned with `j62.s`.
- Keep `onMakeCall`, `onIncomingCall`, `onCallState`, `onInitZrtpWithServer`,
  `onInitZrtpRequestFailed`, `onCallAudioState`, `onCallVideoState`, and
  `onCallChangeZRTP` payloads native-compatible.
- Treat `401` and `416` as transport setup, not connected state.
- Treat successful answer/ACK/media activity as connected state.
- Preserve `extendData` media mode fields before touching RTP packets.
- For video, advertise H264 codec payload and set `callType` to video in
  `extendData`; otherwise peers can accept audio only.
