/** Independent of actor operation queues, so a long-running mutation cannot block enforcement. */
export function storageGuard(list: () => Promise<string[]>, enforce: (id: string) => Promise<unknown>, interval = 5000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const ids = await list();
      for (let at = 0; at < ids.length; at += 4)
        await Promise.allSettled(ids.slice(at, at + 4).map(enforce));
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick().catch(() => {}), interval);
  timer.unref();
  return () => clearInterval(timer);
}
