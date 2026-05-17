/**
 * KyberBot — Channel Interface
 *
 * Defines the contract for messaging channel bridges.
 */

/**
 * Inbound binary attachment carried alongside a ChannelMessage. Today
 * audio is fully wired (whisper.cpp transcription, Phase 2.3); image
 * and document are reserved so future multimodal work can plug in
 * without changing the channel contract again.
 */
export interface Attachment {
  kind: 'audio' | 'image' | 'document';
  /** MIME type from the wire (e.g. 'audio/ogg', 'image/jpeg'). */
  mime: string;
  /** Raw bytes pulled from the channel CDN. */
  bytes: Buffer;
  /** Filename if the channel exposes one; otherwise channel-derived. */
  filename?: string;
  /** Text transcription, when one applies (audio → STT). */
  transcript?: string;
}

export interface ChannelMessage {
  id: string;
  channelType: string;
  from: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  /** Optional binary attachments. See Attachment above. */
  attachments?: Attachment[];
}

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface Channel {
  /** Channel identifier (e.g., 'telegram', 'whatsapp') */
  readonly name: string;

  /** Initialize the channel connection */
  start(): Promise<void>;

  /** Gracefully shut down the channel */
  stop(): Promise<void>;

  /** Send a message through the channel */
  send(to: string, message: string): Promise<void>;

  /** Whether the channel is currently connected */
  isConnected(): boolean;

  /** Register a handler for incoming messages */
  onMessage(handler: (message: ChannelMessage) => Promise<void>): void;
}
