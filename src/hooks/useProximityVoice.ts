import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { volumeForDistance, panForPositions, type WorldPosition } from "@/lib/proximity";

type PeerState = {
  connection: RTCPeerConnection;
  gain: GainNode;
  panner: StereoPannerNode;
  audio: HTMLAudioElement;
  makingOffer: boolean;
  polite: boolean;
  pendingCandidates: RTCIceCandidateInit[];
};

export type PeerVolume = { userId: string; volume: number };

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const CHANNEL = "erlc-proximity-voice";

/**
 * WebRTC mesh over a Realtime broadcast channel.
 * Each peer's volume/pan is recomputed from in-game distance.
 */
export function useProximityVoice(userId: string | null) {
  const [micOn, setMicOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState(false);

  const peersRef = useRef(new Map<string, PeerState>());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const send = useCallback((event: string, payload: Record<string, unknown>) => {
    channelRef.current?.send({ type: "broadcast", event, payload });
  }, []);

  const ensureContext = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext();
    }
    void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);

  const createPeer = useCallback(
    (peerId: string, polite: boolean): PeerState => {
      const ctx = ensureContext();
      const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const panner = ctx.createStereoPanner();
      gain.connect(panner).connect(ctx.destination);

      const audio = new Audio();
      audio.autoplay = true;
      audio.muted = true; // routed through WebAudio instead

      const state: PeerState = {
        connection,
        gain,
        panner,
        audio,
        makingOffer: false,
        polite,
        pendingCandidates: [],
      };

      const stream = streamRef.current;
      if (stream) for (const track of stream.getTracks()) connection.addTrack(track, stream);

      connection.onicecandidate = (event) => {
        if (event.candidate) {
          send("ice", { to: peerId, from: userId, candidate: event.candidate.toJSON() });
        }
      };

      connection.ontrack = (event) => {
        const remote = event.streams[0];
        if (!remote) return;
        audio.srcObject = remote;
        void audio.play().catch(() => undefined);
        const source = ctx.createMediaStreamSource(remote);
        source.connect(gain);
      };

      connection.onnegotiationneeded = async () => {
        try {
          state.makingOffer = true;
          await connection.setLocalDescription();
          send("sdp", { to: peerId, from: userId, description: connection.localDescription });
        } catch (err) {
          console.error("negotiation failed", err);
        } finally {
          state.makingOffer = false;
        }
      };

      connection.onconnectionstatechange = () => {
        setConnectedPeers(
          [...peersRef.current.entries()]
            .filter(([, p]) => p.connection.connectionState === "connected")
            .map(([id]) => id),
        );
        if (connection.connectionState === "failed" || connection.connectionState === "closed") {
          peersRef.current.delete(peerId);
        }
      };

      peersRef.current.set(peerId, state);
      return state;
    },
    [ensureContext, send, userId],
  );

  const getPeer = useCallback(
    (peerId: string, polite: boolean) => peersRef.current.get(peerId) ?? createPeer(peerId, polite),
    [createPeer],
  );

  /** Called whenever positions change. */
  const applyDistances = useCallback(
    (me: WorldPosition | null, others: Map<string, WorldPosition>): PeerVolume[] => {
      const result: PeerVolume[] = [];
      for (const [peerId, peer] of peersRef.current) {
        const other = others.get(peerId);
        const volume = me && other ? volumeForDistance(distance(me, other)) : 0;
        const pan = me && other ? panForPositions(me, other) : 0;
        const now = audioCtxRef.current?.currentTime ?? 0;
        // Smooth 0.8s exponential ramping ensures zero audio pops/clicks across update intervals
        peer.gain.gain.setTargetAtTime(volume, now, 0.8);
        peer.panner.pan.setTargetAtTime(pan, now, 0.8);
        result.push({ userId: peerId, volume });
      }
      return result;
    },
    [],
  );

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const ctx = ensureContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      for (const [, peer] of peersRef.current) {
        for (const track of stream.getTracks()) peer.connection.addTrack(track, stream);
      }
      setMicOn(true);
      setError(null);
      send("hello", { from: userId });
    } catch (err) {
      console.error(err);
      setError("ما قدرنا نفتح المايك. تأكد من السماح للموقع باستخدام الميكروفون.");
    }
  }, [ensureContext, send, userId]);

  const stopMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    setMicOn(false);
    setSpeaking(false);
  }, []);

  // Speaking indicator
  useEffect(() => {
    if (!micOn) return;
    const data = new Uint8Array(256);
    const id = window.setInterval(() => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setSpeaking(peak > 8);
    }, 150);
    return () => window.clearInterval(id);
  }, [micOn]);

  // Signaling
  useEffect(() => {
    if (!userId) return;

    const channel = supabase.channel(CHANNEL, { config: { broadcast: { self: false } } });
    channelRef.current = channel;

    channel.on("broadcast", { event: "hello" }, ({ payload }) => {
      const from = payload?.["from"] as string | undefined;
      if (!from || from === userId) return;
      // Deterministic politeness avoids glare in the mesh.
      getPeer(from, userId < from);
      channel.send({ type: "broadcast", event: "hi-back", payload: { from: userId, to: from } });
    });

    channel.on("broadcast", { event: "hi-back" }, ({ payload }) => {
      const from = payload?.["from"] as string | undefined;
      if (!from || payload?.["to"] !== userId) return;
      getPeer(from, userId < from);
    });

    channel.on("broadcast", { event: "sdp" }, async ({ payload }) => {
      const from = payload?.["from"] as string | undefined;
      if (!from || payload?.["to"] !== userId) return;
      const description = payload?.["description"] as RTCSessionDescriptionInit;
      const peer = getPeer(from, userId < from);
      const offerCollision =
        description.type === "offer" &&
        (peer.makingOffer || peer.connection.signalingState !== "stable");
      if (offerCollision && !peer.polite) return;
      try {
        await peer.connection.setRemoteDescription(description);
        for (const candidate of peer.pendingCandidates.splice(0)) {
          await peer.connection.addIceCandidate(candidate);
        }
        if (description.type === "offer") {
          await peer.connection.setLocalDescription();
          channel.send({
            type: "broadcast",
            event: "sdp",
            payload: { to: from, from: userId, description: peer.connection.localDescription },
          });
        }
      } catch (err) {
        console.error("sdp handling failed", err);
      }
    });

    channel.on("broadcast", { event: "ice" }, async ({ payload }) => {
      const from = payload?.["from"] as string | undefined;
      if (!from || payload?.["to"] !== userId) return;
      const peer = peersRef.current.get(from);
      if (!peer) return;
      const candidate = payload?.["candidate"] as RTCIceCandidateInit;
      if (!peer.connection.remoteDescription) {
        peer.pendingCandidates.push(candidate);
        return;
      }
      try {
        await peer.connection.addIceCandidate(candidate);
      } catch (err) {
        console.error("ICE candidate failed", err);
      }
    });

    channel.on("broadcast", { event: "bye" }, ({ payload }) => {
      const from = payload?.["from"] as string | undefined;
      if (!from) return;
      peersRef.current.get(from)?.connection.close();
      peersRef.current.delete(from);
      setConnectedPeers([...peersRef.current.keys()]);
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        channel.send({ type: "broadcast", event: "hello", payload: { from: userId } });
      }
    });

    const peers = peersRef.current;
    return () => {
      channel.send({ type: "broadcast", event: "bye", payload: { from: userId } });
      for (const [, peer] of peers) peer.connection.close();
      peers.clear();
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [getPeer, userId]);

  useEffect(() => () => stopMic(), [stopMic]);

  return { micOn, startMic, stopMic, error, connectedPeers, speaking, applyDistances };
}

function distance(a: WorldPosition, b: WorldPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.28;
}
