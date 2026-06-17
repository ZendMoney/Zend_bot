/** Escape Telegram Markdown v1 special chars in user-generated text */
export function md(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/_/g, '＿')
    .replace(/\*/g, '•')
    .replace(/`/g, "'");
}

/** Escape legacy Markdown + strip HTML-like tags in user/AI text */
export function escapeTelegramMarkdown(text: string | undefined | null, maxLength = 200): string {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/([_*\[\`])/g, '\\$1');
  if (s.length > maxLength) {
    s = s.slice(0, maxLength - 1) + '…';
  }
  return s;
}