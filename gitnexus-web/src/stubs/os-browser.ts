// Browser stub for Node.js 'os' module.
// Used to satisfy AWS SDK imports that are never actually called in browser context
// (credentials come from user-provided config, not from ~/.aws/credentials).
export const homedir = () => '/';
export const platform = () => 'browser';
export const tmpdir = () => '/tmp';
export const EOL = '\n';
export const hostname = () => 'localhost';
export const networkInterfaces = () => ({});
export const cpus = () => [];
export const arch = () => 'x64';
export const type = () => 'Browser';
export default { homedir, platform, tmpdir, EOL, hostname, networkInterfaces, cpus, arch, type };
