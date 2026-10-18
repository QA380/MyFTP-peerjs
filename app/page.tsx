"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import Peer, { DataConnection, MediaConnection } from "peerjs";
import JSZip from "jszip";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Progress } from "@/components/animate-ui/components/radix/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/animate-ui/components/radix/tabs";
import { Button } from "@/components/animate-ui/components/radix/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/animate-ui/components/radix/sheet";
import { Input } from "@/components/animate-ui/primitives/radix/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/animate-ui/primitives/radix/select";
import { supabase } from "@/lib/supabase";
import { createReceiveSink, type ReceiveSink } from "@/lib/receive-sink";
import { canHashChunks, combineChunkHashes, hashChunk } from "@/lib/chunk-hash";
import {
  ArrowUpFromLine,
  Check,
  Copy,
  Download,
  FileIcon,
  FolderIcon,
  FolderUp,
  Link2,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  QrCode,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserRound,
  Video,
  VideoOff,
  WifiOff,
  X,
} from "lucide-react";


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

type TransferStatus = "queued" | "sending" | "receiving" | "waiting" | "verifying" | "done" | "failed";

// Inbox entry for an incoming transfer
type InboxItem = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  size: number;
  mime: string;
  url: string;
  progress: number;
  rate: number;
  eta: number | null;
  status: TransferStatus;
  // true = checksum matched, false = mismatch, null = not checked
  verified: boolean | null;
  batchId: string | null;
  error?: string;
  complete: boolean;
};

// File description shared by file-start and resume-query
type FileTransferHeader = {
  transferId: string;
  // Numeric id carried in every binary chunk frame of this file
  slot: number;
  source: "Files" | "Folder";
  name: string;
  mime: string;
  size: number;
  // Payload bytes per chunk; fixed for the whole file so resume offsets stay valid
  chunkSize: number;
  totalChunks: number;
};

// Smoothed throughput so ETAs follow the current speed instead of the lifetime average
type RateTracker = {
  sampleAt: number;
  sampleBytes: number;
  rate: number;
};

// Track a received transfer while chunks are still arriving
type ActiveInboxTransfer = FileTransferHeader & {
  id: string;
  receivedBytes: number;
  // Index of the next chunk expected; also the resume point after a reconnect
  nextIndex: number;
  sink: ReceiveSink;
  chunkHashes: Promise<ArrayBuffer>[];
  startedAt: number;
  rate: RateTracker;
  lastUiAt: number;
  batchId: string | null;
  finalizing: Promise<boolean | null> | null;
};

// Track transfer progress
type ActiveOutgoingTransfer = {
  id: string;
  size: number;
  sentBytes: number;
  rate: RateTracker;
  lastUiAt: number;
};

// Progress row displayed for outgoing transfers
type OutgoingItem = {
  id: string;
  source: "Files" | "Folder";
  name: string;
  size: number;
  progress: number;
  rate: number;
  eta: number | null;
  status: TransferStatus;
  verified: boolean | null;
  batchId: string;
  complete: boolean;
};

// Incoming batch announced by transfer-start
type IncomingBatch = {
  id: string;
  count: number;
  totalBytes: number;
};

type ReconnectStatus = {
  peerId: string;
  attempt: number;
  // "dialing" when this side reconnects, "waiting" when the other side is expected to
  mode: "dialing" | "waiting";
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
      totalBytes?: number;
      batchId?: string;
    }
  | ({ kind: "file-start" } & FileTransferHeader)
  | {
      kind: "file-end";
      transferId: string;
      // Chunk-list SHA-256 fingerprint; null when the sender cannot hash
      hash?: string | null;
    }
  // Sender asks where to continue after a reconnect
  | ({ kind: "resume-query" } & FileTransferHeader)
  | {
      kind: "resume-offset";
      transferId: string;
      nextIndex: number;
      complete: boolean;
      verified?: boolean | null;
    }
  // Receiver confirms the file is saved (and whether the checksum matched)
  | {
      kind: "file-ack";
      transferId: string;
      verified: boolean | null;
    }
  | {
      kind: "transfer-cancel";
      transferId: string;
    }
  | {
      kind: "call-end";
      reason: "hangup" | "disconnect";
    }
  // Sent before an intentional disconnect so the peer does not try to reconnect
  | {
      kind: "bye";
    };

const CONTROL_KINDS = new Set<ControlMessage["kind"]>([
  "chat-message",
  "transfer-start",
  "file-start",
  "file-end",
  "resume-query",
  "resume-offset",
  "file-ack",
  "transfer-cancel",
  "call-end",
  "bye",
]);

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

// Every file chunk travels as ONE binary message: a 12-byte header followed by the payload.
//   byte 0      frame type (FRAME_FILE_CHUNK)
//   bytes 4-7   transfer slot (uint32, assigned by the sender in file-start)
//   bytes 8-11  chunk index (uint32)
// This replaced a JSON metadata message before every chunk, which doubled the message count.
const FRAME_HEADER_BYTES = 12;
const FRAME_FILE_CHUNK = 1;
// Largest message we use; Chrome negotiates 256 KiB, and bigger messages mean less per-message overhead
const MAX_FRAME_BYTES = 256 * 1024;
// Used when the browser does not report the negotiated SCTP message limit
const FALLBACK_FRAME_BYTES = 64 * 1024;
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024;
// Sending resumes once the outbound buffer drains to this level (event-driven, so it keeps
// working in background tabs where timers are throttled to once per second or slower)
const BUFFER_LOW_WATERMARK = 2 * 1024 * 1024;
// Files sent but not yet acknowledged; acks are awaited in the background so a folder of small
// files is not paced by one round-trip per file
const MAX_UNCONFIRMED_FILES = 16;
// Re-render progress at most this often per transfer
const UI_UPDATE_INTERVAL_MS = 200;
// All list/log state changes are batched into one React update this often
const UI_FLUSH_INTERVAL_MS = 100;
// A first connection attempt that has not opened by then is reported as failed
const CONNECT_TIMEOUT_MS = 20000;
const RATE_SAMPLE_INTERVAL_MS = 500;
// How long transfers wait for a dropped peer to come back before failing
const RECONNECT_WINDOW_MS = 2 * 60 * 1000;
const RECONNECT_DELAYS_MS = [500, 3000, 5000, 8000, 10000];
// An ICE link stuck in "disconnected" this long is treated as dropped
const ICE_STALL_MS = 8000;
const RESUME_REPLY_TIMEOUT_MS = 15000;
const MAX_RESUME_ATTEMPTS = 5;
const ACK_TIMEOUT_MS = 2 * 60 * 1000;

const DATA_CONNECTION_OPTIONS = {
  reliable: true,
  serialization: "raw",
  metadata: {
    transferProfile: "raw-binary-v2",
  },
} as const;

// The data channel dropped; the transfer can resume once the peer reconnects
class ConnectionLostError extends Error {
  constructor() {
    super("Connection lost");
    this.name = "ConnectionLostError";
  }
}

// The peer is gone for good (manual disconnect, or it never came back)
class PeerGoneError extends Error {
  constructor(message = "Peer disconnected") {
    super(message);
    this.name = "PeerGoneError";
  }
}

class ReplyTimeoutError extends Error {
  constructor() {
    super("Peer did not reply in time");
    this.name = "ReplyTimeoutError";
  }
}

const createId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// Copy only the file description out of a file-start / resume-query message
const toTransferHeader = ({ transferId, slot, source, name, mime, size, chunkSize, totalChunks }: FileTransferHeader): FileTransferHeader => ({
  transferId,
  slot,
  source,
  name,
  mime,
  size,
  chunkSize,
  totalChunks,
});

// Chunk payload size for this link: as large as the negotiated SCTP message limit allows
const pickChunkSize = (peerConnection: RTCPeerConnection | null): number => {
  const negotiated = peerConnection?.sctp?.maxMessageSize;
  // 0 means "no limit" per spec; undefined/null means the browser does not say
  const limit = negotiated === 0 ? MAX_FRAME_BYTES : Math.min(negotiated || FALLBACK_FRAME_BYTES, MAX_FRAME_BYTES);
  return Math.floor((limit - FRAME_HEADER_BYTES) / 1024) * 1024;
};

// Read one chunk as a ready-to-send frame; the Blob join lets the browser fill one buffer in one pass
const readChunkFrame = async (file: File, slot: number, index: number, chunkSize: number) => {
  const header = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint8(0, FRAME_FILE_CHUNK);
  view.setUint32(4, slot);
  view.setUint32(8, index);

  const offset = index * chunkSize;
  const frame = new Uint8Array(await new Blob([header, file.slice(offset, Math.min(offset + chunkSize, file.size))]).arrayBuffer());
  return { frame, payload: frame.subarray(FRAME_HEADER_BYTES) };
};

let nextTransferSlot = 1;

// Merge queued partial updates into list rows by id
const applyPatches = <T extends { id: string }>(items: T[], patches: Map<string, Partial<T>>): T[] =>
  patches.size === 0
    ? items
    : items.map((item) => {
        const patch = patches.get(item.id);
        return patch ? { ...item, ...patch } : item;
      });

// Convert RTT values as readable string for diagnostics panel (Connection Diagnostics)
const formatLatency = (rttMs: number | null): string => {
  if (rttMs === null || Number.isNaN(rttMs)) {
    return "n/a";
  }
  return `${Math.round(rttMs)} ms`;
};

// Format remaining seconds as a short "time left" label
const formatEta = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "";
  }

  const total = Math.max(1, Math.round(seconds));
  if (total < 60) {
    return `${total}s left`;
  }
  if (total < 3600) {
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s left`;
  }
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m left`;
};

const createRateTracker = (bytes = 0): RateTracker => ({ sampleAt: Date.now(), sampleBytes: bytes, rate: 0 });

// Exponential moving average of bytes per second
const sampleRate = (tracker: RateTracker, bytes: number): number => {
  const now = Date.now();
  const elapsedMs = now - tracker.sampleAt;
  if (elapsedMs < RATE_SAMPLE_INTERVAL_MS) {
    return tracker.rate;
  }

  const instant = ((bytes - tracker.sampleBytes) / elapsedMs) * 1000;
  tracker.rate = tracker.rate === 0 ? instant : tracker.rate * 0.7 + instant * 0.3;
  tracker.sampleAt = now;
  tracker.sampleBytes = bytes;
  return tracker.rate;
};

const estimateSeconds = (remainingBytes: number, rate: number) => (rate > 0 ? remainingBytes / rate : null);

type BatchSummary = {
  total: number;
  done: number;
  failed: number;
  bytes: number;
  totalBytes: number;
  progress: number;
  eta: number | null;
  active: boolean;
};

