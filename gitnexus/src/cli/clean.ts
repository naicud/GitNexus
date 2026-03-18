/**
 * Clean Command
 *
 * Removes the .gitnexus index from the current repository.
 * Also unregisters it from the global registry.
 */

export const cleanCommand = async (options?: { force?: boolean; all?: boolean; yes?: boolean }) => {
  const { cleanInteractive } = await import('./tui/formatters/clean-tui.js');
  await cleanInteractive(options);
};
