const users = new Map<string, number>();
const projects = new Map<string, number>();
export function reserveLanguage(userId: string, projectId: string) {
  const user = `${projectId}:${userId}`;
  if ((users.get(user) || 0) >= 4 || (projects.get(projectId) || 0) >= 8)
    throw new Error('Language service connection limit reached');
  users.set(user, (users.get(user) || 0) + 1);
  projects.set(projectId, (projects.get(projectId) || 0) + 1);
  let released = false;
  return () => {
    if (released) return; released = true;
    for (const [map, key] of [[users, user], [projects, projectId]] as const) {
      const count = map.get(key)! - 1;
      count ? map.set(key, count) : map.delete(key);
    }
  };
}