// Roll individual rows up into "3 of 12 files · 45% · 2m left"
const summarizeBatch = (
  items: { size: number; progress: number; rate: number; status: TransferStatus }[],
  total: number,
  totalBytes: number
): BatchSummary => {
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const bytes = items.reduce((sum, item) => sum + (item.status === "failed" ? 0 : item.size * item.progress), 0);
  const rate = items.reduce((sum, item) => sum + (item.status === "sending" || item.status === "receiving" ? item.rate : 0), 0);
  const progress = totalBytes > 0 ? Math.min(bytes / totalBytes, 1) : done / Math.max(total, 1);

  return {
    total,
    done,
    failed,
    bytes,
    totalBytes,
    progress,
    eta: estimateSeconds(Math.max(totalBytes - bytes, 0), rate),
    active: done + failed < total,
  };
};

const statusLabel: Partial<Record<TransferStatus, string>> = {
  queued: "Queued",
  waiting: "Paused, waiting for peer to reconnect…",
  verifying: "Verifying…",
};

type QueueItem = {
  id: string;
  file: File;
  path: string;
  source: "Files" | "Folder";
};

type PanelTab = "transfer" | "chat" | "call" | "diag" | "received";

const readDirectoryEntries = (reader: FileSystemDirectoryReader) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

const readEntryFile = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

