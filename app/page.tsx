"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import Peer, { DataConnection, MediaConnection } from "peerjs";
import JSZip from "jszip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Progress } from "@/components/animate-ui/components/radix/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/animate-ui/components/radix/tabs";
import { Button } from "@/components/animate-ui/components/radix/button";
import { Input } from "@/components/animate-ui/primitives/radix/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/animate-ui/primitives/radix/select";
import { supabase } from "@/lib/supabase";


type LogRow = {
  id: number;
  text: string;
  error: boolean;
};

// Uploaded files or folders information
type SelectionInfo = {
  count: number;
  totalBytes: number;
  ready: boolean;
};

// Inbox entry for a finished incoming transfer
type InboxItem = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  size: number;
  mime: string;
  url: string;
  progress: number;
  rate: number;
  complete: boolean;
};

// Incoming file transfer information
type FileTransferStart = {
  kind: "file-start";
  transferId: string;
  source: "Files" | "Folder";
  name: string;
  mime: string;
  size: number;
  totalChunks: number;
};

// Track a received transfer while chunks are still arriving
type ActiveInboxTransfer = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  mime: string;
  size: number;
  receivedBytes: number;
  chunks: ArrayBuffer[];
  startedAt: number;
  lastTick: number;
  totalChunks: number;
};

// Track transfer progress
type ActiveOutgoingTransfer = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  size: number;
  sentBytes: number;
  startedAt: number;
  lastTick: number;
  totalChunks: number;
};

// Progress row displayed for outgoing transfers
type OutgoingItem = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  size: number;
  progress: number;
  rate: number;
  complete: boolean;
};

// Live link quality and buffering snapshot for the diagnostics panel
type ConnectionDiagnostics = {
  dataChannelState: string;
  bufferedAmount: number;
  rttMs: number | null;
  route: "direct" | "relay" | "unknown";
};

// JSON commands to coordinate raw binary data channel
type ControlMessage =
  | {
      kind: "chat-message";
      text: string;
    }
  | {
      kind: "transfer-start";
      label: "Files" | "Folder";
      count: number;
    }
  | {
      kind: "file-start";
      transferId: string;
      source: "Files" | "Folder";
      name: string;
      mime: string;
      size: number;
      totalChunks: number;
    }
  | {
      kind: "file-chunk-meta";
      transferId: string;
      index: number;
      size: number;
    }
  | {
      kind: "file-end";
      transferId: string;
    }
  | {
      kind: "transfer-cancel";
      transferId: string;
    }
  | {
      kind: "call-end";
      reason: "hangup" | "disconnect";
    };

    // Pending metadata for the next raw binary chunk
type PendingChunkMeta = {
  transferId: string;
  index: number;
  size: number;
};

