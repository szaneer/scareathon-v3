export function termsPreviewMode(): 'terms' | 'terms-age' | null {
  if (!import.meta.env.DEV && import.meta.env.VITE_PREVIEW !== '1') return null;
  const preview = new URLSearchParams(window.location.search).get('preview');
  return preview === 'terms' || preview === 'terms-age' ? preview : null;
}
