/**
 * 查看器安全渲染（S10-A，S10A-08）。
 *
 * 插件由第三方/内置模块提供，`render` 可能在解析或渲染阶段抛错。
 * 这里把「调用插件渲染」收敛成一个可测试的纯函数：失败时返回错误码，
 * 由宿主显示局部回退，**不影响**文档缓冲、dirty 标记或保存流程。
 *
 * 注意：这是**同一进程内的错误收敛**，不是沙箱（docs/02「容错限制」）。
 * 插件仍可读到全局对象；进程级隔离属于后续阶段。
 */

export interface RenderableViewer {
  render(input: { content: string; path: string }): unknown;
}

export type SafeRenderResult =
  | { ok: true; node: unknown }
  | { ok: false; errorCode: string; message: string };

export function renderViewerSafely(
  viewer: RenderableViewer,
  input: { content: string; path: string },
): SafeRenderResult {
  try {
    return { ok: true, node: viewer.render(input) };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'ERR_PLUGIN_CRASHED',
      message: (err as Error)?.message ?? '插件渲染失败',
    };
  }
}
