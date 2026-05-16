/**
 * Channel Command
 *
 * Channel management: list, add, remove, status.
 * Reads and writes channel configuration in identity.yaml.
 *
 * Usage:
 *   kyberbot channel list                    # Show configured channels
 *   kyberbot channel add telegram|whatsapp   # Configure a channel
 *   kyberbot channel remove <name>           # Remove a channel
 *   kyberbot channel status                  # Check channel connectivity
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getRoot, getIdentity, getServerPort } from '../config.js';
import { IdentityConfig } from '../types.js';

type ChannelType = 'telegram' | 'whatsapp';

interface ChannelInfo {
  type: ChannelType;
  configured: boolean;
  enabled: boolean;
  details: string;
}

function getChannelInfos(identity: IdentityConfig): ChannelInfo[] {
  const channels: ChannelInfo[] = [];

  if (identity.channels?.telegram) {
    const tg = identity.channels.telegram;
    const hasToken = !!tg.bot_token && tg.bot_token !== 'YOUR_BOT_TOKEN_HERE';
    const hasOwner = !!tg.owner_chat_id;
    let details = 'No bot token';
    if (hasToken && hasOwner) {
      details = `Verified (owner: ${tg.owner_chat_id})`;
    } else if (hasToken) {
      details = 'Bot token set — pending verification';
    }
    channels.push({
      type: 'telegram',
      configured: hasToken,
      enabled: true,
      details,
    });
  }

  if (identity.channels?.whatsapp) {
    const wa = identity.channels.whatsapp;
    channels.push({
      type: 'whatsapp',
      configured: wa.enabled,
      enabled: wa.enabled,
      details: wa.enabled ? 'Enabled' : 'Disabled',
    });
  }

  return channels;
}

export function createChannelCommand(): Command {
  const cmd = new Command('channel')
    .description('Manage messaging channels');

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel list
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('Show configured channels')
    .action(() => {
      try {
        const identity = getIdentity();
        const channels = getChannelInfos(identity);

        console.log(chalk.cyan.bold('\nMessaging Channels\n'));

        if (channels.length === 0) {
          console.log(chalk.dim('  No channels configured.'));
          console.log(chalk.dim('  Run `kyberbot channel add telegram` to connect one.\n'));
          return;
        }

        for (const ch of channels) {
          const type = ch.type.charAt(0).toUpperCase() + ch.type.slice(1);
          const statusIcon = ch.configured
            ? chalk.green('[configured]')
            : chalk.yellow('[needs setup]');

          console.log(`  ${statusIcon} ${chalk.white.bold(type)}`);
          console.log(chalk.dim(`             ${ch.details}`));
        }

        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Run `kyberbot onboard` first to create identity.yaml.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel add <type>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('add')
    .description('Add a messaging channel')
    .argument('<type>', 'Channel type: telegram or whatsapp')
    .option('--reverify', 'Clear owner verification and generate a new code on next start')
    .action(async (type: string, opts: { reverify?: boolean }) => {
      if (type !== 'telegram' && type !== 'whatsapp') {
        console.error(chalk.red(`\nUnknown channel type: ${type}`));
        console.log(chalk.dim('  Supported: telegram, whatsapp\n'));
        process.exit(1);
      }

      try {
        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = yaml.load(raw) as Record<string, unknown>;

        if (!identity.channels) {
          identity.channels = {};
        }

        const channels = identity.channels as Record<string, unknown>;

        if (type === 'telegram') {
          if (opts.reverify && channels.telegram) {
            // Clear owner to force re-verification on next start
            const tg = channels.telegram as Record<string, unknown>;
            delete tg.owner_chat_id;
            writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

            console.log(chalk.green('\nTelegram owner verification cleared.'));
            console.log(chalk.dim('  A new verification code will be generated on next `kyberbot` start.\n'));
            return;
          }

          if (channels.telegram) {
            console.log(chalk.yellow('\nTelegram channel already configured.'));
            console.log(chalk.dim('  Edit identity.yaml to modify the bot_token.'));
            console.log(chalk.dim('  Use --reverify to clear owner and re-verify.\n'));
            return;
          }

          channels.telegram = {
            bot_token: 'YOUR_BOT_TOKEN_HERE',
          };

          writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

          console.log(chalk.green('\nTelegram channel added to identity.yaml'));
          console.log('');
          console.log(chalk.dim('  Next steps:'));
          console.log(chalk.dim('  1. Get a bot token from @BotFather on Telegram'));
          console.log(chalk.dim('  2. Replace YOUR_BOT_TOKEN_HERE in identity.yaml'));
          console.log(chalk.dim('  3. Run `kyberbot` to connect'));
          console.log(chalk.dim('  4. Send /start CODE to your bot to verify ownership'));
          console.log('');
        } else if (type === 'whatsapp') {
          if (channels.whatsapp) {
            console.log(chalk.yellow('\nWhatsApp channel already configured.'));
            console.log(chalk.dim('  Edit identity.yaml to modify settings.\n'));
            return;
          }

          // The hardened WhatsApp channel REFUSES to start without owner_jid
          // (server/channels/whatsapp.ts:44). Prompt for it now so the
          // user isn't surprised by a hard error on first `kyberbot run`.
          console.log(chalk.bold('\nWhatsApp owner JID required'));
          console.log(chalk.dim('  Anyone who messages the linked WhatsApp number can reach the agent unless'));
          console.log(chalk.dim('  we restrict it to your JID. Format: <country-code><number>@s.whatsapp.net'));
          console.log(chalk.dim('  (e.g. 14155551234@s.whatsapp.net for +1-415-555-1234).'));
          console.log(chalk.dim('  Group JIDs end with @g.us if you want to bind to a group instead.\n'));

          const ownerJid = await input({
            message: 'WhatsApp owner JID:',
            validate: (value: string) => {
              const v = value.trim();
              if (!v) return 'owner JID is required';
              // Allow letters, digits, `_`, `-`, `.`, and `:` in the local
              // part. Multi-device WhatsApp accounts emit JIDs like
              // `1234567890:42@s.whatsapp.net` (the `:N` is a device tag);
              // group LIDs sometimes include dots. The previous \w+- regex
              // rejected both forms.
              if (!/^[\w.:-]+@(s\.whatsapp\.net|g\.us)$/i.test(v)) {
                return 'Format: <id>@s.whatsapp.net or <id>@g.us';
              }
              return true;
            },
          });

          channels.whatsapp = {
            enabled: true,
            owner_jid: ownerJid.trim(),
          };

          writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

          console.log(chalk.green('\nWhatsApp channel added to identity.yaml'));
          console.log('');
          console.log(chalk.dim('  Next steps:'));
          console.log(chalk.dim('  1. Run `kyberbot` to start the pairing process'));
          console.log(chalk.dim('  2. Scan the QR code with WhatsApp on your phone'));
          console.log(chalk.dim('  3. Send yourself a message from the bound JID to test'));
          console.log('');
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Make sure identity.yaml exists. Run `kyberbot onboard` first.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel remove <type>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('remove')
    .description('Remove a messaging channel')
    .argument('<type>', 'Channel type to remove: telegram or whatsapp')
    .action((type: string) => {
      if (type !== 'telegram' && type !== 'whatsapp') {
        console.error(chalk.red(`\nUnknown channel type: ${type}`));
        console.log(chalk.dim('  Supported: telegram, whatsapp\n'));
        process.exit(1);
      }

      try {
        const root = getRoot();
        const identityPath = join(root, 'identity.yaml');
        const raw = readFileSync(identityPath, 'utf-8');
        const identity = yaml.load(raw) as Record<string, unknown>;

        if (!identity.channels) {
          console.log(chalk.yellow('\nNo channels configured.\n'));
          return;
        }

        const channels = identity.channels as Record<string, unknown>;

        if (!channels[type]) {
          console.log(chalk.yellow(`\nNo ${type} channel configured.\n`));
          return;
        }

        delete channels[type];

        // Clean up empty channels object
        if (Object.keys(channels).length === 0) {
          delete identity.channels;
        }

        writeFileSync(identityPath, yaml.dump(identity, { lineWidth: 120 }));

        const typeName = type.charAt(0).toUpperCase() + type.slice(1);
        console.log(chalk.green(`\n${typeName} channel removed from identity.yaml.\n`));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel status
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('status')
    .description('Check channel configuration and connectivity')
    .action(() => {
      try {
        const identity = getIdentity();
        const channels = getChannelInfos(identity);

        console.log(chalk.cyan.bold('\nChannel Status\n'));

        if (channels.length === 0) {
          console.log(chalk.dim('  No channels configured.'));
          console.log(chalk.dim('  Run `kyberbot channel add telegram` to get started.\n'));
          return;
        }

        for (const ch of channels) {
          const typeName = ch.type.charAt(0).toUpperCase() + ch.type.slice(1);

          if (!ch.configured) {
            console.log(`  ${chalk.yellow('[needs setup]')} ${typeName}`);
            if (ch.type === 'telegram') {
              console.log(chalk.dim('    Set bot_token in identity.yaml'));
            }
          } else if (!ch.enabled) {
            console.log(`  ${chalk.gray('[disabled]')} ${typeName}`);
          } else if (ch.type === 'telegram' && ch.details.startsWith('Verified')) {
            console.log(`  ${chalk.green('[verified]')} ${typeName}`);
            console.log(chalk.dim(`    ${ch.details}`));
          } else if (ch.type === 'telegram') {
            console.log(`  ${chalk.yellow('[pending verification]')} ${typeName}`);
            console.log(chalk.dim('    Start kyberbot to get a verification code'));
          } else {
            console.log(`  ${chalk.green('[configured]')} ${typeName}`);
          }
        }

        console.log('');
        console.log(chalk.dim('  Channels connect when `kyberbot` starts.'));
        console.log('');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        console.log(chalk.dim('  Run `kyberbot onboard` first to create identity.yaml.\n'));
      }
    });

  // ─────────────────────────────────────────────────────────────────────────
  // kyberbot channel send <type> <message>
  // ─────────────────────────────────────────────────────────────────────────

  cmd
    .command('send <type> <message>')
    .description('Send an outbound message via a connected channel')
    .option('--jid <jid>', 'Destination JID (WhatsApp only; defaults to owner_jid from identity.yaml)')
    .action(async (type: string, message: string, opts: { jid?: string }) => {
      if (type !== 'telegram' && type !== 'whatsapp') {
        console.error(chalk.red(`\nUnknown channel type: ${type}`));
        console.log(chalk.dim('  Supported: telegram, whatsapp\n'));
        process.exit(1);
      }

      try {
        let port: number;
        try {
          port = getServerPort();
        } catch {
          port = 3456;
        }

        const token = process.env.KYBERBOT_API_TOKEN || '';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const body: Record<string, string> = { type, message };
        if (opts.jid) body.jid = opts.jid;

        const res = await fetch(`http://localhost:${port}/api/web/manage/channels/send`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: res.statusText })) as Record<string, string>;
          console.error(chalk.red(`\nSend failed: ${data.error || res.statusText}\n`));
          process.exit(1);
        }

        console.log(chalk.green(`\nMessage sent via ${type}.\n`));
      } catch (error) {
        console.error(chalk.red(`\nError: ${error}\n`));
        process.exit(1);
      }
    });

  return cmd;
}
