/**
 * KyberBot — Shared Types
 *
 * Core type definitions used across the application.
 */

export interface ServiceStatus {
  name: string;
  status: 'running' | 'starting' | 'stopped' | 'error' | 'disabled';
  extra?: string;
}

export interface ServiceHandle {
  stop: () => Promise<void>;
  status: () => ServiceStatus['status'];
}

export interface ServiceConfig {
  name: string;
  enabled: boolean;
  start: () => Promise<ServiceHandle>;
}

export interface IdentityConfig {
  agent_name: string;
  agent_description?: string;
  kyberbot_version?: string;
  timezone: string;
  locale?: string;
  heartbeat_interval: string;
  heartbeat_active_hours?: {
    start: string;
    end: string;
    timezone?: string;
  };
  /**
   * Model used for heartbeat and orchestration (CEO/worker) Claude calls.
   * Defaults to 'sonnet' if unset — heartbeat is tool-use orchestration,
   * not deep reasoning, so running Opus there is wasteful. The agent's
   * main chat still uses `claude.model` (Opus by default).
   */
  heartbeat_model?: 'haiku' | 'sonnet' | 'opus';
  server?: {
    port: number;
    host?: string;
  };
  channels?: {
    telegram?: {
      /**
       * Bot token. Preferred location: `TELEGRAM_BOT_TOKEN` env var (so the
       * token never lands in a committed identity.yaml). YAML fallback is
       * supported for legacy configs but discouraged.
       */
      bot_token?: string;
      owner_chat_id?: number;
    };
    whatsapp?: {
      enabled: boolean;
      /**
       * WhatsApp JID of the verified owner. The channel REFUSES to start
       * without this. Format: `<phone>@s.whatsapp.net` (personal) or
       * `<groupId>@g.us` (group). Set manually in identity.yaml.
       */
      owner_jid?: string;
      /**
       * Phone number being linked (the "Alfred" WhatsApp account, NOT the
       * owner). Country code + digits, no `+`, e.g. "6512345678". When set,
       * the channel uses pairing-code flow instead of QR — Baileys' QR flow
       * has been broken since Feb 2026 due to upstream bugs.
       */
      linked_phone?: string;
    };
  };
  backup?: {
    enabled: boolean;
    remote_url: string;
    schedule: string;
    branch?: string;
  };
  claude?: {
    mode: 'subscription' | 'sdk';
    model?: string;
    /**
     * Enable the warm Claude subprocess pool for messaging channels
     * (Telegram, WhatsApp). Trades ~200MB resident per chat session for
     * ~3-5s saved on warm turns (subsequent messages within ~30 min of
     * each other). Default off — opt in here or via `KYBERBOT_WARM_POOL=1`.
     */
    warm_pool?: boolean;
  };
  /**
   * Hybrid-search rerank provider. Defaults to 'openai' when OPENAI_API_KEY
   * is set (fast, ~300ms via gpt-5.4-nano), falling back to 'claude'
   * (subscription Haiku subprocess, ~2s) otherwise. Override per-agent here
   * or via the KYBERBOT_RERANK_PROVIDER env var.
   */
  rerank?: {
    provider?: 'openai' | 'claude';
    model?: string;
  };
  memory?: {
    entity_stoplist?: string[];
  };
  subscriptions?: Array<{
    from: string;
    topic: string;
  }>;
  watched_folders?: Array<{
    path: string;
    label?: string;
    enabled?: boolean;
    extensions?: string[];
  }>;
}
