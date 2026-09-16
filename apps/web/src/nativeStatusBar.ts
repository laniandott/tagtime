export async function syncNativeStatusBarTheme(isDark = document.documentElement.classList.contains('dark')) {
  const Capacitor = (window as any).Capacitor
  if (!Capacitor?.isNativePlatform?.()) return

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    try { await StatusBar.setOverlaysWebView({ overlay: false }) } catch { /* noop */ }
    try {
      await StatusBar.setBackgroundColor({ color: isDark ? '#030712' : '#f9fafb' })
    } catch { /* Android 15+ may ignore status bar background colors. */ }
    try {
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light })
    } catch { /* noop */ }
  } catch { /* Browser builds do not have the native plugin. */ }
}
