export function nextStoryIndex(current: number, delta: number, sceneCount: number): number {
  if (sceneCount <= 0) return 0;
  return Math.max(0, Math.min(sceneCount - 1, current + delta));
}
