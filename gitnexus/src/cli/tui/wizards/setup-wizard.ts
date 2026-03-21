import * as p from '@clack/prompts';
import pc from 'picocolors';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';

interface EditorInfo {
  name: string;
  key: string;
  detected: boolean;
  configPath: string;
}

export interface SetupWizardResult {
  selectedEditors: string[];
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function runSetupWizard(): Promise<SetupWizardResult | null> {
  p.intro(`${pc.bgGreen(pc.black(' GitNexus Setup '))}`);

  // Detect installed editors
  const home = os.homedir();
  const editors: EditorInfo[] = [
    {
      name: 'Cursor',
      key: 'cursor',
      detected: await dirExists(path.join(home, '.cursor')),
      configPath: path.join(home, '.cursor', 'mcp.json'),
    },
    {
      name: 'Claude Code',
      key: 'claude',
      detected: await dirExists(path.join(home, '.claude')),
      configPath: '~/.claude (manual)',
    },
    {
      name: 'OpenCode',
      key: 'opencode',
      detected: await dirExists(path.join(home, '.config', 'opencode')),
      configPath: path.join(home, '.config', 'opencode', 'config.json'),
    },
  ];

  const detected = editors.filter(e => e.detected);
  const notDetected = editors.filter(e => !e.detected);

  if (detected.length === 0) {
    p.log.warn('No supported editors detected.');
    p.log.info('Supported: Cursor, Claude Code, OpenCode');
    p.outro('Install a supported editor and run setup again.');
    return null;
  }

  // Show what was detected
  for (const e of detected) {
    p.log.success(`${pc.green('Found:')} ${e.name}`);
  }
  for (const e of notDetected) {
    p.log.info(`${pc.dim('Not found:')} ${e.name}`);
  }

  // Select which to configure
  const selected = await p.multiselect({
    message: 'Configure MCP for:',
    options: detected.map(e => ({
      value: e.key,
      label: e.name,
      hint: e.configPath,
    })),
    initialValues: detected.map(e => e.key),
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    return null;
  }

  const confirm = await p.confirm({
    message: `Configure ${(selected as string[]).length} editor(s)?`,
    initialValue: true,
  });

  if (p.isCancel(confirm) || !confirm) {
    p.cancel('Cancelled.');
    return null;
  }

  return { selectedEditors: selected as string[] };
}
