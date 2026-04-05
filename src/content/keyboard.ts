// keyboard.ts — Global keydown listener that arms/disarms edit mode.
//
// We also handle the chrome.runtime.onMessage path for TOGGLE commands
// forwarded by the service worker from chrome.commands.

import { log } from '../shared/logger';

type ToggleCallback = () => void;

let toggleCb: ToggleCallback | null = null;

/** Register the function to call when the user triggers the toggle shortcut. */
export function registerToggleCallback(cb: ToggleCallback): void {
  toggleCb = cb;
}

/** Attach the global keydown listener. Call once from content/index.ts. */
export function attachKeyboardListener(): void {
  document.addEventListener('keydown', onKeyDown, { capture: true });
}

export function detachKeyboardListener(): void {
  document.removeEventListener('keydown', onKeyDown, { capture: true });
}

function onKeyDown(e: KeyboardEvent): void {
  // Ignore events fired inside our own host elements
  if ((e.target as Element)?.hasAttribute?.('data-lanthra-host')) return;

  // Cmd+Shift+L (mac) or Alt+Shift+L (other) — matches manifest command
  const isMac = navigator.platform.startsWith('Mac') || navigator.platform === 'iPhone';
  const isToggle = isMac
    ? e.metaKey && e.shiftKey && e.key.toLowerCase() === 'l'
    : e.altKey  && e.shiftKey && e.key.toLowerCase() === 'l';

  if (isToggle) {
    e.preventDefault();
    e.stopPropagation();
    log('info', 'keyboard toggle');
    toggleCb?.();
  }
}
