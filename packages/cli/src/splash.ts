/**
 * KyberBot — ASCII Splash Screen
 *
 * Displays the startup banner and service status.
 * Design: emerald green block-letter ASCII inside a bordered box.
 */

import chalk from 'chalk';
import { ServiceStatus } from './types.js';
import { getAgentName } from './config.js';

// Color palette
const EMERALD = chalk.hex('#50C878');  // Primary — logo, branding
const PRIMARY = chalk.hex('#FF6B6B');  // Warm — ready message, agent name
const DIM = chalk.dim;
const BORDER = chalk.hex('#50C878');   // Border color

const WIDTH = 76;

export function displayBanner(mode: 'single' | 'fleet' = 'single'): void {
  const isFleet = mode === 'fleet';
  const B = isFleet ? chalk.hex('#22d3ee') : BORDER; // cyan border for fleet
  const INNER = 74;

  // Emerald gradient for single, cyan gradient for fleet
  const artColors = isFleet
    ? ['#A8E8F0', '#82D8E8', '#5CC8DC', '#3CB8CF', '#24A8C0', '#10B0C8']
    : ['#A8F0C8', '#82E8A8', '#5CDC88', '#3CCF6E', '#24C05A', '#10B048'];

  const artLines: string[] = [
    '██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗  ██████╗ ████████╗',
    '██║ ██╔╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝',
    '█████╔╝  ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██║   ██║   ██║',
    '██╔═██╗   ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗██║   ██║   ██║',
    '██║  ██╗   ██║   ██████╔╝███████╗██║  ██║██████╔╝╚██████╔╝   ██║',
    '╚═╝  ╚═╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝',
  ];
  const maxArtWidth = Math.max(...artLines.map(raw => raw.length));
  const artPadLeft = Math.floor((INNER - maxArtWidth) / 2);

  const artLine = (color: string, raw: string) => {
    const rp = INNER - artPadLeft - raw.length;
    return B('║') + ' '.repeat(artPadLeft) + chalk.hex(color).bold(raw) + ' '.repeat(rp) + B('║');
  };

  console.log(B('╔' + '═'.repeat(INNER) + '╗'));
  console.log(B('║') + ' '.repeat(INNER) + B('║'));
  for (let i = 0; i < artLines.length; i++) {
    console.log(artLine(artColors[i], artLines[i]));
  }
  console.log(B('║') + ' '.repeat(INNER) + B('║'));

  // Tagline
  if (isFleet) {
    const tagPart1 = 'Personal AI Operating System. ';
    const tagPart2 = 'FLEET MODE';
    const tagLen = tagPart1.length + tagPart2.length;
    const tagPadLeft = Math.floor((INNER - tagLen) / 2);
    const tagPadRight = INNER - tagLen - tagPadLeft;
    console.log(B('║') + ' '.repeat(tagPadLeft) + DIM(tagPart1) + chalk.hex('#22d3ee').bold(tagPart2) + ' '.repeat(tagPadRight) + B('║'));
  } else {
    const tagPart1 = 'Personal AI Operating System. ';
    const tagPart2 = 'Powered by Claude Code.';
    const tagLen = tagPart1.length + tagPart2.length;
    const tagPadLeft = Math.floor((INNER - tagLen) / 2);
    const tagPadRight = INNER - tagLen - tagPadLeft;
    console.log(B('║') + ' '.repeat(tagPadLeft) + DIM(tagPart1) + EMERALD(tagPart2) + ' '.repeat(tagPadRight) + B('║'));
  }

  console.log(B('║') + ' '.repeat(INNER) + B('║'));
  console.log(B('╚' + '═'.repeat(INNER) + '╝'));
  console.log();
}

export function displaySplash(root: string): void {
  console.clear();
  console.log();

  displayBanner();

  // Metadata
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  console.log(DIM('  Agent: ') + chalk.white(agentName));
  console.log(DIM('  Root:  ') + chalk.white(root));
  console.log();
}

export function displayServiceStatus(services: ServiceStatus[]): void {
  const maxNameLength = Math.max(...services.map(s => s.name.length));

  for (const service of services) {
    const name = service.name.padEnd(maxNameLength + 2);
    const statusIcon = getStatusIcon(service.status);
    const statusText = getStatusText(service.status);
    const extra = service.extra ? DIM(` ${service.extra}`) : '';

    console.log(`  ${statusIcon} ${name} ${statusText}${extra}`);
  }
  console.log();
}

function getStatusIcon(status: ServiceStatus['status']): string {
  switch (status) {
    case 'running': return chalk.green('✓');
    case 'starting': return chalk.yellow('◐');
    case 'stopped': return chalk.gray('○');
    case 'error': return chalk.red('✗');
    case 'disabled': return chalk.gray('─');
  }
}

function getStatusText(status: ServiceStatus['status']): string {
  switch (status) {
    case 'running': return chalk.green('[RUNNING]');
    case 'starting': return chalk.yellow('[STARTING]');
    case 'stopped': return chalk.gray('[STOPPED]');
    case 'error': return chalk.red('[ERROR]');
    case 'disabled': return chalk.gray('[DISABLED]');
  }
}

export function displayShutdownMessage(): void {
  console.log();
  console.log(DIM('  Shutting down...'));
}

export function displayReadyMessage(): void {
  let agentName: string;
  try {
    agentName = getAgentName();
  } catch {
    agentName = 'KyberBot';
  }

  console.log(DIM('═'.repeat(WIDTH)));
  console.log();
  console.log('  ' + PRIMARY.bold(`${agentName} is ready.`));
  console.log();
  console.log(DIM('═'.repeat(WIDTH)));
  console.log();
}

export function displayConnectionInfo(info: {
  port: number;
  apiToken?: string;
}) {
  const { port, apiToken } = info;
  console.log('');
  console.log(`  ${DIM('Local:')}    http://localhost:${port}`);
  if (apiToken) {
    console.log(`  ${DIM('API Key:')}  ${apiToken}`);
  }
  console.log('');
}
