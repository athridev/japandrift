"use strict";

// Direct peer-to-peer channel for opponent car position ONLY. Lobby, ready,
// matchmaking, score, and race results all stay on the HTTP sync backend
// (online.js) — that channel is the reliable source of truth and this file
// never touches it. This connects only after both players are confirmed
// racing via that channel, streams position at full rate over an unreliable
// data channel (dropped position packets are harmless), and falls back to
// the existing HTTP state sync (throttled, as a heartbeat) automatically if
// the peer connection never opens or goes silent mid-race — no user-visible
// break either way.
(function () {
  if (typeof RTCPeerConnection === "undefined") return;

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ];
  const CONNECT_TIMEOUT_MS = 8000;
  const HEARTBEAT_MS = 600;
  const STALL_MS = 2500;

  const rtc = {
    pc: null,
    channel: null,
    open: false,
    attempted: false,
    failed: false,
    startedAt: 0,
    lastMessageAt: 0,
    lastHttpStateSend: 0,
    appliedOfferOrAnswer: false,
    pendingCandidates: [],
    remoteCandidateBuffer: [],
    appliedCandidateKeys: new Set(),
  };

  function queueOut(fields) {
    state.rtcOut = Object.assign(state.rtcOut || {}, fields);
  }

  function teardown() {
    try { rtc.channel && rtc.channel.close(); } catch {}
    try { rtc.pc && rtc.pc.close(); } catch {}
    rtc.pc = null;
    rtc.channel = null;
    rtc.open = false;
  }

  function setupChannel(channel) {
    rtc.channel = channel;
    channel.onopen = () => {
      rtc.open = true;
      rtc.lastMessageAt = performance.now();
    };
    channel.onclose = () => { rtc.open = false; };
    channel.onerror = () => { rtc.open = false; };
    channel.onmessage = (event) => {
      rtc.lastMessageAt = performance.now();
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg?.type === "state") {
        const opponentId = state.playerId === "p1" ? "p2" : "p1";
        handleWs({ type: "state", playerId: opponentId, state: msg.state });
      }
    };
  }

  function attachPcHandlers() {
    rtc.pc.onicecandidate = (event) => {
      if (event.candidate) rtc.pendingCandidates.push(event.candidate.toJSON());
    };
    rtc.pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(rtc.pc?.connectionState)) rtc.open = false;
    };
  }

  function flushBufferedCandidates() {
    if (!rtc.appliedOfferOrAnswer || !rtc.pc) return;
    for (const candidate of rtc.remoteCandidateBuffer.splice(0)) {
      rtc.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async function startAsHost() {
    rtc.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    attachPcHandlers();
    setupChannel(rtc.pc.createDataChannel("position", { ordered: false, maxRetransmits: 0 }));
    const offer = await rtc.pc.createOffer();
    await rtc.pc.setLocalDescription(offer);
    queueOut({ rtcOffer: JSON.stringify({ type: offer.type, sdp: offer.sdp }) });
  }

  async function startAsGuestFromOffer(offerJson) {
    rtc.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    attachPcHandlers();
    rtc.pc.ondatachannel = (event) => setupChannel(event.channel);
    await rtc.pc.setRemoteDescription(JSON.parse(offerJson));
    rtc.appliedOfferOrAnswer = true;
    flushBufferedCandidates();
    const answer = await rtc.pc.createAnswer();
    await rtc.pc.setLocalDescription(answer);
    queueOut({ rtcAnswer: JSON.stringify({ type: answer.type, sdp: answer.sdp }) });
  }

  function handleSignal(opponent) {
    if (rtc.failed || rtc.open) return;
    if (state.playerId === "p2" && !rtc.pc && opponent.rtcOffer) {
      startAsGuestFromOffer(opponent.rtcOffer).catch((e) => { rtc.failed = true; rtc.failedAt = "startAsGuestFromOffer-catch"; rtc.lastError = `startAsGuestFromOffer: ${e?.name || ""} ${e?.message || e}`; teardown(); });
    }
    if (state.playerId === "p1" && rtc.pc && !rtc.appliedOfferOrAnswer && opponent.rtcAnswer) {
      rtc.pc.setRemoteDescription(JSON.parse(opponent.rtcAnswer)).then(() => {
        rtc.appliedOfferOrAnswer = true;
        flushBufferedCandidates();
      }).catch((e) => { rtc.failed = true; rtc.failedAt = "setRemoteDescription-answer-catch"; rtc.lastError = `setRemoteDescription(answer): ${e?.name || ""} ${e?.message || e}`; teardown(); });
    }
    if (Array.isArray(opponent.rtcCandidates)) {
      for (const candidate of opponent.rtcCandidates) {
        const key = JSON.stringify(candidate);
        if (rtc.appliedCandidateKeys.has(key)) continue;
        rtc.appliedCandidateKeys.add(key);
        if (rtc.appliedOfferOrAnswer && rtc.pc) rtc.pc.addIceCandidate(candidate).catch(() => {});
        else rtc.remoteCandidateBuffer.push(candidate);
      }
    }
  }
  state.onRtcSignal = handleSignal;

  function maybeStart() {
    if (rtc.attempted || state.mode !== "race" || !state.room) return;
    rtc.attempted = true;
    rtc.startedAt = performance.now();
    if (state.playerId === "p1") {
      startAsHost().catch((e) => {
        rtc.failed = true;
        rtc.failedAt = "startAsHost-catch";
        rtc.lastError = `startAsHost: ${e?.name || ""} ${e?.message || e}`;
        teardown();
      });
    }
  }

  setInterval(() => {
    maybeStart();
    if (!rtc.attempted || rtc.failed) return;
    if (rtc.pendingCandidates.length) queueOut({ rtcCandidates: rtc.pendingCandidates.splice(0) });
    if (!rtc.open && performance.now() - rtc.startedAt > CONNECT_TIMEOUT_MS) {
      rtc.failed = true;
      rtc.failedAt = "timeout-watchdog";
      teardown();
    } else if (rtc.open && performance.now() - rtc.lastMessageAt > STALL_MS) {
      // Channel reports open but has gone silent (can happen on some NAT
      // rebinds) — give up rather than trust a black hole; HTTP keeps going.
      rtc.failed = true;
      rtc.failedAt = "stall-watchdog";
      teardown();
    }
  }, 200);

  const originalSendWs = sendWs;
  sendWs = function (payload) {
    if (payload?.type === "state" && rtc.open && rtc.channel?.readyState === "open") {
      try {
        rtc.channel.send(JSON.stringify({ type: "state", state: payload.state }));
      } catch {
        originalSendWs(payload);
        return;
      }
      const now = performance.now();
      if (now - rtc.lastHttpStateSend > HEARTBEAT_MS) {
        rtc.lastHttpStateSend = now;
        originalSendWs(payload); // low-rate fallback heartbeat, never fully silent
      }
      return;
    }
    originalSendWs(payload);
  };

  window.addEventListener("beforeunload", teardown);

  window.__jdRtcDebug = () => ({
    attempted: rtc.attempted,
    open: rtc.open,
    failed: rtc.failed,
    channelState: rtc.channel?.readyState || null,
    pcConnectionState: rtc.pc?.connectionState || null,
    iceConnectionState: rtc.pc?.iceConnectionState || null,
    lastMessageAgoMs: rtc.lastMessageAt ? Math.round(performance.now() - rtc.lastMessageAt) : null,
    lastError: rtc.lastError || null,
    startedAt: rtc.startedAt,
    nowMinusStartedAt: rtc.startedAt ? Math.round(performance.now() - rtc.startedAt) : null,
    failedAt: rtc.failedAt || null,
  });
})();