// Format raw bytes into a human-friendly size label
const formatBytes = (bytes: number): string => {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const value = Math.log(bytes) / Math.log(1024);
  const index = Math.min(Math.floor(value), units.length - 1);
  const scaled = bytes / 1024 ** index;

  return `${scaled.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const FILE_CHUNK_SIZE = 64 * 1024;
const BUFFER_HIGH_WATERMARK = FILE_CHUNK_SIZE * 32;
// Small wait used while the outbound buffer drains
const BUFFER_CHECK_INTERVAL_MS = 10;

// Convert RTT values as readable string for diagnostics panel (Connection Diagnostics)
const formatLatency = (rttMs: number | null): string => {
  if (rttMs === null || Number.isNaN(rttMs)) {
    return "n/a";
  }
  return `${Math.round(rttMs)} ms`;
};

// Color-code diagnostics based on route, latency, and buffer pressure
// Message sent to log
type WorkerInboundMessage = {
  type: "prepare-file";
  transferId: string;
  source: "Files" | "Folder";
  file: File;
  chunkSize: number;
};

// Message sent to log
type WorkerOutboundMessage =
  | {
      type: "prepared-start";
      transferId: string;
      source: "Files" | "Folder";
      name: string;
      mime: string;
      size: number;
      totalChunks: number;
    }
  | {
      type: "prepared-chunk";
      transferId: string;
      index: number;
      data: ArrayBuffer;
    }
  | {
      type: "prepared-end";
      transferId: string;
    }
  | {
      type: "prepared-error";
      transferId: string;
      message: string;
    };

type TreeEntry = {
  path: string;
  size: number;
};

type TreeNode = {
  path: string;
  name: string;
  size: number;
  isFolder: boolean;
  children: TreeNode[];
};

const normalizePathParts = (path: string) => path.replaceAll("\\", "/").split("/").filter(Boolean);

const PEER_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LOCAL_PEER_ID_KEY = "myftp.peer.id";

const generateSimplePeerId = (length = 8): string => {
  const randomValues = new Uint32Array(length);
  crypto.getRandomValues(randomValues);

  return Array.from(randomValues, (value) => PEER_ID_ALPHABET[value % PEER_ID_ALPHABET.length]).join("");
};

const buildShareLink = (peerId: string): string => {
  const url = new URL(window.location.href);
  url.searchParams.set("peer", peerId);
  return url.toString();
};

const triggerBrowserDownload = (url: string, fileName: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const downloadBlobFile = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  triggerBrowserDownload(url, fileName);
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const buildFolderZipBlob = async (folderPath: string, items: InboxItem[]): Promise<Blob> => {
  const zip = new JSZip();

  for (const item of items) {
    const relativePath = item.name.slice(folderPath.length + 1);
    const response = await fetch(item.url);
    const blob = await response.blob();
    zip.file(relativePath, blob);
  }

  return zip.generateAsync({ type: "blob" });
};

const writeBlobToDirectory = async (
  directory: FileSystemDirectoryHandle,
  relativePath: string,
  blob: Blob
) => {
  const parts = normalizePathParts(relativePath);
  const fileName = parts.pop();

  if (!fileName) {
    return;
  }

  let currentDirectory = directory;
  for (const part of parts) {
    currentDirectory = await currentDirectory.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDirectory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
};





export default function Home() {
  const [panelTab, setPanelTab] = useState<"transfer" | "call" | "chat" | "diag" | "settings">("transfer");

  // Connection mode and server settings
  const [mode, setMode] = useState<"cloud" | "local">("cloud");
  const [host, setHost] = useState("0.peerjs.com");
  const [port, setPort] = useState("443");
  const [path, setPath] = useState("/");
  const [secure, setSecure] = useState("true");
  const [myId, setMyId] = useState("Connecting...");
  const [targetId, setTargetId] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }

    return new URLSearchParams(window.location.search).get("peer") ?? "";
  });
  const [message, setMessage] = useState("");
  const [sender, setSender] = useState("");
  const [connState, setConnState] = useState("Not connected");
  const [logs, setLogs] = useState<LogRow[]>([]);
  // Call state and local capture toggles
  const [callType, setCallType] = useState<"audio" | "video" | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [streamVersion, setStreamVersion] = useState(0);
  const [uploadedFiles, setUploadedFiles] = useState<TreeEntry[]>([]);
  const [uploadedFolderFiles, setUploadedFolderFiles] = useState<TreeEntry[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [sendingItems, setSendingItems] = useState<OutgoingItem[]>([]);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [trustedPeers, setTrustedPeers] = useState<string[]>([]);
  // Live connection diagnostics for route and buffer health
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics>({
    dataChannelState: "closed",
    bufferedAmount: 0,
    rttMs: null,
    route: "unknown",
  });

  const peerRef = useRef<Peer | null>(null);
  const activeConnRef = useRef<DataConnection | null>(null);
  const mediaConnRef = useRef<MediaConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const micEnabledRef = useRef(true);
  const cameraEnabledRef = useRef(true);
  // Telemetries
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const incomingTransferLabelRef = useRef<"Files" | "Folder">("Files");
  const inboxItemsRef = useRef<InboxItem[]>([]);
  const activeInboxTransfersRef = useRef<Map<string, ActiveInboxTransfer>>(new Map());
  const sendingTransfersRef = useRef<Map<string, ActiveOutgoingTransfer>>(new Map());
  const sendingItemsRef = useRef<OutgoingItem[]>([]);
  const transferWorkerRef = useRef<Worker | null>(null);
  const workerQueueRef = useRef<WorkerOutboundMessage[]>([]);
  const workerQueueRunningRef = useRef(false);
  // Workspace resize logic removed
  const cancelledIncomingTransfersRef = useRef<Set<string>>(new Set());
  const cancelledOutgoingTransfersRef = useRef<Set<string>>(new Set());
  const transferPromisesRef = useRef<
    Map<string, { resolve: () => void; reject: (error: Error) => void }>
  >(new Map());
  const pendingChunkMetaRef = useRef<PendingChunkMeta | null>(null);

  // Preloaded settings on web
  const modeHint = useMemo(
    () => "DO NOT modify settings above, unless know what you are doing.",
    []
  );

  const peerShareLink = useMemo(() => {
    if (typeof window === "undefined" || !myId || myId === "Connecting...") {
      return "";
    }

    return buildShareLink(myId);
  }, [myId]);

  const pushLog = useCallback((line: string, error = false) => {
    const stamp = new Date().toLocaleTimeString();
    const text = `[${stamp}] ${line}`;
    setLogs((prev) => [...prev, { id: Date.now() + Math.random(), text, error }]);
  }, []);

  // Camera and mic toggle
  const stopStream = useCallback((stream: MediaStream | null) => {
    if (!stream) {
      return;
    }
    stream.getTracks().forEach((track) => track.stop());
  }, []);

  // Video input
  const setLocalStream = useCallback(
    (stream: MediaStream) => {
      stopStream(localStreamRef.current);
      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabledRef.current;
      });
      stream.getVideoTracks().forEach((track) => {
        track.enabled = cameraEnabledRef.current;
      });
      localStreamRef.current = stream;
      setStreamVersion((prev) => prev + 1);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    },
    [stopStream]
  );

  const setRemoteStream = useCallback((stream: MediaStream) => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
    }
  }, []);

  // Clear videos 
  const clearMediaStreams = useCallback(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, []);

  // Reset the visual meter
  const stopAudioMeter = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    sourceNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    sourceNodeRef.current = null;
    analyserRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setAudioLevel(0);
  }, []);

  // Block features that require an open data connection
  const requireConnection = useCallback(() => {
    if (!activeConnRef.current || !activeConnRef.current.open) {
      pushLog("No open connection. Connect first.", true);
      return false;
    }
    return true;
  }, [pushLog]);

  // Reading RTC data channel to check bufferedAmount
  const getRtcDataChannel = useCallback((conn: DataConnection | null): RTCDataChannel | null => {
    if (!conn) {
      return null;
    }

    const candidate = conn as DataConnection & {
      dataChannel?: RTCDataChannel;
      _dc?: RTCDataChannel;
    };

    return candidate.dataChannel ?? candidate._dc ?? null;
  }, []);

  // Reading peer connection so diagnostics can inspect the active route
  const getRtcPeerConnection = useCallback((conn: DataConnection | null): RTCPeerConnection | null => {
    if (!conn) {
      return null;
    }

    const candidate = conn as DataConnection & {
      peerConnection?: RTCPeerConnection;
      _pc?: RTCPeerConnection;
    };

    return candidate.peerConnection ?? candidate._pc ?? null;
  }, []);

  // Wait until buffered outbound bytes fall back below the safe threshold
  const waitForBufferedDrain = useCallback(
    async (conn: DataConnection | null) => {
      const channel = getRtcDataChannel(conn);
      if (!channel) {
        return;
      }

      while (channel.readyState === "open" && channel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, BUFFER_CHECK_INTERVAL_MS));
      }
    },
    [getRtcDataChannel]
  );

  // Detect files that are already compressed or media-like
  const isLikelyCompressed = useCallback((name: string, mime: string) => {
    const lower = name.toLowerCase();
    if (
      lower.endsWith(".zip") ||
      lower.endsWith(".rar") ||
      lower.endsWith(".7z") ||
      lower.endsWith(".gz") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".png") ||
      lower.endsWith(".mp3") ||
      lower.endsWith(".mp4")
    ) {
      return true;
    }

    return mime.includes("zip") || mime.includes("audio/") || mime.includes("video/") || mime.startsWith("image/");
  }, []);

  // Send a structured control frame as JSON
  const sendControlMessage = useCallback((conn: DataConnection, payload: ControlMessage) => {
    conn.send(JSON.stringify(payload));
  }, []);

  // Convert text frame back into a typed control message when possible
  const parseControlMessage = useCallback((text: string): ControlMessage | null => {
    try {
      const parsed = JSON.parse(text) as { kind?: string };
      if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") {
        return null;
      }

      if (
        parsed.kind === "chat-message" ||
        parsed.kind === "transfer-start" ||
        parsed.kind === "file-start" ||
        parsed.kind === "file-chunk-meta" ||
        parsed.kind === "file-end" ||
        parsed.kind === "transfer-cancel" ||
        parsed.kind === "call-end"
      ) {
        return parsed as ControlMessage;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const endActiveCall = useCallback((reason: "hangup" | "disconnect", notifyRemote: boolean) => {
    if (notifyRemote && activeConnRef.current?.open) {
      sendControlMessage(activeConnRef.current, {
        kind: "call-end",
        reason,
      });
    }

    mediaConnRef.current?.close();
    mediaConnRef.current = null;
    stopStream(localStreamRef.current);
    localStreamRef.current = null;
    setCallType(null);
    stopAudioMeter();
    clearMediaStreams();
  }, [clearMediaStreams, sendControlMessage, stopAudioMeter, stopStream]);

  // Convert finished receiver-side transfer into a downloadable inbox item
  const flushInboxTransfer = useCallback((transferId: string) => {
    const transfer = activeInboxTransfersRef.current.get(transferId);
    if (!transfer) {
      return;
    }

    const blob = new Blob(transfer.chunks, { type: transfer.mime });
    const url = URL.createObjectURL(blob);
    const elapsedSeconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.001);
    const rate = transfer.receivedBytes / elapsedSeconds;

    setInboxItems((prev) => {
      const exists = prev.some((item) => item.id === transfer.id);
      if (exists) {
        return prev.map((item) => (
          item.id === transfer.id
            ? {
                ...item,
                source: transfer.source,
                name: transfer.name,
                size: transfer.size,
                mime: transfer.mime,
                url,
                progress: 1,
                rate,
                complete: true,
              }
            : item
        ));
      }

      return [
        {
          id: transfer.id,
          source: transfer.source,
          name: transfer.name,
          size: transfer.size,
          mime: transfer.mime,
          url,
          progress: 1,
          rate,
          complete: true,
        },
        ...prev,
      ];
    });

    activeInboxTransfersRef.current.delete(transferId);
    pushLog(`Received file ready in inbox: ${transfer.name} (${formatBytes(transfer.size)}).`);
  }, [pushLog]);

  // Update receiver progress card while chunks are arriving
  const updateInboxTransferProgress = useCallback((transferId: string) => {
    const transfer = activeInboxTransfersRef.current.get(transferId);
    if (!transfer) {
      return;
    }

    const elapsedSeconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.001);
    const rate = transfer.receivedBytes / elapsedSeconds;
    const progress = transfer.size > 0 ? Math.min(transfer.receivedBytes / transfer.size, 1) : 0;

    setInboxItems((prev) => prev.map((item) => (
      item.id === transferId
        ? { ...item, progress, rate, complete: false, size: transfer.size, mime: transfer.mime, name: transfer.name, source: transfer.source }
        : item
    )));
  }, []);

  // Seed a sender-side progress card before chunks begin to flow
  const beginOutgoingTransfer = useCallback(
    (transferId: string, source: "Files" | "Folder", name: string, size: number, totalChunks: number) => {
      sendingTransfersRef.current.set(transferId, {
        id: transferId,
        source,
        name,
        size,
        sentBytes: 0,
        startedAt: Date.now(),
        lastTick: Date.now(),
        totalChunks,
      });

      setSendingItems((prev) => [
        {
          id: transferId,
          source,
          name,
          size,
          progress: 0,
          rate: 0,
          complete: false,
        },
        ...prev,
      ]);
    },
    []
  );

  // Update sender progress bar forward after each binary chunk is sent
  const updateOutgoingTransferProgress = useCallback(
    (transferId: string, chunkSize: number) => {
      const transfer = sendingTransfersRef.current.get(transferId);
      if (!transfer) return;

      transfer.sentBytes += chunkSize;
      const elapsedMs = Math.max(Date.now() - transfer.startedAt, 1);
      const bytesPerSecond = (transfer.sentBytes / elapsedMs) * 1000;
      const progress = transfer.sentBytes / transfer.size;
      const complete = transfer.sentBytes >= transfer.size;

      setSendingItems((prev) =>
        prev.map((item) =>
          item.id === transferId
            ? { ...item, progress, rate: bytesPerSecond, complete }
            : item
        )
      );

      if (complete) {
        sendingTransfersRef.current.delete(transferId);
      }
    },
    []
  );

  // Mark an outgoing transfer as complete and keep its final state visible
  const flushOutgoingTransfer = useCallback((transferId: string) => {
    sendingTransfersRef.current.delete(transferId);
    setSendingItems((prev) =>
      prev.map((item) =>
        item.id === transferId ? { ...item, complete: true } : item
      )
    );
  }, []);

  // Handle worker output in order so file metadata and raw chunks stay paired
  const processWorkerMessage = useCallback(
    async (payload: WorkerOutboundMessage) => {
      if (cancelledOutgoingTransfersRef.current.has(payload.transferId)) {
        if (payload.type === "prepared-end" || payload.type === "prepared-error") {
          transferPromisesRef.current.delete(payload.transferId);
          sendingTransfersRef.current.delete(payload.transferId);
        }
        return;
      }

      if (payload.type === "prepared-error") {
        transferPromisesRef.current.get(payload.transferId)?.reject(new Error(payload.message));
        transferPromisesRef.current.delete(payload.transferId);
        sendingTransfersRef.current.delete(payload.transferId);
        setSendingItems((prev) => prev.map((item) => (
          item.id === payload.transferId ? { ...item, complete: true } : item
        )));
        pushLog(`Worker error for transfer ${payload.transferId}: ${payload.message}`, true);
        return;
      }

      const conn = activeConnRef.current;
      if (!conn || !conn.open) {
        transferPromisesRef.current.get(payload.transferId)?.reject(new Error("Connection closed during transfer"));
        transferPromisesRef.current.delete(payload.transferId);
        return;
      }

      if (payload.type === "prepared-start") {
        sendControlMessage(conn, {
          kind: "file-start",
          transferId: payload.transferId,
          source: payload.source,
          name: payload.name,
          mime: payload.mime,
          size: payload.size,
          totalChunks: payload.totalChunks,
        });
        return;
      }

      if (payload.type === "prepared-chunk") {
        await waitForBufferedDrain(conn);
        sendControlMessage(conn, {
          kind: "file-chunk-meta",
          transferId: payload.transferId,
          index: payload.index,
          size: payload.data.byteLength,
        });
        await waitForBufferedDrain(conn);
        conn.send(payload.data);
        updateOutgoingTransferProgress(payload.transferId, payload.data.byteLength);
        return;
      }

      if (payload.type === "prepared-end") {
        await waitForBufferedDrain(conn);
        sendControlMessage(conn, {
          kind: "file-end",
          transferId: payload.transferId,
        });

        flushOutgoingTransfer(payload.transferId);
        transferPromisesRef.current.get(payload.transferId)?.resolve();
        transferPromisesRef.current.delete(payload.transferId);
      }
    },
    [flushOutgoingTransfer, pushLog, sendControlMessage, updateOutgoingTransferProgress, waitForBufferedDrain]
  );

  // Drain queued worker messages without overlapping send loops
  const drainWorkerQueue = useCallback(async () => {
    if (workerQueueRunningRef.current) {
      return;
    }

    workerQueueRunningRef.current = true;
    try {
      while (workerQueueRef.current.length > 0) {
        const payload = workerQueueRef.current.shift();
        if (!payload) {
          continue;
        }
        await processWorkerMessage(payload);
      }
    } finally {
      workerQueueRunningRef.current = false;
    }
  }, [processWorkerMessage]);

  // Create the receiver-side transfer record when a new file starts
  const beginInboxTransfer = useCallback((payload: FileTransferStart) => {
    cancelledIncomingTransfersRef.current.delete(payload.transferId);
    const exists = activeInboxTransfersRef.current.get(payload.transferId);
    if (!exists) {
      activeInboxTransfersRef.current.set(payload.transferId, {
        id: payload.transferId,
        source: payload.source,
        name: payload.name,
        mime: payload.mime,
        size: payload.size,
        receivedBytes: 0,
        chunks: [],
        startedAt: Date.now(),
        lastTick: Date.now(),
        totalChunks: payload.totalChunks,
      });

      setInboxItems((prev) => [
        {
          id: payload.transferId,
          source: payload.source,
          name: payload.name,
          size: payload.size,
          mime: payload.mime,
          url: "",
          progress: 0,
          rate: 0,
          complete: false,
        },
        ...prev,
      ]);
    }
  }, []);

  // Summarize file selections for the upload status cards
  const summarizeSelection = useCallback((files: File[]): SelectionInfo => {
    if (files.length === 0) {
      return { count: 0, totalBytes: 0, ready: false };
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      count: files.length,
      totalBytes,
      ready: true,
    };
  }, []);

  // Convert binary-like payloads into ArrayBuffers for assembly
  const extractArrayBuffer = useCallback((payload: unknown): ArrayBuffer | null => {
    if (payload instanceof ArrayBuffer) {
      return payload;
    }

    if (payload instanceof Uint8Array) {
      const bytes = payload.byteLength > 0
        ? payload.slice()
        : new Uint8Array(0);
      return bytes.buffer;
    }

    if (
      typeof payload === "object" &&
      payload !== null &&
      "type" in payload &&
      "data" in payload &&
      (payload as { type?: string }).type === "Buffer" &&
      Array.isArray((payload as { data?: unknown }).data)
    ) {
      const bytes = new Uint8Array((payload as { data: number[] }).data);
      return bytes.buffer;
    }

    return null;
  }, []);

  const downloadInboxFile = useCallback((item: InboxItem) => {
    if (!item.complete || !item.url) {
      return;
    }

    triggerBrowserDownload(item.url, item.name.split("/").pop() ?? item.name);
  }, []);

  const downloadInboxFolder = useCallback(async (folderPath: string, targetDirectory?: FileSystemDirectoryHandle) => {
    const folderItems = inboxItemsRef.current.filter(
      (item) => item.complete && item.url && item.source === "Folder" && item.name.startsWith(`${folderPath}/`)
    );

    if (folderItems.length === 0) {
      pushLog(`No received files found for folder ${folderPath}.`, true);
      return;
    }

    let selectedDirectory = targetDirectory;
    if (!selectedDirectory) {
      const picker = (window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;

      if (!picker) {
        const zipBlob = await buildFolderZipBlob(folderPath, folderItems);
        downloadBlobFile(zipBlob, `${normalizePathParts(folderPath).pop() ?? folderPath}.zip`);
        pushLog(`Downloaded ${folderPath} as a zip archive with ${folderItems.length} file(s).`);
        return;
      }

      selectedDirectory = await picker();
    }

    let rootDirectory = selectedDirectory;
    for (const part of normalizePathParts(folderPath)) {
      rootDirectory = await rootDirectory.getDirectoryHandle(part, { create: true });
    }

    for (const item of folderItems) {
      const relativePath = item.name.slice(folderPath.length + 1);
      const response = await fetch(item.url);
      const blob = await response.blob();
      await writeBlobToDirectory(rootDirectory, relativePath, blob);
    }

    pushLog(`Downloaded folder ${folderPath} with ${folderItems.length} file(s).`);
  }, [pushLog]);

  const downloadAll = useCallback(async () => {
    const downloadable = inboxItemsRef.current.filter((item) => item.complete && item.url);

    if (downloadable.length === 0) {
      pushLog("No completed inbox items to download.");
      return;
    }

    const folderRoots = new Set(
      downloadable
        .filter((item) => item.source === "Folder" && item.name.includes("/"))
        .map((item) => normalizePathParts(item.name)[0])
        .filter((root): root is string => Boolean(root))
    );

    let folderTargetDirectory: FileSystemDirectoryHandle | undefined;
    if (folderRoots.size > 0) {
      const picker = (window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;

      if (picker) {
        folderTargetDirectory = await picker();
      }
    }

    for (const folderRoot of folderRoots) {
      await downloadInboxFolder(folderRoot, folderTargetDirectory);
    }

    downloadable
      .filter((item) => item.source !== "Folder" || !item.name.includes("/"))
      .forEach((item) => downloadInboxFile(item));

    pushLog(`Downloading ${downloadable.length} received file(s).`);
  }, [downloadInboxFile, downloadInboxFolder, pushLog]);

  // Clear inbox
  const clearInbox = useCallback(() => {
    const activeIds = Array.from(activeInboxTransfersRef.current.keys());
    const conn = activeConnRef.current;

    for (const id of activeIds) {
      cancelledIncomingTransfersRef.current.add(id);
      if (conn?.open) {
        sendControlMessage(conn, {
          kind: "transfer-cancel",
          transferId: id,
        });
      }
    }

    activeInboxTransfersRef.current.clear();
    inboxItemsRef.current.forEach((item) => {
      if (item.url) {
        URL.revokeObjectURL(item.url);
      }
    });
    setInboxItems([]);
    pushLog("Cleared received inbox.");
  }, [pushLog, sendControlMessage]);

  // Remove single inbox item and revoke its download URL

  // Wire the live data-channel listeners for chat, transfer, and close events
  const wireConnection = useCallback(
    (conn: DataConnection) => {
      activeConnRef.current = conn;
      setConnState(`Connected to ${conn.peer}`);
      pushLog(`Connection opened with ${conn.peer}`);
      if (conn.serialization !== "raw") {
        pushLog(
          `Connection serialization is ${conn.serialization}; for large file throughput prefer raw/none serialization.`,
          true
        );
      }

      conn.on("data", (data) => {
        if (typeof data === "string") {
          const control = parseControlMessage(data);
          if (!control) {
            pushLog(`Received: ${data}`);
            return;
          }

          if (control.kind === "chat-message") {
            pushLog(`Received: ${control.text}`);
            return;
          }

          if (control.kind === "transfer-start") {
            const source = control.label === "Folder" ? "Folder" : "Files";
            incomingTransferLabelRef.current = source;
            pushLog(`Incoming ${source.toLowerCase()} transfer: ${control.count ?? 0} item(s).`);
            return;
          }

          if (control.kind === "file-start") {
            beginInboxTransfer({
              kind: "file-start",
              transferId: control.transferId,
              source: control.source,
              name: control.name,
              mime: control.mime,
              size: control.size,
              totalChunks: control.totalChunks,
            });
            return;
          }

          if (control.kind === "file-chunk-meta") {
            pendingChunkMetaRef.current = {
              transferId: control.transferId,
              index: control.index,
              size: control.size,
            };
            return;
          }

          if (control.kind === "file-end") {
            if (cancelledIncomingTransfersRef.current.has(control.transferId)) {
              activeInboxTransfersRef.current.delete(control.transferId);
              pendingChunkMetaRef.current = null;
              return;
            }

            const transfer = activeInboxTransfersRef.current.get(control.transferId);
            if (!transfer) {
              pushLog(`Received file end without a matching transfer.`, true);
              return;
            }

            flushInboxTransfer(control.transferId);
            return;
          }

          if (control.kind === "transfer-cancel") {
            cancelledOutgoingTransfersRef.current.add(control.transferId);
            transferPromisesRef.current.get(control.transferId)?.reject(new Error("Transfer canceled by receiver"));
            transferPromisesRef.current.delete(control.transferId);
            sendingTransfersRef.current.delete(control.transferId);
            setSendingItems((prev) => prev.filter((item) => item.id !== control.transferId));
            pushLog(`Receiver canceled transfer ${control.transferId}.`);
            return;
          }

          if (control.kind === "call-end") {
            endActiveCall(control.reason, false);
            pushLog("Call ended by remote peer.");
            return;
          }

          return;
        }

        const meta = pendingChunkMetaRef.current;
        const buffer = extractArrayBuffer(data);

        if (!meta || !buffer) {
          pushLog("Received binary payload without chunk metadata.", true);
          return;
        }

        const transfer = activeInboxTransfersRef.current.get(meta.transferId);
        if (!transfer) {
          if (!cancelledIncomingTransfersRef.current.has(meta.transferId)) {
            pushLog("Received file chunk for unknown transfer.", true);
          }
          pendingChunkMetaRef.current = null;
          return;
        }

        transfer.chunks.push(buffer);
        transfer.receivedBytes += buffer.byteLength;
        transfer.lastTick = Date.now();
        pendingChunkMetaRef.current = null;
        updateInboxTransferProgress(meta.transferId);
      });

      conn.on("close", () => {
        pushLog("Connection closed");
        endActiveCall("disconnect", false);
        activeConnRef.current = null;
        pendingChunkMetaRef.current = null;
        setConnState("Not connected");
      });

      conn.on("error", (err) => {
        pushLog(`Connection error: ${err.message || err}`, true);
      });
    },
    [beginInboxTransfer, endActiveCall, extractArrayBuffer, flushInboxTransfer, parseControlMessage, pushLog, updateInboxTransferProgress]
  );

  // Destroy and recreate the PeerJS client with the current server settings
  const makePeer = useCallback((forceNewId = false) => {
    const connectWithId = (attempt = 0, baseId?: string) => {
      let desiredId = baseId;

      if (!desiredId) {
        const storedId = typeof window !== "undefined" ? localStorage.getItem(LOCAL_PEER_ID_KEY) : null;
        desiredId = forceNewId || !storedId ? generateSimplePeerId(8) : storedId;
      }

      if (typeof window !== "undefined") {
        localStorage.setItem(LOCAL_PEER_ID_KEY, desiredId);
      }

      if (peerRef.current) {
        endActiveCall("disconnect", false);
        try {
          peerRef.current.destroy();
        } catch (err) {
          pushLog(`Destroy warning: ${String(err)}`, true);
        }
      }

      activeConnRef.current = null;
      setConnState("Not connected");
      setMyId(desiredId);

      const options = {
        host: host.trim(),
        port: Number(port.trim() || 443),
        path: path.trim() || "/",
        secure: secure.trim().toLowerCase() !== "false",
        config: {
          iceServers: [
            {
              urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun.cloudflare.com:3478",
              ],
            },
            ...(process.env.NEXT_PUBLIC_TURN_URL
              ? [
                  {
                    urls: process.env.NEXT_PUBLIC_TURN_URL,
                    username: process.env.NEXT_PUBLIC_TURN_USERNAME,
                    credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
                  },
                ]
              : []),
          ],
          iceTransportPolicy: "all" as RTCIceTransportPolicy,
        },
      };

      pushLog(
        `Connecting with ${JSON.stringify({
          id: desiredId,
          host: options.host,
          port: options.port,
          path: options.path,
          secure: options.secure,
          hasTurnServer: Boolean(process.env.NEXT_PUBLIC_TURN_URL),
        })}`
      );
      const peer = new Peer(desiredId, options);
      peerRef.current = peer;

      peer.on("open", (id) => {
        setMyId(id);
        pushLog(`Peer ready. ID: ${id}`);
      });

      peer.on("connection", (conn) => {
        pushLog(`Incoming connection from ${conn.peer}`);
        conn.on("open", () => wireConnection(conn));
      });

      peer.on("call", async (call) => {
        pushLog(`Incoming call from ${call.peer}`);
        try {
          if (!localStreamRef.current) {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            setLocalStream(stream);
          }

          call.answer(localStreamRef.current ?? undefined);
          call.on("stream", (remoteStream) => {
            setRemoteStream(remoteStream);
            setCallType(remoteStream.getVideoTracks().length > 0 ? "video" : "audio");
            pushLog(`Call stream received from ${call.peer}`);
          });
          call.on("close", () => {
            endActiveCall("hangup", false);
            pushLog("Incoming call closed.");
          });
          call.on("error", (err) => pushLog(`Incoming call error: ${err.message || err}`, true));
          mediaConnRef.current = call;
        } catch (err) {
          pushLog(`Could not answer call: ${String(err)}`, true);
        }
      });

      peer.on("error", (err) => {
        if ((err as { type?: string }).type === "unavailable-id" && attempt < 2) {
          pushLog("Peer ID collision detected. Generating a new ID...", true);
          const nextId = generateSimplePeerId(8);
          if (typeof window !== "undefined") {
            localStorage.setItem(LOCAL_PEER_ID_KEY, nextId);
          }
          connectWithId(attempt + 1, nextId);
          return;
        }

        pushLog(`Peer error: ${err.type || ""} ${err.message || err}`.trim(), true);
      });
    };

    connectWithId();
  }, [endActiveCall, host, path, port, pushLog, secure, setLocalStream, setRemoteStream, wireConnection]);

  // Apply the cloud or local defaults when the mode changes
  const applyModeDefaults = useCallback(
    (nextMode: "cloud" | "local") => {
      if (nextMode === "local") {
        setHost("localhost");
        setPort("9000");
        setPath("/myapp");
        setSecure("false");
        return;
      }
      setHost("0.peerjs.com");
      setPort("443");
      setPath("/");
      setSecure("true");
    },
    []
  );

  // Open data connection to target peer ID
  const connectToTarget = useCallback(() => {
    if (!peerRef.current) {
      pushLog("Peer is not initialized .", true);
      return;
    }

    const trimmed = targetId.trim();
    if (!trimmed) {
      pushLog("Please enter a target peer ID first.", true);
      return;
    }

    const conn = peerRef.current.connect(trimmed, {
      reliable: true,
      serialization: "raw",
      metadata: {
        transferProfile: "raw-binary-v1",
      },
    });
    conn.on("open", () => wireConnection(conn));
  }, [pushLog, targetId, wireConnection]);

  // Close current connection and reset UI state
  const disconnectFromTarget = useCallback(() => {
    if (!activeConnRef.current) {
      pushLog("No active connection to disconnect.", true);
      return;
    }

    endActiveCall("disconnect", true);

    try {
      activeConnRef.current.close();
    } catch (err) {
      pushLog(`Disconnect warning: ${String(err)}`, true);
    }

    activeConnRef.current = null;
    setConnState("Not connected");
    pushLog("Disconnected from peer.");
  }, [endActiveCall, pushLog]);

  // Send chat line that currently typed into input box
  const sendCurrentMessage = useCallback(() => {
    if (!requireConnection()) {
      return;
    }

    const text = message.trim();
    if (!text) {
      pushLog("Message is empty.", true);
      return;
    }

    const payload = sender.trim() ? `${sender.trim()}: ${text}` : text;
    if (activeConnRef.current) {
      sendControlMessage(activeConnRef.current, {
        kind: "chat-message",
        text: payload,
      });
    }
    pushLog(`Sent: ${payload}`);
    setMessage("");
  }, [message, pushLog, requireConnection, sendControlMessage, sender]);

  // Stream files through worker so UI thread stays responsive
  const sendFilePayloads = useCallback(
    async (files: FileList | null, label: "Files" | "Folder") => {
      if (!requireConnection()) {
        return;
      }
      if (!files || files.length === 0) {
        pushLog(`No ${label.toLowerCase()} selected.`, true);
        return;
      }

      const worker = transferWorkerRef.current;
      if (!worker) {
        pushLog("Transfer worker is not ready . Please retry in a second.", true);
        return;
      }

      if (activeConnRef.current) {
        sendControlMessage(activeConnRef.current, {
          kind: "transfer-start",
          label,
          count: files.length,
        });
      }

      for (const file of Array.from(files)) {
        const transferId = `${Date.now()}-${Math.random()}`;
        const mime = file.type || "application/octet-stream";
        const fileName = file.webkitRelativePath || file.name;

        if (isLikelyCompressed(fileName, mime)) {
          pushLog(`Skipping app-level compression for ${fileName}; file is already compressed or media.`);
        }

        beginOutgoingTransfer(transferId, label, fileName, file.size, Math.ceil(file.size / FILE_CHUNK_SIZE));

        const completion = new Promise<void>((resolve, reject) => {
          transferPromisesRef.current.set(transferId, { resolve, reject });
        });

        worker.postMessage({
          type: "prepare-file",
          transferId,
          source: label,
          file,
          chunkSize: FILE_CHUNK_SIZE,
        } satisfies WorkerInboundMessage);

        try {
          await completion;
          pushLog(`Sent ${label.toLowerCase()}: ${fileName} (${formatBytes(file.size)})`);
        } catch (err) {
          pushLog(`Transfer canceled/failed for ${fileName}: ${String(err)}`, true);
        }
      }

      pushLog(`${label} upload complete. ${files.length} item(s) sent successfully.`);
    },
    [
      beginOutgoingTransfer,
      isLikelyCompressed,
      pushLog,
      requireConnection,
      sendControlMessage,
    ]
  );

  // Start media call
  const startCall = useCallback(
    async (kind: "audio" | "video") => {
      if (!requireConnection()) {
        return;
      }
      if (!peerRef.current || !activeConnRef.current) {
        pushLog("Peer connection is not ready.", true);
        return;
      }

      const constraints =
        kind === "video" ? { audio: true, video: true } : { audio: true, video: false };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        setLocalStream(stream);

        if (mediaConnRef.current) {
          mediaConnRef.current.close();
        }

        const call = peerRef.current.call(activeConnRef.current.peer, stream);
        mediaConnRef.current = call;
        setCallType(kind);

        call.on("stream", (remoteStream) => {
          setRemoteStream(remoteStream);
          pushLog(`${kind === "video" ? "Video" : "Audio"} call connected.`);
        });
        call.on("close", () => {
          endActiveCall("hangup", false);
          pushLog("Call closed.");
        });
        call.on("error", (err) => pushLog(`Call error: ${err.message || err}`, true));
        pushLog(`Starting ${kind} call to ${activeConnRef.current.peer}`);
      } catch (err) {
        pushLog(`Could not start ${kind} call: ${String(err)}`, true);
      }
    },
    [endActiveCall, pushLog, requireConnection, setLocalStream, setRemoteStream]
  );

  // End the active call and stop audio-video capture
  const endCall = useCallback(() => {
    if (!mediaConnRef.current && !localStreamRef.current) {
      pushLog("No active call to end.", true);
      return;
    }

    endActiveCall("hangup", true);
    pushLog("Call ended.");
  }, [endActiveCall, pushLog]);

  // Toggle the microphone track without disconnecting call
  const toggleMic = useCallback(() => {
    const next = !micEnabled;
    micEnabledRef.current = next;
    setMicEnabled(next);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    pushLog(next ? "Microphone enabled." : "Microphone muted.");
  }, [micEnabled, pushLog]);

  // Toggle the camera track without destroying the call (still working on it)
  const toggleCamera = useCallback(() => {
    const next = !cameraEnabled;
    cameraEnabledRef.current = next;
    setCameraEnabled(next);

    const videoTracks = localStreamRef.current?.getVideoTracks() ?? [];
    if (videoTracks.length === 0) {
      pushLog("No camera track available in current call.", true);
      return;
    }

    videoTracks.forEach((track) => {
      track.enabled = next;
    });
    pushLog(next ? "Camera enabled." : "Camera disabled.");
  }, [cameraEnabled, pushLog]);

  // Update file/folder status cards when a picker changes
  const onFilesSelected = useCallback(
    (files: FileList | null, label: "file" | "folder") => {
      const entries = files ? Array.from(files) : [];
      const summary = summarizeSelection(entries);

      if (label === "file") {
        setUploadedFiles(entries.map((file) => ({ path: file.name, size: file.size })));
      } else {
        setUploadedFolderFiles(entries.map((file) => ({ path: file.webkitRelativePath || file.name, size: file.size })));
      }

      if (summary.ready) {
        pushLog(
          `${label === "file" ? "Files" : "Folder"} uploaded: ${summary.count} item(s), ${formatBytes(summary.totalBytes)}. Ready to send.`
        );
      }
    },
    [pushLog, summarizeSelection]
  );

  // Copy peer ID
  const copyPeerId = useCallback(async () => {
    const id = myId.trim();
    if (!id || id === "Connecting...") {
      pushLog("Peer ID is not ready .", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(id);
      pushLog(`Copied peer ID: ${id}`);
    } catch (err) {
      pushLog(`Could not copy peer ID: ${String(err)}`, true);
    }
  }, [myId, pushLog]);

  

  const copyShareLink = useCallback(async () => {
    if (!peerShareLink) {
      pushLog("Peer share link is not ready yet.", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(peerShareLink);
      pushLog("Copied share link.");
    } catch (err) {
      pushLog(`Could not copy share link: ${String(err)}`, true);
    }
  }, [peerShareLink, pushLog]);

  const loadTrustedConnections = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from("trusted_connections")
      .select("peer_id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      pushLog(`Could not load trusted connections: ${error.message}`, true);
      return;
    }

    const peers = Array.from(new Set((data ?? []).map((row) => row.peer_id).filter(Boolean)));
    setTrustedPeers(peers);
  }, [pushLog]);

  const signUpAccount = useCallback(async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      pushLog("Email and password are required for sign up.", true);
      return;
    }

    const { error } = await supabase.auth.signUp({
      email: authEmail.trim(),
      password: authPassword,
    });

    if (error) {
      pushLog(`Sign up failed: ${error.message}`, true);
      return;
    }

    pushLog("Sign up succeeded. Check your email if confirmation is enabled.");
  }, [authEmail, authPassword, pushLog]);

  const signInAccount = useCallback(async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      pushLog("Email and password are required for sign in.", true);
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword,
    });

    if (error) {
      pushLog(`Sign in failed: ${error.message}`, true);
      return;
    }

    pushLog("Signed in.");
  }, [authEmail, authPassword, pushLog]);

  const signOutAccount = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      pushLog(`Sign out failed: ${error.message}`, true);
      return;
    }
    setTrustedPeers([]);
    setAuthUserId(null);
    pushLog("Signed out.");
  }, [pushLog]);

  const saveTrustedConnection = useCallback(async () => {
    if (!authUserId) {
      pushLog("Sign in first to save trusted connections.", true);
      return;
    }

    const peerId = targetId.trim();
    if (!peerId) {
      pushLog("Enter a target peer ID before saving trusted connection.", true);
      return;
    }

    const { error } = await supabase.from("trusted_connections").insert({
      user_id: authUserId,
      peer_id: peerId,
    });

    if (error) {
      pushLog(`Could not save trusted connection: ${error.message}`, true);
      return;
    }

    setTrustedPeers((prev) => (prev.includes(peerId) ? prev : [peerId, ...prev]));
    pushLog(`Trusted connection saved for ${peerId}.`);
  }, [authUserId, pushLog, targetId]);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data }) => {
      const userId = data.session?.user.id ?? null;
      if (!mounted) {
        return;
      }
      setAuthUserId(userId);
      if (userId) {
        void loadTrustedConnections(userId);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const userId = session?.user.id ?? null;
      setAuthUserId(userId);
      if (userId) {
        void loadTrustedConnections(userId);
      } else {
        setTrustedPeers([]);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [loadTrustedConnections]);

  // Start/stop worker when the component unmounts
  useEffect(() => {
    const worker = new Worker("/workers/transfer-worker.js");
    transferWorkerRef.current = worker;
    const transferPromises = transferPromisesRef.current;
    const workerQueue = workerQueueRef.current;

    worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
      workerQueueRef.current.push(event.data);
      void drainWorkerQueue();
    };

    worker.onerror = (event) => {
      pushLog(`Transfer worker failed: ${event.message}`, true);
    };

    return () => {
      transferWorkerRef.current?.terminate();
      transferWorkerRef.current = null;
      workerQueue.length = 0;
      transferPromises.clear();
    };
  }, [drainWorkerQueue, pushLog]);

  // Poll WebRTC stats so the diagnostics panel stays live
  useEffect(() => {
    let timer: number | null = null;

    const updateDiagnostics = async () => {
      const conn = activeConnRef.current;
      const channel = getRtcDataChannel(conn);
      const peerConnection = getRtcPeerConnection(conn);

      if (!conn || !channel || !conn.open) {
        setDiagnostics({
          dataChannelState: channel?.readyState ?? "closed",
          bufferedAmount: 0,
          rttMs: null,
          route: "unknown",
        });
        return;
      }

      let rttMs: number | null = null;
      let route: "direct" | "relay" | "unknown" = "unknown";

      if (peerConnection) {
        try {
          const stats = await peerConnection.getStats();
          const reports = Array.from(stats.values());
          const candidatePair = reports.find((report) => {
            return (
              report.type === "candidate-pair" &&
              (report as RTCStats & { state?: string; selected?: boolean }).state === "succeeded" &&
              (report as RTCStats & { nominated?: boolean; selected?: boolean }).nominated
            );
          }) as (RTCStats & {
            currentRoundTripTime?: number;
            selected?: boolean;
            localCandidateId?: string;
            remoteCandidateId?: string;
          }) | undefined;

          const selectedPair =
            candidatePair ??
            (reports.find((report) => {
              return (
                report.type === "candidate-pair" &&
                (report as RTCStats & { selected?: boolean }).selected
              );
            }) as (RTCStats & {
              currentRoundTripTime?: number;
              localCandidateId?: string;
              remoteCandidateId?: string;
            }) | undefined);

          if (selectedPair?.currentRoundTripTime !== undefined) {
            rttMs = selectedPair.currentRoundTripTime * 1000;
          }

          if (selectedPair?.localCandidateId || selectedPair?.remoteCandidateId) {
            const localCandidate = reports.find((report) => report.id === selectedPair.localCandidateId) as
              | (RTCStats & { candidateType?: string })
              | undefined;
            const remoteCandidate = reports.find((report) => report.id === selectedPair.remoteCandidateId) as
              | (RTCStats & { candidateType?: string })
              | undefined;

            if (localCandidate?.candidateType === "relay" || remoteCandidate?.candidateType === "relay") {
              route = "relay";
            } else if (localCandidate?.candidateType || remoteCandidate?.candidateType) {
              route = "direct";
            }
          }
        } catch {
          // Stats can fail in some browsers; keep previous-friendly fallback values.
        }
      }

      setDiagnostics({
        dataChannelState: channel.readyState,
        bufferedAmount: channel.bufferedAmount,
        rttMs,
        route,
      });
    };

    void updateDiagnostics();
    timer = window.setInterval(() => {
      void updateDiagnostics();
    }, 1000);

    return () => {
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, [connState, getRtcDataChannel, getRtcPeerConnection]);

  // Build the PeerJS client when the page first loads (skeleton)
  useEffect(() => {
    const peerInitTimer = window.setTimeout(() => {
      makePeer();
    }, 0);

    return () => {
      window.clearTimeout(peerInitTimer);
      stopStream(localStreamRef.current);
      mediaConnRef.current?.close();
      activeConnRef.current?.close();
      peerRef.current?.destroy();
      stopAudioMeter();
      clearMediaStreams();
      inboxItemsRef.current.forEach((item) => {
        if (item.url) {
          URL.revokeObjectURL(item.url);
        }
      });
    };
  }, [clearMediaStreams, makePeer, stopAudioMeter, stopStream]);

  // Keep log scroller pinned to newest event
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  // Mirror inbox items into a ref so cleanup can revoke object URLs safely
  useEffect(() => {
    inboxItemsRef.current = inboxItems;
  }, [inboxItems]);

  // Mirror sender progress items into a ref for symmetry and cleanup
  useEffect(() => {
    sendingItemsRef.current = sendingItems;
  }, [sendingItems]);

  // Enable directory selection on supported browsers for folder uploads
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    cameraEnabledRef.current = cameraEnabled;
  }, [cameraEnabled]);

  // Render audio meter
  useEffect(() => {
    const stream = localStreamRef.current;
    if (!stream || callType !== "audio") {
      stopAudioMeter();
      return;
    }

    try {
      const AudioContextImpl =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextImpl) {
        return;
      }

      const context = new AudioContextImpl();
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.75;

      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = context;
      analyserRef.current = analyser;
      sourceNodeRef.current = source;

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(buffer);
        const total = buffer.reduce((sum, value) => sum + value, 0);
        const level = total / (buffer.length * 255);
        setAudioLevel(level);
        animationFrameRef.current = requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch {
      // If audio context setup fails, keep visualizer at its last known state
    }

    return () => {
      stopAudioMeter();
    };
  }, [callType, stopAudioMeter, streamVersion]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#030712] via-[#0b1120] to-[#111827] text-slate-100 flex flex-col">
      <SpeedInsights />
      
      {/* Top bar */}
      <div className="border-b border-slate-800 bg-[#020617]/80 backdrop-blur px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight">My<span className="text-cyan-500">FTP</span></h1>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-700 bg-slate-900/50 text-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            <span className="font-mono font-semibold">{myId}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={copyPeerId} aria-label="Copy peer ID">Copy ID</Button>
          <Button variant="outline" size="sm" onClick={copyShareLink} aria-label="Copy share link">Share</Button>
          <Button variant="outline" size="sm" onClick={() => makePeer(true)} aria-label="Generate new ID">New ID</Button>
          <Button variant="destructive" size="sm" onClick={() => makePeer()} aria-label="Reconnect">Reconnect</Button>
        </div>
      </div>

      {/* Three-column main layout */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-0 bg-gradient-to-br from-[#030712] via-[#0b1120] to-[#111827]">
        
        {/* Left column: Peer connection & account */}
        <div className="border-r border-slate-800 bg-[#020617]/60 overflow-y-auto sm:col-span-1">
          <div className="p-4 space-y-6">
            {/* Connect to peer section */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Connect</h2>
              <Input
                aria-label="Target peer ID"
                placeholder="Enter peer ID…"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (connState === "Not connected") connectToTarget();
                    else disconnectFromTarget();
                  }
                }}
              />
              <Input
                aria-label="Display name"
                placeholder="Name (optional)"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
              />
              <Button
                variant="default"
                className="w-full"
                onClick={() => {
                  if (connState === "Not connected") connectToTarget();
                  else disconnectFromTarget();
                }}
                aria-label={connState === "Not connected" ? "Connect" : "Disconnect"}
              >
                {connState === "Not connected" ? "Connect" : "Disconnect"}
              </Button>
              <div className="text-xs text-slate-400">
                Status: <span className="font-mono font-semibold text-slate-100">{connState}</span>
              </div>
            </div>

            <div className="h-px bg-slate-700"></div>

            {/* Trusted peers section */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Trusted Peers</h2>
              {trustedPeers.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No trusted peers saved yet.</p>
              ) : (
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {trustedPeers.map((peerId) => (
                    <div key={peerId} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-700 bg-slate-800/30 hover:bg-slate-800/60 transition text-xs">
                      <span className="font-mono text-slate-300 truncate flex-1">{peerId}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setTargetId(peerId);
                          window.setTimeout(() => connectToTarget(), 0);
                        }}
                        aria-label={`Connect to ${peerId}`}
                      >
                        Go
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={saveTrustedConnection}
                aria-label="Save as trusted"
              >
                Save Current
              </Button>
            </div>

            <div className="h-px bg-slate-700"></div>

            {/* Account section */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Account</h2>
              <Input
                id="email-input"
                aria-label="Email"
                placeholder="Email"
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
              />
              <Input
                id="password-input"
                aria-label="Password"
                placeholder="Password"
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="default" size="sm" onClick={signUpAccount}>Sign Up</Button>
                <Button variant="default" size="sm" onClick={signInAccount}>Sign In</Button>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={signOutAccount}>Sign Out</Button>
              <p className="text-xs text-slate-400">{authUserId ? `Signed in: ${authUserId.slice(0, 8)}...` : "Not signed in"}</p>
            </div>
          </div>
        </div>

        {/* Center column: Tabbed interface */}
        <div className="border-r border-slate-800 bg-[#0a0f1f] overflow-hidden flex flex-col sm:col-span-2 lg:col-span-2">
          <Tabs value={panelTab} onValueChange={(value) => setPanelTab(value as "transfer" | "call" | "chat" | "diag" | "settings")} className="flex flex-col h-full">
            <TabsList className="border-b border-slate-700 px-4 flex gap-1 bg-slate-900/30 overflow-x-auto rounded-none">
              <TabsTrigger value="transfer" className="text-xs whitespace-nowrap">Files</TabsTrigger>
              <TabsTrigger value="chat" className="text-xs whitespace-nowrap">Chat</TabsTrigger>
              <TabsTrigger value="call" className="text-xs whitespace-nowrap">Calls</TabsTrigger>
              <TabsTrigger value="diag" className="text-xs whitespace-nowrap">Diagnostics</TabsTrigger>
              <TabsTrigger value="settings" className="text-xs whitespace-nowrap">Settings</TabsTrigger>
            </TabsList>

            {/* Transfer/Files tab */}
            <TabsContent value="transfer" className="flex-1 overflow-y-auto p-4">
              <div className="space-y-4">
                {/* Quick actions */}
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} aria-label="Add files">Add Files</Button>
                  <Button variant="secondary" size="sm" onClick={() => folderInputRef.current?.click()} aria-label="Add folder">Add Folder</Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="default" size="sm" onClick={() => sendFilePayloads(fileInputRef.current?.files ?? null, "Files")}>Send Files</Button>
                  <Button variant="default" size="sm" onClick={() => sendFilePayloads(folderInputRef.current?.files ?? null, "Folder")}>Send Folder</Button>
                </div>

                <h3 className="text-sm font-semibold pt-4">Active Transfers</h3>
                {sendingItems.length === 0 ? (
                  <p className="text-xs text-slate-500">No active transfers</p>
                ) : (
                  <div className="space-y-2">
                    {sendingItems.map((item) => (
                      <div key={item.id} className="rounded-lg border border-slate-700 bg-slate-800/30 p-2">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-xs font-medium truncate flex-1">{item.name}</span>
                          <span className="text-xs text-slate-400">{formatBytes(item.size)}</span>
                        </div>
                        <Progress value={Math.min(Math.max(item.progress * 100, 0), 100)} className="h-1.5" />
                        <div className="text-xs text-slate-400 mt-1">{item.complete ? "Done" : `${Math.round(item.progress * 100)}%`}</div>
                      </div>
                    ))}
                  </div>
                )}

                <h3 className="text-sm font-semibold pt-4">Received Files</h3>
                {inboxItems.length === 0 ? (
                  <p className="text-xs text-slate-500">No received files</p>
                ) : (
                  <div className="space-y-2">
                    {inboxItems.map((item) => (
                      <div key={item.id} className="rounded-lg border border-slate-700 bg-slate-800/30 p-2">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <span className="text-xs font-medium truncate flex-1">{item.name}</span>
                          <span className="text-xs text-slate-400">{formatBytes(item.size)}</span>
                        </div>
                        <Progress value={Math.min(Math.max(item.progress * 100, 0), 100)} className="h-1.5" />
                        <div className="text-xs text-slate-400 mt-1">{item.complete ? "Ready" : `${Math.round(item.progress * 100)}%`}</div>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-xs text-slate-500 pt-2">DO NOT close this tab during transfers</p>
              </div>
            </TabsContent>

            {/* Chat tab */}
            <TabsContent value="chat" className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-2 text-xs font-mono" ref={logContainerRef} role="log" aria-live="polite">
                {logs.slice(-50).map((row) => (
                  <div key={row.id} className={row.error ? "text-rose-400" : row.text.includes("Sent:") ? "text-cyan-400" : "text-slate-300"}>
                    {row.text}
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-700 p-3 bg-slate-900/30 flex gap-2">
                <Input
                  aria-label="Message"
                  placeholder="Type message…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendCurrentMessage(); }}
                  className="flex-1 text-xs"
                />
                <Button variant="secondary" size="sm" onClick={sendCurrentMessage}>Send</Button>
              </div>
            </TabsContent>

            {/* Calls tab */}
            <TabsContent value="call" className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Button variant="default" onClick={() => startCall("audio")} aria-label="Audio call">Audio</Button>
                <Button variant="default" onClick={() => startCall("video")} aria-label="Video call">Video</Button>
              </div>
              <Button variant="destructive" className="w-full" onClick={endCall}>End Call</Button>
              <div className="flex gap-2">
                <Button variant={micEnabled ? "secondary" : "destructive"} className="flex-1" onClick={toggleMic}>{micEnabled ? "🔊" : "🔇"} Mic</Button>
                <Button variant={cameraEnabled ? "secondary" : "destructive"} className="flex-1" onClick={toggleCamera}>{cameraEnabled ? "📹" : "❌"} Cam</Button>
              </div>

              {callType === "audio" && (
                <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-3">
                  <p className="text-xs text-slate-400 mb-2">Voice Activity</p>
                  <div className="flex h-12 items-end gap-1">
                    {Array.from({ length: 18 }).map((_, i) => {
                      const wave = Math.min(1, audioLevel + ((i % 3) + 1) * 0.08);
                      const height = 4 + Math.round(wave * 32);
                      return (
                        <span
                          key={`wave-${i}`}
                          className="w-1 rounded-sm bg-cyan-400/85"
                          style={{ height }}
                          aria-hidden="true"
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-2">
                  <p className="text-slate-400 mb-2">Local</p>
                  <video ref={localVideoRef} autoPlay playsInline muted className="w-full rounded h-24 bg-slate-900" aria-label="Local video" />
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-800/30 p-2">
                  <p className="text-slate-400 mb-2">Remote</p>
                  <video ref={remoteVideoRef} autoPlay playsInline className="w-full rounded h-24 bg-slate-900" aria-label="Remote video" />
                </div>
              </div>
            </TabsContent>

            {/* Diagnostics tab */}
            <TabsContent value="diag" className="flex-1 overflow-y-auto p-4">
              <div className="space-y-3 font-mono text-xs bg-slate-800/30 border border-slate-700 rounded-lg p-3">
                <div className="flex justify-between"><span>Data channel</span><span className={diagnostics.dataChannelState === "open" ? "text-emerald-400" : "text-amber-400"}>{diagnostics.dataChannelState}</span></div>
                <div className="flex justify-between"><span>Buffered</span><span className={diagnostics.bufferedAmount > BUFFER_HIGH_WATERMARK ? "text-rose-400" : "text-emerald-400"}>{formatBytes(diagnostics.bufferedAmount)}</span></div>
                <div className="flex justify-between"><span>Ping (RTT)</span><span className={diagnostics.rttMs === null ? "text-amber-400" : diagnostics.rttMs > 220 ? "text-rose-400" : "text-emerald-400"}>{formatLatency(diagnostics.rttMs)}</span></div>
                <div className="flex justify-between"><span>Route</span><span className="text-slate-400">{diagnostics.route}</span></div>
              </div>
              <p className="text-xs text-slate-500 mt-4">Updates every second during active connections.</p>
            </TabsContent>

            {/* Settings tab */}
            <TabsContent value="settings" className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <label htmlFor="mode-select" className="text-xs font-medium text-slate-400 block mb-2">Peer Server</label>
                <Select value={mode} onValueChange={(m) => {
                  setMode(m as "cloud" | "local");
                  applyModeDefaults(m as "cloud" | "local");
                }}>
                  <SelectTrigger id="mode-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud">Cloud (PeerJS)</SelectItem>
                    <SelectItem value="local">Local server</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input aria-label="Host" placeholder="Host" value={host} onChange={(e) => setHost(e.target.value)} />
              <Input aria-label="Port" placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
              <Input aria-label="Path" placeholder="Path" value={path} onChange={(e) => setPath(e.target.value)} />
              <Input aria-label="Secure" placeholder="Secure (true/false)" value={secure} onChange={(e) => setSecure(e.target.value)} />
              <p className="text-xs text-slate-500">{modeHint}</p>
            </TabsContent>
          </Tabs>
        </div>

        {/* Right column: File downloads & transfer queue */}
        <div className="border-l border-slate-800 bg-[#020617]/60 overflow-y-auto sm:col-span-1 lg:col-span-1">
          <div className="p-4 space-y-6">
            {/* Received inbox */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Downloads</h2>
                <span className="text-xs text-slate-500 bg-slate-800/50 px-2 py-1 rounded">{inboxItems.filter(i => i.complete).length}</span>
              </div>
              {inboxItems.length === 0 ? (
                <p className="text-xs text-slate-500">No items</p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {inboxItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-700 bg-slate-800/30 text-xs">
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-medium">{item.name}</p>
                        <p className="text-slate-500">{formatBytes(item.size)}</p>
                      </div>
                      {item.complete && (
                        <Button size="sm" variant="secondary" onClick={() => downloadInboxFile(item)} aria-label={`Download ${item.name}`}>↓</Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={downloadAll}>All</Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={clearInbox}>Clear</Button>
              </div>
            </div>

            <div className="h-px bg-slate-700"></div>

            {/* Upload queue notification */}
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Queue</h2>
              {uploadedFiles.length + uploadedFolderFiles.length === 0 ? (
                <p className="text-xs text-slate-500">No files queued</p>
              ) : (
                <div className="bg-slate-800/30 border border-slate-700 rounded-lg p-2">
                  <p className="text-xs font-mono font-semibold">{uploadedFiles.length + uploadedFolderFiles.length} item(s) ready</p>
                  <p className="text-xs text-slate-400 mt-1">Use Files tab to send</p>
                </div>
              )}
            </div>

            <div className="h-px bg-slate-700"></div>

            {/* Server info */}
            <div className="space-y-3 text-xs">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">Info</h2>
              <div className="bg-slate-800/30 border border-slate-700 rounded-lg p-2 space-y-1 font-mono text-slate-400">
                <p>Status: <span className="text-emerald-400 font-semibold">Active</span></p>
                <p>Mode: <span className="text-cyan-400 font-semibold">{mode === "cloud" ? "Cloud" : "Local"}</span></p>
                <p className="text-slate-500 text-xs mt-2">Keep tab open during transfers</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} className="hidden" type="file" multiple onChange={(e) => onFilesSelected(e.target.files, "file")} />
      <input ref={folderInputRef} className="hidden" type="file" multiple onChange={(e) => onFilesSelected(e.target.files, "folder")} />
    </div>
  );
}