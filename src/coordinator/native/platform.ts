import type { LaunchContext } from '../launch-context.js';
import { createLaunchdAdapter } from './launchd.js';
import { createSystemdAdapter } from './systemd.js';
import type { CommandRunner, NativeServiceAdapter } from './types.js';

export type NativeManager = 'launchd' | 'systemd';

export type NativeManagerSelection =
  | { supported: true; manager: NativeManager }
  | { supported: false; platform: string; message: string };

/** macOS uses a launchd user agent, Linux a systemd user unit; every other platform is reported as unsupported. */
export function selectNativeManager(platform: NodeJS.Platform | string = process.platform): NativeManagerSelection {
  if (platform === 'darwin') return { supported: true, manager: 'launchd' };
  if (platform === 'linux') return { supported: true, manager: 'systemd' };
  return {
    supported: false,
    platform,
    message: `Native coordinator service management supports macOS (launchd) and Linux (systemd user manager); ${platform} is not supported. Run \`heimdall coordinator serve\` in the foreground instead.`,
  };
}

export interface NativeAdapterOptions {
  context: LaunchContext;
  platform?: NodeJS.Platform | string;
  runner?: CommandRunner;
  /** launchd only. */
  uid?: number;
  launchctl?: string;
  /** systemd only. */
  systemctl?: string;
  environment?: NodeJS.ProcessEnv;
}

export type NativeAdapterSelection =
  | { supported: true; manager: NativeManager; adapter: NativeServiceAdapter }
  | { supported: false; platform: string; message: string };

/** Create the adapter for the current (or given) platform with the same interface on both. */
export function selectNativeAdapter(options: NativeAdapterOptions): NativeAdapterSelection {
  const selection = selectNativeManager(options.platform);
  if (!selection.supported) return selection;
  if (selection.manager === 'launchd') {
    return { ...selection, adapter: createLaunchdAdapter({ context: options.context, runner: options.runner, uid: options.uid, launchctl: options.launchctl }) };
  }
  return { ...selection, adapter: createSystemdAdapter({ context: options.context, runner: options.runner, systemctl: options.systemctl, environment: options.environment }) };
}
