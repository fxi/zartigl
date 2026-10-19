export async function initializeAfterStaticRender<T>(
  renderStatic: () => void,
  initialize: () => Promise<T>,
): Promise<T> {
  renderStatic();
  return initialize();
}