const collectEntryFiles = async (entry: FileSystemEntry, prefix: string): Promise<{ file: File; path: string }[]> => {
  if (entry.isFile) {
    const file = await readEntryFile(entry as FileSystemFileEntry);
    return [{ file, path: `${prefix}${file.name}` }];
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (let batch = await readDirectoryEntries(reader); batch.length > 0; batch = await readDirectoryEntries(reader)) {
    children.push(...batch);
  }

  const nested = await Promise.all(children.map((child) => collectEntryFiles(child, `${prefix}${entry.name}/`)));
  return nested.flat();
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
  const [panelTab, setPanelTab] = useState<PanelTab>("transfer");
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [chatSeen, setChatSeen] = useState(0);
  const [idCopied, setIdCopied] = useState(false);

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
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [sendingItems, setSendingItems] = useState<OutgoingItem[]>([]);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [trustedPeers, setTrustedPeers] = useState<string[]>([]);
  const [reconnecting, setReconnecting] = useState<ReconnectStatus | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [sendBatchId, setSendBatchId] = useState<string | null>(null);
  const [incomingBatch, setIncomingBatch] = useState<IncomingBatch | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
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
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const incomingTransferLabelRef = useRef<"Files" | "Folder">("Files");
  const inboxItemsRef = useRef<InboxItem[]>([]);
  const activeInboxTransfersRef = useRef<Map<string, ActiveInboxTransfer>>(new Map());
  const sendingTransfersRef = useRef<Map<string, ActiveOutgoingTransfer>>(new Map());
  const sendingItemsRef = useRef<OutgoingItem[]>([]);
  const cancelledIncomingTransfersRef = useRef<Set<string>>(new Set());
  const cancelledOutgoingTransfersRef = useRef<Set<string>>(new Set());
  // Binary frame slot -> transferId for incoming files
  const incomingSlotsRef = useRef<Map<number, string>>(new Map());
  const incomingBatchRef = useRef<IncomingBatch | null>(null);
  // Finished incoming transfers: checksum result, kept so a late resume-query can be answered
  const completedIncomingRef = useRef<Map<string, boolean | null>>(new Map());
  // Storage of finished inbox files, discarded when the inbox is cleared
  const completedSinksRef = useRef<Map<string, ReceiveSink>>(new Map());
  // Pending replies from the peer, keyed by "resume:<id>" or "ack:<id>"
  const replyWaitersRef = useRef<
    Map<string, { resolve: (message: ControlMessage) => void; reject: (error: Error) => void }>
  >(new Map());
  // Senders paused until the same peer reconnects
  const connectionWaitersRef = useRef<Set<(conn: DataConnection) => void>>(new Set());
  // Aborted on manual disconnect so paused transfers stop waiting
  const sessionAbortRef = useRef(new AbortController());
  const lastPeerRef = useRef<{ peerId: string; initiator: boolean } | null>(null);
  const remoteByeRef = useRef(false);
  const reconnectLoopRef = useRef<{ peerId: string; attempt: number; startedAt: number; timer: number | null; pending: DataConnection | null } | null>(null);
  const wireConnectionRef = useRef<(conn: DataConnection, initiator: boolean) => void>(() => undefined);
  const autoConnectDoneRef = useRef(false);
  // First connection attempt in progress (not a reconnect), so it can time out with a clear reason
  const connectAttemptRef = useRef<{ peerId: string; conn: DataConnection; timer: number; fail: (reason: string) => void } | null>(null);
  const connectToTargetRef = useRef<(peerId: string) => void>(() => undefined);

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

  // Pending UI changes. A folder of small files fires several events per file; applying them
  // together keeps it to one re-render per UI_FLUSH_INTERVAL_MS instead of several per file.
  const uiPendingRef = useRef({
    logs: [] as LogRow[],
    inboxAdds: [] as InboxItem[],
    inboxPatches: new Map<string, Partial<InboxItem>>(),
    outgoingPatches: new Map<string, Partial<OutgoingItem>>(),
    queueRemovals: new Set<string>(),
  });
  const uiFlushTimerRef = useRef<number | null>(null);

  const flushUi = useCallback(() => {
    uiFlushTimerRef.current = null;
    const pending = uiPendingRef.current;

    if (pending.logs.length > 0) {
      const rows = pending.logs;
      pending.logs = [];
      setLogs((prev) => [...prev, ...rows]);
    }

    if (pending.inboxAdds.length > 0 || pending.inboxPatches.size > 0) {
      // Newest first, matching the order rows used to be prepended in
      const adds = pending.inboxAdds.reverse();
      const patches = pending.inboxPatches;
      pending.inboxAdds = [];
      pending.inboxPatches = new Map();
      setInboxItems((prev) => applyPatches([...adds, ...prev], patches));
    }

    if (pending.outgoingPatches.size > 0) {
      const patches = pending.outgoingPatches;
      pending.outgoingPatches = new Map();
      setSendingItems((prev) => applyPatches(prev, patches));
    }

    if (pending.queueRemovals.size > 0) {
      const removals = pending.queueRemovals;
      pending.queueRemovals = new Set();
      setQueue((prev) => prev.filter((item) => !removals.has(item.id)));
    }
  }, []);

  const scheduleUiFlush = useCallback(() => {
    uiFlushTimerRef.current ??= window.setTimeout(flushUi, UI_FLUSH_INTERVAL_MS);
  }, [flushUi]);

  const pushLog = useCallback((line: string, error = false) => {
    const stamp = new Date().toLocaleTimeString();
    const text = `[${stamp}] ${line}`;
    uiPendingRef.current.logs.push({ id: Date.now() + Math.random(), text, error });
    scheduleUiFlush();
  }, [scheduleUiFlush]);

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

  // Wait until buffered outbound bytes fall back below the safe threshold.
  // Uses the bufferedamountlow event instead of polling with setTimeout: browsers throttle
  // timers in background tabs (1/s, then 1/min in Chrome), which used to stall transfers.
  const waitForBufferedDrain = useCallback(
    async (conn: DataConnection) => {
      const channel = getRtcDataChannel(conn);
      if (!channel || !conn.open || channel.readyState !== "open") {
        throw new ConnectionLostError();
      }

      if (channel.bufferedAmountLowThreshold !== BUFFER_LOW_WATERMARK) {
        channel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;
      }

      while (channel.readyState === "open" && channel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
        await new Promise<void>((resolve) => {
          const done = () => {
            channel.removeEventListener("bufferedamountlow", done);
            channel.removeEventListener("close", done);
            resolve();
          };
          channel.addEventListener("bufferedamountlow", done);
          channel.addEventListener("close", done);
        });
      }

      if (channel.readyState !== "open") {
        throw new ConnectionLostError();
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

      return CONTROL_KINDS.has(parsed.kind as ControlMessage["kind"]) ? (parsed as ControlMessage) : null;
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

  const patchInboxItem = useCallback((id: string, patch: Partial<InboxItem>) => {
    const patches = uiPendingRef.current.inboxPatches;
    patches.set(id, { ...patches.get(id), ...patch });
    scheduleUiFlush();
  }, [scheduleUiFlush]);

  const patchOutgoingItem = useCallback((id: string, patch: Partial<OutgoingItem>) => {
    const patches = uiPendingRef.current.outgoingPatches;
    patches.set(id, { ...patches.get(id), ...patch });
    scheduleUiFlush();
  }, [scheduleUiFlush]);

  // Wait for a specific control reply ("resume:<id>" or "ack:<id>") from the peer
  const awaitReply = useCallback(
    (key: string, timeoutMs: number) =>
      new Promise<ControlMessage>((resolve, reject) => {
        const waiters = replyWaitersRef.current;
        waiters.get(key)?.reject(new ConnectionLostError());

        const settle = () => {
          if (waiters.get(key) === entry) {
            waiters.delete(key);
          }
          window.clearTimeout(timer);
        };
        const entry = {
          resolve: (message: ControlMessage) => {
            settle();
            resolve(message);
          },
          reject: (error: Error) => {
            settle();
            reject(error);
          },
        };

        waiters.set(key, entry);
        const timer = window.setTimeout(() => entry.reject(new ReplyTimeoutError()), timeoutMs);
      }),
    []
  );

  const resolveReply = useCallback((key: string, message: ControlMessage) => {
    replyWaitersRef.current.get(key)?.resolve(message);
  }, []);

  // Fail pending replies, either all of them or just one transfer's
  const rejectReplies = useCallback((error: Error, transferId?: string) => {
    for (const [key, entry] of Array.from(replyWaitersRef.current)) {
      if (!transferId || key.endsWith(`:${transferId}`)) {
        entry.reject(error);
      }
    }
  }, []);

  // Stop every paused transfer: the peer is not coming back
  const abortSession = useCallback((reason: string) => {
    sessionAbortRef.current.abort(new PeerGoneError(reason));
    sessionAbortRef.current = new AbortController();
    rejectReplies(new PeerGoneError(reason));
  }, [rejectReplies]);

  // Resolve once the same peer is connected again (immediately if it already is)
  const waitForConnection = useCallback(
    (peerId: string, signal: AbortSignal) =>
      new Promise<DataConnection>((resolve, reject) => {
        const current = activeConnRef.current;
        if (current?.open && current.peer === peerId) {
          resolve(current);
          return;
        }

        const abortError = () => (signal.reason instanceof Error ? signal.reason : new PeerGoneError());
        if (signal.aborted) {
          reject(abortError());
          return;
        }

        const cleanup = () => {
          connectionWaitersRef.current.delete(onConnection);
          signal.removeEventListener("abort", onAbort);
          window.clearTimeout(timer);
        };
        const onConnection = (conn: DataConnection) => {
          if (conn.peer !== peerId) {
            return;
          }
          cleanup();
          resolve(conn);
        };
        const onAbort = () => {
          cleanup();
          reject(abortError());
        };
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new PeerGoneError(`${peerId} did not reconnect within ${RECONNECT_WINDOW_MS / 60000} minutes`));
        }, RECONNECT_WINDOW_MS);

        connectionWaitersRef.current.add(onConnection);
        signal.addEventListener("abort", onAbort);
      }),
    []
  );

  // Update receiver progress card while chunks are arriving (throttled)
  const updateInboxTransferProgress = useCallback((transfer: ActiveInboxTransfer, force = false) => {
    const rate = sampleRate(transfer.rate, transfer.receivedBytes);
    const now = Date.now();
    if (!force && now - transfer.lastUiAt < UI_UPDATE_INTERVAL_MS) {
      return;
    }

    transfer.lastUiAt = now;
    patchInboxItem(transfer.id, {
      progress: transfer.size > 0 ? Math.min(transfer.receivedBytes / transfer.size, 1) : 0,
      rate,
      eta: estimateSeconds(transfer.size - transfer.receivedBytes, rate),
      status: "receiving",
    });
  }, [patchInboxItem]);

  // Create the receiver-side transfer record when a new file starts
  const beginInboxTransfer = useCallback((header: FileTransferHeader): ActiveInboxTransfer => {
    cancelledIncomingTransfersRef.current.delete(header.transferId);
    const existing = activeInboxTransfersRef.current.get(header.transferId);
    if (existing) {
      return existing;
    }

    const batchId = incomingBatchRef.current?.id ?? null;
    const transfer: ActiveInboxTransfer = {
      ...header,
      id: header.transferId,
      receivedBytes: 0,
      nextIndex: 0,
      sink: createReceiveSink(header.transferId, header.chunkSize, header.size),
      chunkHashes: [],
      startedAt: Date.now(),
      rate: createRateTracker(),
      lastUiAt: 0,
      batchId,
      finalizing: null,
    };
    activeInboxTransfersRef.current.set(header.transferId, transfer);
    incomingSlotsRef.current.set(header.slot, header.transferId);

    uiPendingRef.current.inboxAdds.push({
      id: header.transferId,
      source: header.source,
      name: header.name,
      size: header.size,
      mime: header.mime,
      url: "",
      progress: 0,
      rate: 0,
      eta: null,
      status: "receiving",
      verified: null,
      batchId,
      complete: false,
    });
    scheduleUiFlush();

    return transfer;
  }, [scheduleUiFlush]);

  // Give up on an incoming file (storage error) and tell the sender to stop
  const failIncomingTransfer = useCallback((transferId: string, reason: string) => {
    const transfer = activeInboxTransfersRef.current.get(transferId);
    activeInboxTransfersRef.current.delete(transferId);
    cancelledIncomingTransfersRef.current.add(transferId);
    void transfer?.sink.discard();

    const conn = activeConnRef.current;
    if (conn?.open) {
      sendControlMessage(conn, { kind: "transfer-cancel", transferId });
    }

    patchInboxItem(transferId, { status: "failed", error: reason, eta: null, rate: 0 });
    pushLog(`Could not receive ${transfer?.name ?? transferId}: ${reason}`, true);
  }, [patchInboxItem, pushLog, sendControlMessage]);

  // Close the file, compare checksums, publish it to the inbox and acknowledge to the sender
  const finalizeInboxTransfer = useCallback(
    async (transfer: ActiveInboxTransfer, expectedHash: string | null): Promise<boolean | null> => {
      patchInboxItem(transfer.id, { status: "verifying", progress: 1, eta: null });

      try {
        const blob = await transfer.sink.finish(transfer.mime);
        let verified: boolean | null = null;
        if (blob.size !== transfer.size) {
          verified = false;
        } else if (expectedHash && canHashChunks()) {
          const chunkCount = Math.ceil(transfer.size / transfer.chunkSize);
          const actual = await combineChunkHashes(await Promise.all(transfer.chunkHashes.slice(0, chunkCount)));
          verified = actual === expectedHash;
        }

        // The inbox was cleared while the file was being finalized
        if (cancelledIncomingTransfersRef.current.has(transfer.id)) {
          await transfer.sink.discard();
          return null;
        }

        const elapsedSeconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.001);
        const url = URL.createObjectURL(blob);
        activeInboxTransfersRef.current.delete(transfer.id);
        completedIncomingRef.current.set(transfer.id, verified);
        completedSinksRef.current.set(transfer.id, transfer.sink);

        patchInboxItem(transfer.id, {
          url,
          progress: 1,
          rate: transfer.size / elapsedSeconds,
          eta: null,
          status: "done",
          verified,
          complete: true,
        });

        const suffix =
          verified === true ? ", checksum verified" : verified === false ? ", CHECKSUM MISMATCH (file may be corrupted)" : "";
        pushLog(`Received file ready in inbox: ${transfer.name} (${formatBytes(transfer.size)})${suffix}.`, verified === false);

        const conn = activeConnRef.current;
        if (conn?.open) {
          sendControlMessage(conn, { kind: "file-ack", transferId: transfer.id, verified });
        }
        return verified;
      } catch (err) {
        failIncomingTransfer(transfer.id, err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [failIncomingTransfer, patchInboxItem, pushLog, sendControlMessage]
  );

  // Move the sender progress bar forward after each binary chunk is sent (throttled)
  const updateOutgoingTransferProgress = useCallback(
    (transferId: string, sentBytes: number, force = false) => {
      const transfer = sendingTransfersRef.current.get(transferId);
      if (!transfer) return;

      transfer.sentBytes = sentBytes;
      const rate = sampleRate(transfer.rate, sentBytes);
      const now = Date.now();
      if (!force && now - transfer.lastUiAt < UI_UPDATE_INTERVAL_MS) {
        return;
      }

      transfer.lastUiAt = now;
      patchOutgoingItem(transferId, {
        progress: transfer.size > 0 ? Math.min(sentBytes / transfer.size, 1) : 1,
        rate,
        eta: estimateSeconds(transfer.size - sentBytes, rate),
      });
    },
    [patchOutgoingItem]
  );

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    pushLog("Creating archive...");
    const zip = new JSZip();

    try {
      for (const item of downloadable) {
        const response = await fetch(item.url);
        const blob = await response.blob();
        zip.file(item.name, blob);
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlobFile(zipBlob, "myftp-downloads.zip");
      pushLog(`Created and downloaded myftp-downloads.zip with ${downloadable.length} item(s).`);
    } catch (error) {
      pushLog(`Failed to create archive: ${error instanceof Error ? error.message : "Unknown error"}`, true);
    }
  }, [pushLog]);

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

    activeInboxTransfersRef.current.forEach((transfer) => void transfer.sink.discard());
    activeInboxTransfersRef.current.clear();
    inboxItemsRef.current.forEach((item) => {
      if (item.url) {
        URL.revokeObjectURL(item.url);
      }
    });
    // Free the disk space used by finished files
    completedSinksRef.current.forEach((sink) => void sink.discard());
    completedSinksRef.current.clear();
    // Rows still waiting for the next UI flush belong to the inbox being cleared
    uiPendingRef.current.inboxAdds = [];
    uiPendingRef.current.inboxPatches.clear();
    incomingBatchRef.current = null;
    setIncomingBatch(null);
    setInboxItems([]);
    pushLog("Cleared received inbox.");
  }, [pushLog, sendControlMessage]);

  // Fail every incoming file that is still waiting for data (the sender is gone)
  const failAllIncoming = useCallback((reason: string) => {
    for (const transfer of Array.from(activeInboxTransfersRef.current.values())) {
      if (!transfer.finalizing) {
        failIncomingTransfer(transfer.id, reason);
      }
    }
  }, [failIncomingTransfer]);

  // Abandon a first connection attempt that has not opened yet
  const cancelConnectAttempt = useCallback(() => {
    const attempt = connectAttemptRef.current;
    if (attempt) {
      window.clearTimeout(attempt.timer);
      connectAttemptRef.current = null;
      if (attempt.conn !== activeConnRef.current) {
        attempt.conn.close();
      }
    }
    setConnecting(null);
  }, []);

  // Stop dialing or waiting for a dropped peer
  const stopReconnectLoop = useCallback(() => {
    const loop = reconnectLoopRef.current;
    if (loop) {
      if (loop.timer !== null) {
        window.clearTimeout(loop.timer);
      }
      if (loop.pending && loop.pending !== activeConnRef.current) {
        loop.pending.close();
      }
      reconnectLoopRef.current = null;
    }
    setReconnecting(null);
  }, []);

  // After an unexpected drop the side that opened the link redials with backoff; the other side
  // waits for it. Only one side dials so the two peers never race each other with duplicate links.
  const startReconnectLoop = useCallback(
    (peerId: string, mode: ReconnectStatus["mode"]) => {
      stopReconnectLoop();
      const loop = { peerId, attempt: 0, startedAt: Date.now(), timer: null as number | null, pending: null as DataConnection | null };
      reconnectLoopRef.current = loop;
      setReconnecting({ peerId, attempt: 0, mode });

      const giveUp = () => {
        pushLog(`${peerId} did not come back. Paused transfers were stopped.`, true);
        stopReconnectLoop();
        abortSession(`${peerId} did not reconnect`);
        failAllIncoming("Sender did not reconnect");
      };

      const tick = () => {
        loop.timer = null;
        if (reconnectLoopRef.current !== loop) {
          return;
        }
        if (mode === "waiting" || Date.now() - loop.startedAt >= RECONNECT_WINDOW_MS) {
          giveUp();
          return;
        }

        const peer = peerRef.current;
        if (!peer || peer.destroyed) {
          stopReconnectLoop();
          return;
        }

        if (peer.disconnected) {
          // Signalling server first; the dial happens on the next tick
          try {
            peer.reconnect();
          } catch {
            // Retried on the next tick
          }
        } else {
          loop.attempt += 1;
          setReconnecting({ peerId, attempt: loop.attempt, mode });
          loop.pending?.close();
          const conn = peer.connect(peerId, DATA_CONNECTION_OPTIONS);
          loop.pending = conn;
          conn.on("open", () => wireConnectionRef.current(conn, true));
        }

        loop.timer = window.setTimeout(tick, RECONNECT_DELAYS_MS[Math.min(loop.attempt, RECONNECT_DELAYS_MS.length - 1)]);
      };

      loop.timer = window.setTimeout(tick, mode === "dialing" ? RECONNECT_DELAYS_MS[0] : RECONNECT_WINDOW_MS);
    },
    [abortSession, failAllIncoming, pushLog, stopReconnectLoop]
  );

  // Wire the live data-channel listeners for chat, transfer, and close events
  const wireConnection = useCallback(
    (conn: DataConnection, initiator: boolean) => {
      const previous = activeConnRef.current;
      activeConnRef.current = conn;
      // A replacement link (e.g. after a reconnect) supersedes the old one
      if (previous && previous !== conn) {
        previous.close();
      }

      lastPeerRef.current = { peerId: conn.peer, initiator };
      remoteByeRef.current = false;
      stopReconnectLoop();
      setConnState(`Connected to ${conn.peer}`);
      pushLog(`Connection opened with ${conn.peer}`);
      if (conn.serialization !== "raw") {
        pushLog(
          `Connection serialization is ${conn.serialization}; for large file throughput prefer raw/none serialization.`,
          true
        );
      }

      // ICE can sit in "disconnected" for a long time before PeerJS closes the link; treat a stall as a drop
      let iceStallTimer: number | null = null;
      conn.on("iceStateChanged", (state) => {
        if (state === "disconnected") {
          iceStallTimer ??= window.setTimeout(() => {
            iceStallTimer = null;
            if (activeConnRef.current === conn) {
              pushLog("Link stalled, reconnecting…", true);
              conn.close();
            }
          }, ICE_STALL_MS);
        } else if (iceStallTimer !== null) {
          window.clearTimeout(iceStallTimer);
          iceStallTimer = null;
        }
      });

      conn.on("data", (data) => {
        if (activeConnRef.current !== conn) {
          return;
        }

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
            const batch = { id: control.batchId ?? createId(), count: control.count ?? 0, totalBytes: control.totalBytes ?? 0 };
            incomingBatchRef.current = batch;
            setIncomingBatch(batch);
            pushLog(
              `Incoming ${source.toLowerCase()} transfer: ${batch.count} item(s)${batch.totalBytes ? `, ${formatBytes(batch.totalBytes)}` : ""}.`
            );
            return;
          }

          if (control.kind === "file-start") {
            beginInboxTransfer(toTransferHeader(control));
            return;
          }

          if (control.kind === "file-end") {
            if (cancelledIncomingTransfersRef.current.has(control.transferId)) {
              activeInboxTransfersRef.current.delete(control.transferId);
              return;
            }

            const transfer = activeInboxTransfersRef.current.get(control.transferId);
            if (!transfer) {
              // Already saved: the first acknowledgement was lost in a reconnect
              if (completedIncomingRef.current.has(control.transferId)) {
                sendControlMessage(conn, {
                  kind: "file-ack",
                  transferId: control.transferId,
                  verified: completedIncomingRef.current.get(control.transferId) ?? null,
                });
              } else {
                pushLog(`Received file end without a matching transfer.`, true);
              }
              return;
            }

            transfer.finalizing ??= finalizeInboxTransfer(transfer, control.hash ?? null);
            return;
          }

          if (control.kind === "resume-query") {
            const { transferId } = control;
            if (cancelledIncomingTransfersRef.current.has(transferId)) {
              sendControlMessage(conn, { kind: "transfer-cancel", transferId });
              return;
            }

            const replyFinished = () => {
              const target = activeConnRef.current;
              if (!target?.open) {
                return;
              }
              if (completedIncomingRef.current.has(transferId)) {
                sendControlMessage(target, {
                  kind: "resume-offset",
                  transferId,
                  nextIndex: control.totalChunks,
                  complete: true,
                  verified: completedIncomingRef.current.get(transferId) ?? null,
                });
              } else {
                sendControlMessage(target, { kind: "transfer-cancel", transferId });
              }
            };

            const existing = activeInboxTransfersRef.current.get(transferId);
            if (completedIncomingRef.current.has(transferId)) {
              replyFinished();
              return;
            }
            if (existing?.finalizing) {
              void existing.finalizing.then(replyFinished);
              return;
            }

            // Unknown transfer (e.g. this page was reloaded) restarts from zero
            const transfer = existing ?? beginInboxTransfer(toTransferHeader(control));
            transfer.rate = createRateTracker(transfer.receivedBytes);
            updateInboxTransferProgress(transfer, true);
            sendControlMessage(conn, { kind: "resume-offset", transferId, nextIndex: transfer.nextIndex, complete: false });
            if (existing) {
              pushLog(`Resuming ${transfer.name} from ${formatBytes(transfer.receivedBytes)}.`);
            }
            return;
          }

          if (control.kind === "resume-offset") {
            resolveReply(`resume:${control.transferId}`, control);
            return;
          }

          if (control.kind === "file-ack") {
            resolveReply(`ack:${control.transferId}`, control);
            return;
          }

          if (control.kind === "transfer-cancel") {
            cancelledOutgoingTransfersRef.current.add(control.transferId);
            rejectReplies(new Error("Transfer canceled by receiver"), control.transferId);
            pushLog(`Receiver canceled transfer ${control.transferId}.`);
            return;
          }

          if (control.kind === "call-end") {
            endActiveCall(control.reason, false);
            pushLog("Call ended by remote peer.");
            return;
          }

          if (control.kind === "bye") {
            remoteByeRef.current = true;
            return;
          }

          return;
        }

        // Binary frame: 12-byte header (type, slot, index) + chunk payload
        const buffer = extractArrayBuffer(data);
        if (!buffer || buffer.byteLength < FRAME_HEADER_BYTES) {
          pushLog("Received an unrecognized binary message.", true);
          return;
        }

        const view = new DataView(buffer);
        if (view.getUint8(0) !== FRAME_FILE_CHUNK) {
          pushLog("Received an unrecognized binary message.", true);
          return;
        }

        const transferId = incomingSlotsRef.current.get(view.getUint32(4));
        const index = view.getUint32(8);
        const transfer = transferId ? activeInboxTransfersRef.current.get(transferId) : undefined;
        if (!transfer) {
          if (!transferId || !cancelledIncomingTransfersRef.current.has(transferId)) {
            pushLog("Received file chunk for unknown transfer.", true);
          }
          return;
        }

        const payload = new Uint8Array(buffer, FRAME_HEADER_BYTES);
        transfer.sink.write(index, payload);
        if (canHashChunks()) {
          transfer.chunkHashes[index] = hashChunk(payload);
        }
        transfer.nextIndex = Math.max(transfer.nextIndex, index + 1);
        transfer.receivedBytes = Math.min(transfer.nextIndex * transfer.chunkSize, transfer.size);

        const storageError = transfer.sink.error();
        if (storageError) {
          failIncomingTransfer(transfer.id, storageError.message);
          return;
        }
        updateInboxTransferProgress(transfer);
      });

      conn.on("close", () => {
        if (iceStallTimer !== null) {
          window.clearTimeout(iceStallTimer);
        }
        // Ignore links that were replaced or closed on purpose
        if (activeConnRef.current !== conn) {
          return;
        }

        activeConnRef.current = null;
        endActiveCall("disconnect", false);
        setConnState("Not connected");
        rejectReplies(new ConnectionLostError());

        if (remoteByeRef.current) {
          pushLog(`${conn.peer} disconnected.`);
          abortSession(`${conn.peer} disconnected`);
          failAllIncoming("Sender disconnected");
          return;
        }

        // Incoming files stay open so the sender can resume them
        activeInboxTransfersRef.current.forEach((transfer) => {
          if (!transfer.finalizing) {
            patchInboxItem(transfer.id, { status: "waiting", rate: 0, eta: null });
          }
        });
        pushLog(`Connection to ${conn.peer} dropped. ${initiator ? "Reconnecting…" : "Waiting for it to reconnect…"}`, true);
        startReconnectLoop(conn.peer, initiator ? "dialing" : "waiting");
      });

      conn.on("error", (err) => {
        pushLog(`Connection error: ${err.message || err}`, true);
      });

      // Wake transfers that were paused waiting for this peer
      for (const waiter of Array.from(connectionWaitersRef.current)) {
        waiter(conn);
      }
    },
    [
      abortSession,
      beginInboxTransfer,
      endActiveCall,
      extractArrayBuffer,
      failAllIncoming,
      failIncomingTransfer,
      finalizeInboxTransfer,
      parseControlMessage,
      patchInboxItem,
      pushLog,
      rejectReplies,
      resolveReply,
      sendControlMessage,
      startReconnectLoop,
      stopReconnectLoop,
      updateInboxTransferProgress,
    ]
  );

  useEffect(() => {
    wireConnectionRef.current = wireConnection;
  }, [wireConnection]);

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

      // Drop the current link first so its close handler does not try to reconnect
      stopReconnectLoop();
      cancelConnectAttempt();
      lastPeerRef.current = null;
      activeConnRef.current = null;

      if (peerRef.current) {
        endActiveCall("disconnect", false);
        abortSession("Peer was reset");
        try {
          peerRef.current.destroy();
        } catch (err) {
          pushLog(`Destroy warning: ${String(err)}`, true);
        }
      }

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
            // Comma-separated, e.g. "turn:host:3478?transport=udp,turns:host:443?transport=tcp"
            // (TURN over TLS on 443 gets through most corporate/school firewalls)
            ...(process.env.NEXT_PUBLIC_TURN_URL
              ? [
                  {
                    urls: process.env.NEXT_PUBLIC_TURN_URL.split(",").map((url) => url.trim()).filter(Boolean),
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

        // Opening a share link (e.g. by scanning the QR code) connects right away
        const linkedPeer = new URLSearchParams(window.location.search).get("peer")?.trim();
        if (!autoConnectDoneRef.current && linkedPeer && linkedPeer !== id) {
          autoConnectDoneRef.current = true;
          pushLog(`Connecting to ${linkedPeer} from share link…`);
          connectToTargetRef.current(linkedPeer);
        }
      });

      peer.on("connection", (conn) => {
        pushLog(`Incoming connection from ${conn.peer}`);
        conn.on("open", () => wireConnectionRef.current(conn, false));
      });

      // Losing the signalling server does not drop open links, but new/re-dialed links need it
      peer.on("disconnected", () => {
        window.setTimeout(() => {
          if (peerRef.current === peer && !peer.destroyed && peer.disconnected) {
            pushLog("Lost the peer server, reconnecting…", true);
            try {
              peer.reconnect();
            } catch (err) {
              pushLog(`Peer server reconnect failed: ${String(err)}`, true);
            }
          }
        }, 3000);
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

        if ((err as { type?: string }).type === "peer-unavailable") {
          // The signalling server knows nobody with that ID: fail fast instead of waiting for the timeout
          const attempt = connectAttemptRef.current;
          if (attempt) {
            attempt.fail(`${attempt.peerId} is offline or the ID is wrong.`);
            return;
          }
          // Expected while redialing a peer that has not come back yet
          if (reconnectLoopRef.current) {
            return;
          }
        }

        pushLog(`Peer error: ${err.type || ""} ${err.message || err}`.trim(), true);
      });
    };

    connectWithId();
  }, [abortSession, cancelConnectAttempt, endActiveCall, host, path, port, pushLog, secure, setLocalStream, setRemoteStream, stopReconnectLoop]);

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
  const connectToTarget = useCallback((idOverride?: string) => {
    if (!peerRef.current) {
      pushLog("Peer is not initialized .", true);
      return;
    }

    const trimmed = (idOverride ?? targetId).trim();
    if (!trimmed) {
      pushLog("Please enter a target peer ID first.", true);
      return;
    }

    stopReconnectLoop();
    cancelConnectAttempt();
    setConnecting(trimmed);

    const conn = peerRef.current.connect(trimmed, DATA_CONNECTION_OPTIONS);
    const noPathHint = process.env.NEXT_PUBLIC_TURN_URL
      ? "The relay (TURN) server could not be reached either."
      : "One of the networks probably blocks direct peer-to-peer links; configuring a TURN relay (NEXT_PUBLIC_TURN_URL) fixes this.";
    const fail = (reason: string) => {
      if (connectAttemptRef.current?.conn !== conn) {
        return;
      }
      window.clearTimeout(connectAttemptRef.current.timer);
      connectAttemptRef.current = null;
      setConnecting(null);
      conn.close();
      pushLog(reason, true);
    };

    connectAttemptRef.current = {
      peerId: trimmed,
      conn,
      fail,
      timer: window.setTimeout(() => fail(`Could not reach ${trimmed} within ${CONNECT_TIMEOUT_MS / 1000}s. ${noPathHint}`), CONNECT_TIMEOUT_MS),
    };

    conn.on("iceStateChanged", (state) => {
      if (state === "failed") {
        fail(`No network path to ${trimmed}. ${noPathHint}`);
      }
    });
    conn.on("open", () => {
      if (connectAttemptRef.current?.conn === conn) {
        window.clearTimeout(connectAttemptRef.current.timer);
        connectAttemptRef.current = null;
        setConnecting(null);
      }
      wireConnection(conn, true);
    });
  }, [cancelConnectAttempt, pushLog, stopReconnectLoop, targetId, wireConnection]);

  useEffect(() => {
    connectToTargetRef.current = connectToTarget;
  }, [connectToTarget]);

  // Close current connection (or stop reconnecting) and reset UI state
  const disconnectFromTarget = useCallback(() => {
    const conn = activeConnRef.current;
    if (!conn && !reconnectLoopRef.current && !connectAttemptRef.current) {
      pushLog("No active connection to disconnect.", true);
      return;
    }

    if (conn) {
      endActiveCall("disconnect", true);
    }

    stopReconnectLoop();
    cancelConnectAttempt();
    lastPeerRef.current = null;
    // Cleared before closing so the close handler treats this as intentional
    activeConnRef.current = null;
    abortSession("Disconnected");
    failAllIncoming("Disconnected");

    if (conn) {
      if (conn.open) {
        sendControlMessage(conn, { kind: "bye" });
      }
      // Short delay so the goodbye is flushed before the link is torn down
      window.setTimeout(() => {
        try {
          conn.close();
        } catch (err) {
          pushLog(`Disconnect warning: ${String(err)}`, true);
        }
      }, 200);
    }

    setConnState("Not connected");
    pushLog("Disconnected from peer.");
  }, [abortSession, cancelConnectAttempt, endActiveCall, failAllIncoming, pushLog, sendControlMessage, stopReconnectLoop]);

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

  // Send one file, pausing through dropped connections and resuming where the receiver left off.
  // Calls onTransmitted once every chunk and the file-end are on the wire, so the caller can start
  // the next file while this one waits for its acknowledgement.
  // Resolves with the receiver's checksum result (true / false, or null when it was not checked).
  const sendOneFile = useCallback(
    async (
      item: QueueItem,
      transferId: string,
      peerId: string,
      signal: AbortSignal,
      onTransmitted: () => void
    ): Promise<boolean | null> => {
      const { file } = item;
      const size = file.size;
      const mime = file.type || "application/octet-stream";
      const slot = nextTransferSlot++;
      // Fixed when the file is announced, from that link's negotiated message size
      let header: FileTransferHeader | null = null;
      let chunkCount = 0;
      const hashing = canHashChunks();
      const chunkHashes: Promise<ArrayBuffer>[] = [];
      const transfer: ActiveOutgoingTransfer = { id: transferId, size, sentBytes: 0, rate: createRateTracker(), lastUiAt: 0 };
      sendingTransfersRef.current.set(transferId, transfer);

      const checkStillWanted = () => {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new PeerGoneError();
        }
        if (cancelledOutgoingTransfersRef.current.has(transferId)) {
          throw new Error("Transfer canceled by receiver");
        }
      };

      const finish = (verified: boolean | null) => {
        onTransmitted();
        patchOutgoingItem(transferId, { status: "done", complete: true, progress: 1, eta: null, verified });
        return verified;
      };

      if (isLikelyCompressed(item.path, mime)) {
        pushLog(`Skipping app-level compression for ${item.path}; file is already compressed or media.`);
      }

      let resumeAttempts = 0;

      try {
        for (;;) {
          checkStillWanted();
          const current = activeConnRef.current;
          let conn: DataConnection;
          if (current?.open && current.peer === peerId) {
            conn = current;
          } else {
            patchOutgoingItem(transferId, { status: "waiting", rate: 0, eta: null });
            conn = await waitForConnection(peerId, signal);
          }

          try {
            let startIndex = 0;
            if (!header) {
              const chunkSize = pickChunkSize(getRtcPeerConnection(conn));
              chunkCount = Math.ceil(size / chunkSize);
              header = {
                transferId,
                slot,
                source: item.source,
                name: item.path,
                mime,
                size,
                chunkSize,
                totalChunks: Math.max(1, chunkCount),
              };
              sendControlMessage(conn, { kind: "file-start", ...header });
            } else {
              // Ask the receiver how much it already has
              resumeAttempts += 1;
              if (resumeAttempts > MAX_RESUME_ATTEMPTS) {
                throw new Error("Receiver did not answer resume requests");
              }
              const pendingReply = awaitReply(`resume:${transferId}`, RESUME_REPLY_TIMEOUT_MS);
              sendControlMessage(conn, { kind: "resume-query", ...header });
              const reply = await pendingReply;
              if (reply.kind !== "resume-offset") {
                throw new Error("Unexpected resume reply");
              }
              resumeAttempts = 0;
              if (reply.complete) {
                return finish(reply.verified ?? null);
              }
              startIndex = Math.min(Math.max(reply.nextIndex, 0), chunkCount);
              pushLog(`Resuming ${header.name} from ${formatBytes(Math.min(startIndex * header.chunkSize, size))}.`);
            }

            const { chunkSize } = header;
            const startBytes = Math.min(startIndex * chunkSize, size);
            transfer.rate = createRateTracker(startBytes);
            patchOutgoingItem(transferId, { status: "sending" });
            updateOutgoingTransferProgress(transferId, startBytes, true);

            // Read-ahead: the next chunk is read from disk while the current one is being sent
            const readAhead = (index: number) => {
              const pending = readChunkFrame(file, slot, index, chunkSize);
              pending.catch(() => undefined);
              return pending;
            };
            let nextFrame = startIndex < chunkCount ? readAhead(startIndex) : null;

            for (let index = startIndex; index < chunkCount; index += 1) {
              checkStillWanted();
              const { frame, payload } = await nextFrame!;
              nextFrame = index + 1 < chunkCount ? readAhead(index + 1) : null;
              if (hashing) {
                chunkHashes[index] = hashChunk(payload);
              }

              await waitForBufferedDrain(conn);
              conn.send(frame);
              updateOutgoingTransferProgress(transferId, index * chunkSize + payload.byteLength);
            }

            const hash = hashing ? await combineChunkHashes(await Promise.all(chunkHashes.slice(0, chunkCount))) : null;
            patchOutgoingItem(transferId, { status: "verifying", progress: 1, eta: null });
            await waitForBufferedDrain(conn);

            const pendingAck = awaitReply(`ack:${transferId}`, ACK_TIMEOUT_MS);
            sendControlMessage(conn, { kind: "file-end", transferId, hash });
            onTransmitted();
            try {
              const ack = await pendingAck;
              return finish(ack.kind === "file-ack" ? ack.verified : null);
            } catch (err) {
              if (!(err instanceof ReplyTimeoutError)) {
                throw err;
              }
              pushLog(`No delivery confirmation for ${header.name}; it may still have arrived.`, true);
              return finish(null);
            }
          } catch (err) {
            // Link dropped: pause, then resume on the next link to the same peer
            if (err instanceof ConnectionLostError || err instanceof ReplyTimeoutError) {
              continue;
            }
            throw err;
          }
        }
      } finally {
        sendingTransfersRef.current.delete(transferId);
      }
    },
    [
      awaitReply,
      getRtcPeerConnection,
      isLikelyCompressed,
      patchOutgoingItem,
      pushLog,
      sendControlMessage,
      updateOutgoingTransferProgress,
      waitForBufferedDrain,
      waitForConnection,
    ]
  );

  // Send a batch; every file gets a row up front so overall progress is visible.
  // Files are transmitted one after another, but each one's acknowledgement is awaited in the
  // background (up to MAX_UNCONFIRMED_FILES at once) instead of costing a round-trip per file.
  const sendFilePayloads = useCallback(
    async (items: QueueItem[]) => {
      if (!requireConnection()) {
        return;
      }
      if (items.length === 0) {
        pushLog("Queue is empty. Add files or a folder first.", true);
        return;
      }

      const conn = activeConnRef.current;
      if (!conn) {
        return;
      }

      const peerId = conn.peer;
      const signal = sessionAbortRef.current.signal;
      const label = items.some((item) => item.source === "Folder") ? "Folder" : "Files";
      const batchId = createId();
      const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
      const planned = items.map((item) => ({ item, transferId: createId() }));

      setSendBatchId(batchId);
      setSendingItems((prev) => [
        ...planned.map(({ item, transferId }): OutgoingItem => ({
          id: transferId,
          source: item.source,
          name: item.path,
          size: item.file.size,
          progress: 0,
          rate: 0,
          eta: null,
          status: "queued",
          verified: null,
          batchId,
          complete: false,
        })),
        ...prev,
      ]);

      sendControlMessage(conn, {
        kind: "transfer-start",
        label,
        count: items.length,
        totalBytes,
        batchId,
      });

      let sentCount = 0;
      let peerGone = false;
      const unconfirmed = new Set<Promise<void>>();

      for (const { item, transferId } of planned) {
        if (peerGone) {
          patchOutgoingItem(transferId, { status: "failed", complete: true });
          continue;
        }

        let markTransmitted!: () => void;
        const transmitted = new Promise<void>((resolve) => {
          markTransmitted = resolve;
        });

        const settled: Promise<void> = sendOneFile(item, transferId, peerId, signal, markTransmitted)
          .then((verified) => {
            sentCount += 1;
            uiPendingRef.current.queueRemovals.add(item.id);
            const note =
              verified === true ? ", checksum verified by receiver" : verified === false ? ", CHECKSUM MISMATCH reported by receiver" : "";
            pushLog(
              `Sent ${item.source === "Folder" ? "folder file" : "file"}: ${item.path} (${formatBytes(item.file.size)})${note}`,
              verified === false
            );
          })
          .catch((err: unknown) => {
            pushLog(`Transfer canceled/failed for ${item.path}: ${err instanceof Error ? err.message : String(err)}`, true);
            patchOutgoingItem(transferId, { status: "failed", complete: true, eta: null, rate: 0 });
            // The peer is gone, so the rest of the batch cannot be delivered either
            if (err instanceof PeerGoneError) {
              peerGone = true;
            }
          })
          .finally(() => {
            unconfirmed.delete(settled);
          });
        unconfirmed.add(settled);

        // Move on as soon as this file is on the wire (or it ended early)
        await Promise.race([transmitted, settled]);
        while (unconfirmed.size >= MAX_UNCONFIRMED_FILES) {
          await Promise.race(unconfirmed);
        }
      }

      await Promise.all(unconfirmed);
      pushLog(`${label} upload complete. ${sentCount} of ${items.length} item(s) sent successfully.`);
    },
    [patchOutgoingItem, pushLog, requireConnection, sendControlMessage, sendOneFile]
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

  // Add picked or dropped files to the send queue
  const addToQueue = useCallback(
    (entries: { file: File; path: string; source: "Files" | "Folder" }[]) => {
      if (entries.length === 0) {
        return;
      }

      const summary = summarizeSelection(entries.map((entry) => entry.file));
      setQueue((prev) => {
        const known = new Set(prev.map((item) => `${item.path}:${item.file.size}`));
        const fresh = entries
          .filter((entry) => !known.has(`${entry.path}:${entry.file.size}`))
          .map((entry) => ({ ...entry, id: `${Date.now()}-${Math.random()}` }));
        return [...prev, ...fresh];
      });
      pushLog(`Queued ${summary.count} item(s), ${formatBytes(summary.totalBytes)}.`);
    },
    [pushLog, summarizeSelection]
  );

  const onFilesSelected = useCallback(
    (input: HTMLInputElement, source: "Files" | "Folder") => {
      const files = input.files ? Array.from(input.files) : [];
      addToQueue(files.map((file) => ({ file, path: file.webkitRelativePath || file.name, source })));
      input.value = "";
    },
    [addToQueue]
  );

  const onDropFiles = useCallback(
    async (dataTransfer: DataTransfer) => {
      const entries = Array.from(dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.() ?? null)
        .filter((entry): entry is FileSystemEntry => entry !== null);

      if (entries.length === 0) {
        addToQueue(Array.from(dataTransfer.files).map((file) => ({ file, path: file.name, source: "Files" as const })));
        return;
      }

      try {
        const groups = await Promise.all(
          entries.map(async (entry) => {
            const source: "Files" | "Folder" = entry.isDirectory ? "Folder" : "Files";
            const files = await collectEntryFiles(entry, "");
            return files.map((item) => ({ ...item, source }));
          })
        );
        addToQueue(groups.flat());
      } catch (err) {
        pushLog(`Could not read dropped items: ${String(err)}`, true);
      }
    },
    [addToQueue, pushLog]
  );

  const removeQueuedFile = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearFinishedSends = useCallback(() => {
    setSendingItems((prev) => prev.filter((item) => !item.complete));
  }, []);

  // Copy peer ID
  const copyPeerId = useCallback(async () => {
    const id = myId.trim();
    if (!id || id === "Connecting...") {
      pushLog("Peer ID is not ready .", true);
      return;
    }

    try {
      await navigator.clipboard.writeText(id);
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
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

  // Tell the peer we are leaving so it does not wait for a reconnect
  useEffect(() => {
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        return;
      }
      const conn = activeConnRef.current;
      if (conn?.open) {
        sendControlMessage(conn, { kind: "bye" });
      }
    };

    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [sendControlMessage]);

  // Render the share link as a QR code while the share dialog is open
  useEffect(() => {
    if (!qrOpen || !peerShareLink) {
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(peerShareLink, { margin: 1, width: 480, errorCorrectionLevel: "M" })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => pushLog(`Could not create QR code: ${String(err)}`, true));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQrOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [peerShareLink, pushLog, qrOpen]);

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
    for (const container of [logContainerRef.current, chatContainerRef.current]) {
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, [logs, panelTab]);

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

  const isConnected = connState !== "Not connected";
  const peerReady = myId.trim() !== "" && myId !== "Connecting...";
  const connectedPeer = connState.replace(/^Connected to\s*/, "");
  const queueBytes = queue.reduce((sum, item) => sum + item.file.size, 0);
  const visibleQueue = queue.slice(0, 200);
  const sendsRunning = sendingItems.some((item) => !item.complete);
  const readyCount = inboxItems.filter((item) => item.complete).length;
  const sendBatchItems = sendBatchId ? sendingItems.filter((item) => item.batchId === sendBatchId) : [];
  const sendBatch =
    sendBatchItems.length > 1
      ? summarizeBatch(sendBatchItems, sendBatchItems.length, sendBatchItems.reduce((sum, item) => sum + item.size, 0))
      : null;
  const receiveBatch =
    incomingBatch && incomingBatch.count > 1
      ? summarizeBatch(
          inboxItems.filter((item) => item.batchId === incomingBatch.id),
          incomingBatch.count,
          incomingBatch.totalBytes
        )
      : null;
  const routeHint =
    diagnostics.route === "relay"
      ? " Traffic goes through a relay (TURN) server, which is usually slower than a direct link."
      : diagnostics.route === "direct"
        ? " Direct peer-to-peer link."
        : "";
  const linkQuality =
    diagnostics.dataChannelState !== "open" || diagnostics.rttMs === null
      ? { label: "Measuring", dot: "bg-slate-400", chip: "border-slate-600 text-slate-300", hint: "Measuring link quality…" }
      : diagnostics.rttMs < 120
        ? { label: "Good", dot: "bg-emerald-400", chip: "border-emerald-500/40 text-emerald-300", hint: `Low latency.${routeHint}` }
        : diagnostics.rttMs < 300
          ? { label: "Fair", dot: "bg-amber-400", chip: "border-amber-500/40 text-amber-300", hint: `Noticeable latency; transfers may be slower.${routeHint}` }
          : { label: "Poor", dot: "bg-rose-400", chip: "border-rose-500/40 text-rose-300", hint: `High latency; expect slow transfers.${routeHint}` };
  const chatMessages = logs.flatMap((row) => {
    const match = /^\[(.+?)\] (Sent|Received): ([\s\S]*)$/.exec(row.text);
    return match ? [{ id: row.id, time: match[1], mine: match[2] === "Sent", text: match[3] }] : [];
  });
  const receivedChatCount = chatMessages.filter((row) => !row.mine).length;
  const unreadChat = panelTab === "chat" ? 0 : Math.max(0, receivedChatCount - chatSeen);

  const changeTab = (value: string) => {
    if (panelTab === "chat" || value === "chat") {
      setChatSeen(receivedChatCount);
    }
    setPanelTab(value as PanelTab);
  };

  const connectTrusted = (peerId: string) => {
    setTargetId(peerId);
    connectToTarget(peerId);
    setAccountOpen(false);
  };

  const sectionTitle = "text-xs font-semibold uppercase tracking-widest text-slate-400";
  const card = "rounded-2xl border border-slate-800 bg-slate-900/40";
  const badge = "ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-cyan-500/20 px-1.5 text-[10px] font-bold text-cyan-300";
  const sheetClass = "w-full max-w-[400px] border-slate-800 bg-[#0a0f1f] text-slate-100 overflow-y-auto";
  // The Progress component's default colours come from a "primary" token this app does not define
  const progressBar = "h-1.5 bg-slate-800 [&>*]:bg-cyan-400";

  // "3 of 12 files sent · 45% · 2m left"
  const renderBatchSummary = (batch: BatchSummary, verb: "sent" | "received") => (
    <div className="space-y-1.5 border-b border-slate-800 px-4 py-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-200">
          {batch.done} of {batch.total} files {verb}
          {batch.failed > 0 && <span className="text-rose-400"> · {batch.failed} failed</span>}
        </span>
        <span className="text-slate-400">{Math.round(batch.progress * 100)}%</span>
      </div>
      <Progress value={Math.min(Math.max(batch.progress * 100, 0), 100)} className={progressBar} />
      <p className="flex justify-between gap-2 text-[11px] text-slate-500">
        <span>{formatBytes(batch.bytes)} of {formatBytes(batch.totalBytes)}</span>
        <span>{batch.active ? formatEta(batch.eta) : "Finished"}</span>
      </p>
    </div>
  );

  const renderVerifiedBadge = (verified: boolean | null) =>
    verified === true ? (
      <span className="inline-flex items-center gap-1 text-emerald-400" title="SHA-256 checksum matches on both sides">
        <ShieldCheck className="size-3" /> Verified
      </span>
    ) : verified === false ? (
      <span className="inline-flex items-center gap-1 text-rose-400" title="The received file differs from the original. Send it again.">
        <ShieldAlert className="size-3" /> Checksum mismatch
      </span>
    ) : null;

  const receivedPanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className={sectionTitle}>Received</h2>
        <span className="text-xs text-slate-500">{readyCount} ready</span>
      </div>
      {receiveBatch && <div className="border-t border-slate-800">{renderBatchSummary(receiveBatch, "received")}</div>}
      <div className={`min-h-0 flex-1 space-y-2 overflow-y-auto px-4 ${receiveBatch ? "pt-3" : ""}`}>
        {inboxItems.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-800 px-4 py-10 text-center">
            <Download className="size-6 text-slate-600" />
            <p className="text-sm text-slate-400">Nothing received yet</p>
            <p className="text-xs text-slate-500">Files your peer sends will appear here.</p>
          </div>
        ) : (
          inboxItems.slice(0, 200).map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              {item.source === "Folder" ? (
                <FolderIcon className="size-4 shrink-0 text-amber-300" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-cyan-300" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={item.name}>{item.name}</p>
                {item.complete ? (
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span>{formatBytes(item.size)}</span>
                    {renderVerifiedBadge(item.verified)}
                  </p>
                ) : item.status === "failed" ? (
                  <p className="text-xs text-rose-400">{item.error ?? "Transfer failed"}</p>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    <Progress value={Math.min(Math.max(item.progress * 100, 0), 100)} className={progressBar} />
                    <p className="flex justify-between gap-2 text-[11px] text-slate-500">
                      <span className={item.status === "waiting" ? "text-amber-300" : undefined}>
                        {statusLabel[item.status] ?? `${Math.round(item.progress * 100)}% of ${formatBytes(item.size)}`}
                      </span>
                      <span className="shrink-0">
                        {item.status === "receiving" && item.rate > 0 ? `${formatBytes(item.rate)}/s · ${formatEta(item.eta)}` : ""}
                      </span>
                    </p>
                  </div>
                )}
              </div>
              {item.complete && (
                <Button size="sm" variant="ghost" onClick={() => downloadInboxFile(item)} aria-label={`Download ${item.name}`} title="Save">
                  <Download className="size-4" />
                </Button>
              )}
            </div>
          ))
        )}
        {inboxItems.length > 200 && (
          <p className="py-2 text-center text-xs text-slate-500">+{inboxItems.length - 200} more · use Save all</p>
        )}
      </div>
      <div className="flex gap-2 border-t border-slate-800 p-4">
        <Button variant="default" size="sm" className="flex-1" onClick={downloadAll} disabled={readyCount === 0}>
          <Download className="size-4" /> Save all
        </Button>
        <Button variant="outline" size="sm" onClick={clearInbox} disabled={inboxItems.length === 0} aria-label="Clear received">
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-dvh flex-col bg-gradient-to-br from-[#030712] via-[#0b1120] to-[#111827] text-slate-100">
      <SpeedInsights />

      <header className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-[#020617]/80 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-bold tracking-tight">My<span className="text-cyan-500">FTP</span></h1>

        <div className="flex min-w-0 items-center gap-1 rounded-full border border-slate-700 bg-slate-900/60 py-1 pr-1 pl-3 text-xs">
          <span
            className={`size-2 shrink-0 rounded-full ${peerReady ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`}
            title={peerReady ? "Online" : "Connecting to server"}
          />
          <span className="ml-1 hidden text-slate-400 sm:inline">Your ID</span>
          <span className="max-w-[9rem] truncate font-mono font-semibold sm:max-w-none">{myId}</span>
          <Button variant="ghost" size="sm" className="!rounded-full !px-2" onClick={copyPeerId} aria-label="Copy peer ID" title="Copy ID">
            {idCopied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" className="!rounded-full !px-2" onClick={copyShareLink} aria-label="Copy share link" title="Copy share link">
            <Link2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="!rounded-full !px-2"
            onClick={() => setQrOpen(true)}
            disabled={!peerShareLink}
            aria-label="Show QR code"
            title="Show QR code"
          >
            <QrCode className="size-3.5" />
          </Button>
        </div>

        <div className="order-last w-full lg:order-none lg:mx-auto lg:w-auto lg:max-w-xl lg:flex-1">
          {isConnected ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5">
              <span
                className={`size-2 shrink-0 rounded-full ${linkQuality.dot}`}
                title={`Link quality: ${linkQuality.label}. ${linkQuality.hint}`}
                aria-label={`Link quality: ${linkQuality.label}`}
                role="img"
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                Connected to <span className="font-mono font-semibold">{connectedPeer}</span>
              </span>
              <span
                className={`hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] sm:inline-flex ${linkQuality.chip}`}
                title={linkQuality.hint}
              >
                {linkQuality.label}
                {diagnostics.rttMs !== null && <span className="text-slate-400">· {formatLatency(diagnostics.rttMs)}</span>}
                {diagnostics.route !== "unknown" && (
                  <span className="text-slate-400">· {diagnostics.route === "relay" ? "Relay" : "Direct"}</span>
                )}
              </span>
              <Button variant="destructive" size="sm" onClick={disconnectFromTarget}>Disconnect</Button>
            </div>
          ) : connecting && !reconnecting ? (
            <div className="flex items-center gap-2 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5" role="status">
              <LoaderCircle className="size-4 shrink-0 animate-spin text-cyan-300" />
              <span className="min-w-0 flex-1 truncate text-sm">
                Connecting to <span className="font-mono font-semibold">{connecting}</span>…
              </span>
              <Button variant="outline" size="sm" onClick={disconnectFromTarget}>Cancel</Button>
            </div>
          ) : reconnecting ? (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-1.5" role="status">
              {reconnecting.mode === "dialing" ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-amber-300" />
              ) : (
                <WifiOff className="size-4 shrink-0 text-amber-300" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {reconnecting.mode === "dialing" ? "Reconnecting to " : "Connection lost, waiting for "}
                <span className="font-mono font-semibold">{reconnecting.peerId}</span>
                {reconnecting.mode === "dialing" && reconnecting.attempt > 1 ? ` (try ${reconnecting.attempt})` : "…"}
              </span>
              <Button variant="outline" size="sm" onClick={disconnectFromTarget}>Cancel</Button>
            </div>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                connectToTarget();
              }}
            >
              <Input
                aria-label="Peer ID to connect to"
                placeholder="Enter a friend's peer ID…"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="font-mono"
              />
              <Button type="submit" variant="default" disabled={!peerReady || !targetId.trim()}>Connect</Button>
            </form>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <Settings className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAccountOpen(true)} aria-label="Account and trusted peers" title="Account">
            <UserRound className="size-4" />
            {authUserId && <span className="size-1.5 rounded-full bg-emerald-400" />}
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <Tabs value={panelTab} onValueChange={changeTab} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabsList className="order-last h-auto shrink-0 rounded-none border-x-0 border-b-0 border-t border-slate-800 bg-[#020617]/90 lg:order-first lg:border-t-0 lg:border-b">
            <TabsTrigger value="transfer" className="gap-1.5 text-xs">
              <ArrowUpFromLine className="size-4" /><span className="hidden sm:inline">Send</span>
              {queue.length > 0 && <span className={badge}>{queue.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="received" className="gap-1.5 text-xs lg:hidden">
              <Download className="size-4" /><span className="hidden sm:inline">Received</span>
              {readyCount > 0 && <span className={badge}>{readyCount}</span>}
            </TabsTrigger>
            <TabsTrigger value="chat" className="gap-1.5 text-xs">
              <MessageSquare className="size-4" /><span className="hidden sm:inline">Chat</span>
              {unreadChat > 0 && <span className={badge}>{unreadChat}</span>}
            </TabsTrigger>
            <TabsTrigger value="call" className="gap-1.5 text-xs">
              <Phone className="size-4" /><span className="hidden sm:inline">Call</span>
              {callType && <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />}
            </TabsTrigger>
            <TabsTrigger value="diag" className="gap-1.5 text-xs">
              <ScrollText className="size-4" /><span className="hidden sm:inline">Logs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="transfer"
            className="relative mt-0 min-h-0 flex-1 overflow-y-auto"
            onDragEnter={(event) => {
              event.preventDefault();
              dragDepthRef.current += 1;
              setIsDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={() => {
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setIsDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              dragDepthRef.current = 0;
              setIsDragging(false);
              void onDropFiles(event.dataTransfer);
            }}
          >
            <div className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-6">
              <div
                className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
                  isDragging ? "border-cyan-400 bg-cyan-500/10" : "border-slate-700 bg-slate-900/30"
                }`}
              >
                <UploadCloud className={`size-10 ${isDragging ? "text-cyan-300" : "text-slate-500"}`} />
                <div>
                  <p className="text-base font-semibold">{isDragging ? "Drop to add to the queue" : "Drop files or folders here"}</p>
                  <p className="mt-1 text-sm text-slate-400">
                    {isConnected ? "They'll be sent directly to your peer." : "You can queue files now and send once you're connected."}
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                    <FileIcon className="size-4" /> Choose files
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => folderInputRef.current?.click()}>
                    <FolderUp className="size-4" /> Choose folder
                  </Button>
                </div>
              </div>

              {queue.length > 0 && (
                <section className={card}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
                    <div>
                      <h2 className={sectionTitle}>Queue</h2>
                      <p className="text-xs text-slate-500">{queue.length} item(s) · {formatBytes(queueBytes)}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setQueue([])}>Clear</Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => void sendFilePayloads(queue)}
                        disabled={!isConnected || sendsRunning}
                        title={isConnected ? undefined : "Connect to a peer first"}
                      >
                        <ArrowUpFromLine className="size-4" /> Send all
                      </Button>
                    </div>
                  </div>
                  <ul className="max-h-80 divide-y divide-slate-800/70 overflow-y-auto">
                    {visibleQueue.map((item) => (
                      <li key={item.id} className="flex items-center gap-3 px-4 py-2">
                        {item.source === "Folder" ? (
                          <FolderIcon className="size-4 shrink-0 text-amber-300" />
                        ) : (
                          <FileIcon className="size-4 shrink-0 text-cyan-300" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>{item.path}</span>
                        <span className="shrink-0 text-xs text-slate-500">{formatBytes(item.file.size)}</span>
                        <Button variant="ghost" size="sm" className="!px-1.5" onClick={() => removeQueuedFile(item.id)} aria-label={`Remove ${item.path}`}>
                          <X className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {queue.length > visibleQueue.length && (
                    <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">+{queue.length - visibleQueue.length} more</p>
                  )}
                </section>
              )}

              {sendingItems.length > 0 && (
                <section className={card}>
                  <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                    <h2 className={sectionTitle}>Sending</h2>
                    <Button variant="ghost" size="sm" onClick={clearFinishedSends} disabled={!sendingItems.some((item) => item.complete)}>
                      Clear finished
                    </Button>
                  </div>
                  {sendsRunning && (
                    <p className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                      You can switch tabs, but keep this one open until transfers finish. Dropped connections resume automatically.
                    </p>
                  )}
                  {sendBatch && renderBatchSummary(sendBatch, "sent")}
                  <ul className="max-h-80 divide-y divide-slate-800/70 overflow-y-auto">
                    {sendingItems.slice(0, 200).map((item) => (
                      <li key={item.id} className="space-y-1.5 px-4 py-3">
                        <div className="flex items-center gap-3">
                          {item.status === "done" ? (
                            item.verified === true ? (
                              <ShieldCheck className="size-4 shrink-0 text-emerald-400" aria-label="Verified" />
                            ) : item.verified === false ? (
                              <ShieldAlert className="size-4 shrink-0 text-rose-400" aria-label="Checksum mismatch" />
                            ) : (
                              <Check className="size-4 shrink-0 text-emerald-400" aria-label="Sent" />
                            )
                          ) : item.status === "failed" ? (
                            <X className="size-4 shrink-0 text-rose-400" aria-label="Failed" />
                          ) : item.status === "waiting" ? (
                            <WifiOff className="size-4 shrink-0 text-amber-300" aria-label="Paused" />
                          ) : item.status === "verifying" ? (
                            <LoaderCircle className="size-4 shrink-0 animate-spin text-cyan-300" aria-label="Verifying" />
                          ) : (
                            <ArrowUpFromLine
                              className={`size-4 shrink-0 ${item.status === "sending" ? "animate-pulse text-cyan-300" : "text-slate-600"}`}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>{item.name}</span>
                          <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                            {item.status === "failed" && <span className="text-rose-400">Failed</span>}
                            {item.status === "done" && renderVerifiedBadge(item.verified)}
                            {formatBytes(item.size)}
                          </span>
                        </div>
                        {item.status === "queued" ? (
                          <p className="text-[11px] text-slate-500">{statusLabel.queued}</p>
                        ) : (
                          !item.complete && (
                            <>
                              <Progress value={Math.min(Math.max(item.progress * 100, 0), 100)} className={progressBar} />
                              <p className="flex justify-between gap-2 text-[11px] text-slate-500">
                                <span className={item.status === "waiting" ? "text-amber-300" : undefined}>
                                  {statusLabel[item.status] ?? `${Math.round(item.progress * 100)}%`}
                                </span>
                                <span className="shrink-0">
                                  {item.status === "sending" && item.rate > 0 ? `${formatBytes(item.rate)}/s · ${formatEta(item.eta)}` : ""}
                                </span>
                              </p>
                            </>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                  {sendingItems.length > 200 && (
                    <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">+{sendingItems.length - 200} more</p>
                  )}
                </section>
              )}
            </div>
          </TabsContent>

          <TabsContent value="received" className="mt-0 min-h-0 flex-1 lg:hidden">
            {receivedPanel}
          </TabsContent>

          <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col">
            <div ref={chatContainerRef} className="min-h-0 flex-1 overflow-y-auto" role="log" aria-live="polite">
              <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 p-4 sm:p-6">
                {chatMessages.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-16 text-center">
                    <MessageSquare className="size-8 text-slate-600" />
                    <p className="text-sm text-slate-400">No messages yet</p>
                    <p className="text-xs text-slate-500">{isConnected ? "Say hi to your peer." : "Connect to a peer to start chatting."}</p>
                  </div>
                ) : (
                  chatMessages.slice(-100).map((row) => (
                    <div key={row.id} className={`flex flex-col ${row.mine ? "items-end" : "items-start"}`}>
                      <div
                        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                          row.mine ? "rounded-br-sm bg-cyan-500 text-slate-950" : "rounded-bl-sm border border-slate-700 bg-slate-800/70"
                        }`}
                      >
                        {row.text}
                      </div>
                      <span className="mt-0.5 px-1 text-[10px] text-slate-500">{row.mine ? "You" : "Peer"} · {row.time}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <form
              className="mx-auto flex w-full max-w-3xl gap-2 border-t border-slate-800 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                sendCurrentMessage();
              }}
            >
              <Input
                aria-label="Display name"
                placeholder="Name"
                value={sender}
                onChange={(event) => setSender(event.target.value)}
                className="!w-24 shrink-0 sm:!w-32"
              />
              <Input
                aria-label="Message"
                placeholder={isConnected ? "Type a message…" : "Connect to chat"}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={!isConnected}
              />
              <Button type="submit" variant="default" disabled={!isConnected || !message.trim()}>Send</Button>
            </form>
          </TabsContent>

          <TabsContent value="call" className="mt-0 min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className={`${card} relative overflow-hidden`}>
                  <video ref={remoteVideoRef} autoPlay playsInline className="aspect-video w-full bg-slate-950 object-cover" aria-label="Remote video" />
                  <span className="absolute top-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px]">Peer</span>
                </div>
                <div className={`${card} relative overflow-hidden`}>
                  <video ref={localVideoRef} autoPlay playsInline muted className="aspect-video w-full -scale-x-100 bg-slate-950 object-cover" aria-label="Local video" />
                  <span className="absolute top-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[11px]">You</span>
                </div>
              </div>

              {callType === "audio" && (
                <div className={`${card} p-4`}>
                  <p className="mb-2 text-xs text-slate-400">Voice activity</p>
                  <div className="flex h-12 items-end gap-1">
                    {Array.from({ length: 24 }).map((_, i) => {
                      const wave = Math.min(1, audioLevel + ((i % 3) + 1) * 0.08);
                      return (
                        <span
                          key={`wave-${i}`}
                          className="w-1.5 rounded-sm bg-cyan-400/85"
                          style={{ height: 4 + Math.round(wave * 40) }}
                          aria-hidden="true"
                        />
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-center gap-2">
                {callType ? (
                  <>
                    <Button variant={micEnabled ? "outline" : "destructive"} onClick={toggleMic} aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}>
                      {micEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                      {micEnabled ? "Mute" : "Unmute"}
                    </Button>
                    {callType === "video" && (
                      <Button variant={cameraEnabled ? "outline" : "destructive"} onClick={toggleCamera} aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}>
                        {cameraEnabled ? <Video className="size-4" /> : <VideoOff className="size-4" />}
                        {cameraEnabled ? "Camera off" : "Camera on"}
                      </Button>
                    )}
                    <Button variant="destructive" onClick={endCall}>
                      <PhoneOff className="size-4" /> End call
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="default" onClick={() => startCall("audio")} disabled={!isConnected}>
                      <Phone className="size-4" /> Voice call
                    </Button>
                    <Button variant="default" onClick={() => startCall("video")} disabled={!isConnected}>
                      <Video className="size-4" /> Video call
                    </Button>
                  </>
                )}
              </div>
              {!isConnected && <p className="text-center text-xs text-slate-500">Connect to a peer to start a call.</p>}
            </div>
          </TabsContent>

          <TabsContent value="diag" className="mt-0 flex min-h-0 flex-1 flex-col">
            <div className="grid grid-cols-2 gap-2 border-b border-slate-800 p-4 text-xs sm:grid-cols-4">
              <div className={`${card} p-3`}>
                <p className="text-slate-500">Channel</p>
                <p className={`font-mono font-semibold ${diagnostics.dataChannelState === "open" ? "text-emerald-400" : "text-amber-400"}`}>{diagnostics.dataChannelState}</p>
              </div>
              <div className={`${card} p-3`}>
                <p className="text-slate-500">Buffered</p>
                <p className={`font-mono font-semibold ${diagnostics.bufferedAmount > BUFFER_HIGH_WATERMARK ? "text-rose-400" : "text-emerald-400"}`}>{formatBytes(diagnostics.bufferedAmount)}</p>
              </div>
              <div className={`${card} p-3`}>
                <p className="text-slate-500">Ping (RTT)</p>
                <p className={`font-mono font-semibold ${diagnostics.rttMs === null ? "text-amber-400" : diagnostics.rttMs > 220 ? "text-rose-400" : "text-emerald-400"}`}>{formatLatency(diagnostics.rttMs)}</p>
              </div>
              <div className={`${card} p-3`}>
                <p className="text-slate-500">Route</p>
                <p className="font-mono font-semibold text-slate-300">{diagnostics.route}</p>
              </div>
            </div>
            <div ref={logContainerRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-4 font-mono text-xs" role="log" aria-live="polite">
              {logs.length === 0 ? (
                <p className="text-slate-500">No log entries.</p>
              ) : (
                logs.slice(-200).map((row) => (
                  <div key={row.id} className={row.error ? "text-rose-400" : row.text.includes("Sent:") ? "text-cyan-400" : "text-slate-300"}>
                    {row.text}
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-slate-800 p-3">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  setLogs([]);
                  setChatSeen(0);
                  pushLog("Logs cleared.");
                }}
              >
                Clear logs
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <aside className="hidden w-[340px] shrink-0 border-l border-slate-800 bg-[#020617]/60 lg:block">
          {receivedPanel}
        </aside>
      </main>

      <Sheet open={accountOpen} onOpenChange={setAccountOpen}>
        <SheetContent side="right" className={sheetClass}>
          <SheetHeader>
            <SheetTitle className="text-slate-100">Account</SheetTitle>
            <SheetDescription className="text-slate-400">Sign in to save trusted peers across devices.</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            {authUserId ? (
              <div className={`${card} flex items-center justify-between gap-2 p-3`}>
                <div className="min-w-0">
                  <p className="text-xs text-slate-500">Signed in</p>
                  <p className="truncate font-mono text-sm">{authEmail || `${authUserId.slice(0, 8)}…`}</p>
                </div>
                <Button variant="outline" size="sm" onClick={signOutAccount}>Sign out</Button>
              </div>
            ) : (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void signInAccount();
                }}
              >
                <Input aria-label="Email" placeholder="Email" type="email" autoComplete="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
                <Input aria-label="Password" placeholder="Password" type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <Button type="submit" variant="default" size="sm">Sign in</Button>
                  <Button type="button" variant="outline" size="sm" onClick={signUpAccount}>Create account</Button>
                </div>
              </form>
            )}

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className={sectionTitle}>Trusted peers</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={saveTrustedConnection}
                  disabled={!isConnected || !authUserId}
                  title={!authUserId ? "Sign in first" : !isConnected ? "Connect to a peer first" : undefined}
                >
                  Save current
                </Button>
              </div>
              {trustedPeers.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {authUserId ? "Connect to someone, then save them here for one-click reconnects." : "Sign in to use trusted peers."}
                </p>
              ) : (
                <ul className="space-y-2">
                  {trustedPeers.map((peerId) => (
                    <li key={peerId} className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-2 pl-3">
                      <span className="min-w-0 flex-1 truncate font-mono text-sm">{peerId}</span>
                      <Button variant="secondary" size="sm" onClick={() => connectTrusted(peerId)} disabled={isConnected}>
                        Connect
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className={sheetClass}>
          <SheetHeader>
            <SheetTitle className="text-slate-100">Settings</SheetTitle>
            <SheetDescription className="text-slate-400">{modeHint}</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            <section className="space-y-3">
              <h2 className={sectionTitle}>Your peer</h2>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" onClick={() => makePeer(true)}>New ID</Button>
                <Button variant="outline" size="sm" onClick={() => makePeer()}>
                  <RefreshCw className="size-3.5" /> Reconnect
                </Button>
              </div>
            </section>

            <section className="space-y-3">
              <h2 className={sectionTitle}>Peer server</h2>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as "cloud" | "local");
                  applyModeDefaults(value as "cloud" | "local");
                }}
              >
                <SelectTrigger id="mode-select" aria-label="Peer server">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cloud">Cloud (PeerJS)</SelectItem>
                  <SelectItem value="local">Local server</SelectItem>
                </SelectContent>
              </Select>
              <label className="block space-y-1 text-xs text-slate-400">
                <span>Host</span>
                <Input value={host} onChange={(event) => setHost(event.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1 text-xs text-slate-400">
                  <span>Port</span>
                  <Input inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
                </label>
                <label className="block space-y-1 text-xs text-slate-400">
                  <span>Path</span>
                  <Input value={path} onChange={(event) => setPath(event.target.value)} />
                </label>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-800 px-3 py-2">
                <span className="text-sm">Secure (TLS)</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={secure === "true"}
                  aria-label="Secure connection"
                  onClick={() => setSecure(secure === "true" ? "false" : "true")}
                  className={`relative h-6 w-11 rounded-full transition ${secure === "true" ? "bg-cyan-500" : "bg-slate-700"}`}
                >
                  <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${secure === "true" ? "left-[22px]" : "left-0.5"}`} />
                </button>
              </div>
              <p className="text-xs text-slate-500">Changes apply the next time you press Reconnect.</p>
            </section>
          </div>
        </SheetContent>
      </Sheet>

      {qrOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setQrOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="qr-title"
            className="w-full max-w-xs rounded-2xl border border-slate-800 bg-[#0a0f1f] p-5 text-center shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 id="qr-title" className={sectionTitle}>Scan to connect</h2>
              <Button variant="ghost" size="sm" className="!px-1.5" onClick={() => setQrOpen(false)} aria-label="Close" autoFocus>
                <X className="size-4" />
              </Button>
            </div>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt="QR code for your share link" className="mt-3 aspect-square w-full rounded-xl bg-white p-2" />
            ) : (
              <div className="mt-3 aspect-square w-full animate-pulse rounded-xl bg-slate-800" />
            )}
            <p className="mt-3 font-mono text-sm font-semibold">{myId}</p>
            <p className="mt-1 text-xs text-slate-400">Scan with another device&apos;s camera. It connects to you automatically.</p>
            <Button variant="outline" size="sm" className="mt-4 w-full" onClick={copyShareLink}>
              <Link2 className="size-4" /> Copy link instead
            </Button>
          </div>
        </div>
      )}

      <input ref={fileInputRef} className="hidden" type="file" multiple onChange={(event) => onFilesSelected(event.currentTarget, "Files")} />
      <input ref={folderInputRef} className="hidden" type="file" multiple onChange={(event) => onFilesSelected(event.currentTarget, "Folder")} />
    </div>
  );
}
