/**
 * QVAC Translation Service
 * Offline neural machine translation for African languages.
 * Enables users to interact with Zend in Hausa, Yoruba, Igbo, Pidgin, etc.
 */

import { translate, getTranslationModelId } from './index.js';

export type SupportedLang =
  | 'en'
  | 'ha' // Hausa
  | 'yo' // Yoruba
  | 'ig' // Igbo
  | 'pcm' // Nigerian Pidgin
  | 'sw' // Swahili
  | 'fr' // French
  | 'ar'; // Arabic

const LANG_NAMES: Record<string, string> = {
  en: 'English',
  ha: 'Hausa',
  yo: 'Yoruba',
  ig: 'Igbo',
  pcm: 'Nigerian Pidgin',
  sw: 'Swahili',
  fr: 'French',
  ar: 'Arabic',
};

/**
 * Translate text from source language to target language using QVAC NMT.
 */
export async function translateText(
  text: string,
  sourceLang: SupportedLang = 'en',
  targetLang: SupportedLang = 'en'
): Promise<string | null> {
  if (sourceLang === targetLang) return text;

  const modelId = await getTranslationModelId();
  if (!modelId) {
    console.warn('[QVAC Translate] Model not loaded');
    return null;
  }

  try {
    // QVAC translate API: pass source/target language codes
    const result = await translate({
      modelId,
      text,
      sourceLang,
      targetLang,
    });

    return result.trim();
  } catch (err: any) {
    console.error('[QVAC Translate] Failed:', err.message || err);
    return null;
  }
}

/**
 * Auto-detect likely Nigerian language from text heuristics.
 * Falls back to English.
 */
export function detectLanguage(text: string): SupportedLang {
  const lower = text.toLowerCase();

  // Pidgin markers
  if (/\b(dey|wahala|sharp|nawa|howfar|abeg|omo|gbese|chop)\b/.test(lower)) return 'pcm';

  // Hausa markers
  if (/\b(na|da|mai|yau|sannu|lafiya|ku|ka|ki)\b/.test(lower) && /[ãẽĩõũ]/.test(lower)) return 'ha';

  // Yoruba markers
  if (/[ṣẹ́ọ́àí]/.test(lower) || /\b(se|ni|mi|o|wa|ma|ko|ti)\b/.test(lower)) return 'yo';

  // Igbo markers
  if (/[ịụḅ]/.test(lower) || /\b(nke|na|a|m|i|ọ|ụ)\b/.test(lower)) return 'ig';

  return 'en';
}

/**
 * Translate user input to English for processing, then optionally translate response back.
 */
export async function translateForProcessing(
  userText: string
): Promise<{ english: string; originalLang: SupportedLang }> {
  const originalLang = detectLanguage(userText);
  if (originalLang === 'en') return { english: userText, originalLang: 'en' };

  const english = await translateText(userText, originalLang, 'en');
  return { english: english || userText, originalLang };
}

export function getLangName(code: SupportedLang): string {
  return LANG_NAMES[code] || 'English';
}
