import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { LinuxDesktopSandbox } from './linux-desktop.js';

/**
 * The shared Linux desktop tools. Registered whether or not the owner has switched the feature on;
 * each one asks `LinuxDesktopSandbox` again, so turning the switch off, or the owner pressing
 * "Take over", stops work already under way instead of the tools quietly vanishing.
 */
const bounds = 'Only works while "Shared Linux desktop" is on in Settings. While the owner holds the desktop (they pressed "Take over"), every one of these, stopping and starting included, is refused until the owner hands it back; only the owner can.';
const OpenSchema = z.object({ app: z.string().trim().min(1).max(100).regex(/^[a-z0-9 ._-]+$/i, 'Use the plain name of a program') }).strict();
const TypeSchema = z.object({ text: z.string().min(1).max(4000) }).strict();
const KeySchema = z.object({ chord: z.string().trim().min(1).max(60) }).strict();

export function registerLinuxDesktop(registry: ToolRegistry, desktop: LinuxDesktopSandbox): void {
  registry.register({
    name: 'desktop.shared.start', permission: 'desktop.control',
    description: `Start (or reconnect to) the shared Linux desktop — a throwaway desktop of its own, drawn by Xvfb and served over VNC, that the owner may watch or take over. Gives back the address, display and password to connect a VNC viewer to. ${bounds}`,
    parameters: z.object({}).strict(),
    target: () => 'shared desktop',
    execute: (_input, context) => desktop.start(context.owner),
  });
  registry.register({
    name: 'desktop.shared.open', permission: 'desktop.control',
    description: `Start a program on the shared Linux desktop, by its plain name. ${bounds}`,
    parameters: OpenSchema,
    target: (input) => input.app,
    execute: (input, context) => desktop.act(context.owner, { type: 'open', app: input.app }),
  });
  registry.register({
    name: 'desktop.shared.type', permission: 'desktop.control',
    description: `Type text into whatever has focus on the shared Linux desktop. ${bounds}`,
    parameters: TypeSchema,
    target: () => 'shared desktop',
    execute: (input, context) => desktop.act(context.owner, { type: 'type', text: input.text }),
  });
  registry.register({
    name: 'desktop.shared.key', permission: 'desktop.control',
    description: `Press one key or key combination on the shared Linux desktop, such as "Return" or "ctrl+s". ${bounds}`,
    parameters: KeySchema,
    target: (input) => input.chord,
    execute: (input, context) => desktop.act(context.owner, { type: 'key', chord: input.chord }),
  });
  registry.register({
    name: 'desktop.shared.stop', permission: 'desktop.control',
    description: `Stop the shared Linux desktop and take its container down. ${bounds}`,
    parameters: z.object({}).strict(),
    target: () => 'shared desktop',
    execute: async (_input, context) => { await desktop.stop(context.owner); return { stopped: true }; },
  });
}
