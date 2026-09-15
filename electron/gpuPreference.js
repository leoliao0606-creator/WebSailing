// PRIME 必须在 GPU 子进程创建前配置。只影响本应用，不修改系统或浏览器设置。
export function gpuStartupPlan({ platform, env, argv, nvidiaAvailable }) {
  const defaults = { env: {}, switches: [] };
  if (platform !== 'linux' || !nvidiaAvailable || env.WINDCHASER_GPU === 'system'
    || env.WINDCHASER_SMOKE || argv.some(arg => /swiftshader|^--disable-gpu(?:=|$)/.test(arg))) return defaults;
  // 这两个变量只对 GLX（X11 会话）有效：那里它们让 GL 走独显。Wayland 会话用 EGL
  // 自行选卡，变量无效但也无害，所以无条件带上，不必判断当前是哪种会话。
  //
  // 不去强制 ozone-platform=x11。在 Wayland 会话里强切 XWayland 实测会让 GPU 子进程
  // 反复段错误（exit_code=11）、回退到软件位图渲染，严重时窗口起不来——比留在核显上
  // 慢得多。混合显卡下要真正吃到独显，应由系统侧的 PRIME 配置或启动器环境决定。
  return { env: { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' }, switches: [] };
}
