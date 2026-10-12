/** Only the control daemon retains its bearer. Executed project code uses UID 1000. */
export function projectEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([name]) =>
    !/^(BRIDGE_TOKEN|WORKER_TOKEN|STORAGE_LIMIT_MB|REPELLET_.*)$/.test(name),
  ));
}
export function projectIdentity() {
  return process.getuid?.() === 1002 ? { uid: 1000, gid: 1000 } : {};
}
