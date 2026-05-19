/**
 * Teclado táctil en pantalla.
 *
 * Uso:
 *   const destroy = mountKeyboard(containerEl);
 *   // Marcar cada input con data-kb="alpha" o data-kb="numeric"
 *   // El teclado aparece al enfocar un input marcado dentro de containerEl.
 *   destroy(); // limpia al salir de la pantalla
 *
 * El teclado se añade al body con position:fixed para no ser recortado.
 * Llama e.preventDefault() en mousedown para no sacar el foco del input.
 */

const ROWS_ALPHA_LOWER = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['SHIFT','z','x','c','v','b','n','m','⌫'],
  ['1','2','3','4','5','6','7','8','9','0'],
  ['@','.','_','-',' SPACE '],
];

const ROWS_ALPHA_UPPER = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['SHIFT','Z','X','C','V','B','N','M','⌫'],
  ['1','2','3','4','5','6','7','8','9','0'],
  ['@','.','_','-',' SPACE '],
];

const ROWS_NUMERIC = [
  ['7','8','9'],
  ['4','5','6'],
  ['1','2','3'],
  ['⌫','0','✓'],
];

export function mountKeyboard(container) {
  let activeInput = null;
  let shifted = false;
  let kbEl = null;

  // ── Focus tracking ─────────────────────────────────────────────────────────
  const onFocus = (e) => {
    const input = e.target;
    if (!input.matches('input[data-kb], select[data-kb]')) return;
    if (input.dataset.kb === 'none') return;
    activeInput = input;
    showKeyboard(input.dataset.kb || 'alpha');
    scrollInputIntoView(input);
  };

  const onBlur = (e) => {
    // If focus moves to keyboard key → the key's mousedown prevents this blur.
    // If focus moves outside the container entirely → hide keyboard.
    setTimeout(() => {
      const focused = document.activeElement;
      if (!container.contains(focused) && !kbEl?.contains(focused)) {
        hideKeyboard();
        activeInput = null;
      }
    }, 0);
  };

  container.addEventListener('focusin', onFocus);
  container.addEventListener('focusout', onBlur);

  // ── Keyboard rendering ──────────────────────────────────────────────────────
  function showKeyboard(mode) {
    if (kbEl) kbEl.remove();
    shifted = false;
    kbEl = buildKeyboard(mode);
    document.body.appendChild(kbEl);
    // Add bottom padding to container so keyboard doesn't cover inputs
    container.style.paddingBottom = kbEl.offsetHeight + 'px';
    // Recalculate after paint (height may change after layout)
    requestAnimationFrame(() => {
      if (kbEl) container.style.paddingBottom = kbEl.offsetHeight + 'px';
    });
  }

  function hideKeyboard() {
    if (kbEl) {
      kbEl.remove();
      kbEl = null;
    }
    container.style.paddingBottom = '';
  }

  function buildKeyboard(mode) {
    const el = document.createElement('div');
    el.className = 'kiosk-keyboard';
    el.dataset.mode = mode;
    renderKeys(el, mode);
    return el;
  }

  function renderKeys(el, mode) {
    el.innerHTML = '';
    const rows = mode === 'numeric'
      ? ROWS_NUMERIC
      : (shifted ? ROWS_ALPHA_UPPER : ROWS_ALPHA_LOWER);

    for (const row of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      for (const key of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'kb-key';

        const isSpecial = ['SHIFT', '⌫', ' SPACE ', '✓'].includes(key);
        if (isSpecial) btn.classList.add('kb-key--special');
        if (key === 'SHIFT' && shifted) btn.classList.add('kb-key--active');
        if (key === ' SPACE ') btn.classList.add('kb-key--space');
        if (key === '✓') btn.classList.add('kb-key--done');

        btn.textContent = key === ' SPACE ' ? 'espacio' : key;

        btn.addEventListener('mousedown', (e) => {
          e.preventDefault(); // Prevents blur on the focused input
        });

        btn.addEventListener('click', () => handleKey(key, mode, el));
        rowEl.appendChild(btn);
      }
      el.appendChild(rowEl);
    }
  }

  function handleKey(key, mode, el) {
    if (!activeInput) return;

    if (key === 'SHIFT') {
      shifted = !shifted;
      renderKeys(el, mode);
      return;
    }

    if (key === '⌫') {
      deleteChar(activeInput);
      return;
    }

    if (key === '✓') {
      // "Done" on numeric — move focus to next input or hide keyboard
      const inputs = [...container.querySelectorAll('input[data-kb], select[data-kb]')];
      const idx = inputs.indexOf(activeInput);
      if (idx >= 0 && idx < inputs.length - 1) {
        inputs[idx + 1].focus();
      } else {
        hideKeyboard();
        activeInput = null;
      }
      return;
    }

    const char = key === ' SPACE ' ? ' ' : key;
    insertChar(activeInput, char);

    // Auto-revert shift after a letter key
    if (shifted && key !== 'SHIFT' && /[A-ZÑ]/.test(key)) {
      shifted = false;
      renderKeys(el, mode);
    }
  }

  // ── Input manipulation ──────────────────────────────────────────────────────
  function insertChar(input, char) {
    if (input.maxLength > 0 && input.value.length >= input.maxLength) return;
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    input.value = input.value.slice(0, start) + char + input.value.slice(end);
    const pos = start + char.length;
    try { input.setSelectionRange(pos, pos); } catch { /* select */ }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function deleteChar(input) {
    const start = input.selectionStart ?? input.value.length;
    const end   = input.selectionEnd   ?? input.value.length;
    if (start !== end) {
      input.value = input.value.slice(0, start) + input.value.slice(end);
      try { input.setSelectionRange(start, start); } catch { /* select */ }
    } else if (start > 0) {
      input.value = input.value.slice(0, start - 1) + input.value.slice(end);
      try { input.setSelectionRange(start - 1, start - 1); } catch { /* select */ }
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Scroll ──────────────────────────────────────────────────────────────────
  function scrollInputIntoView(input) {
    setTimeout(() => {
      const kbHeight = kbEl ? kbEl.offsetHeight : 0;
      const rect = input.getBoundingClientRect();
      const viewBottom = window.innerHeight - kbHeight - 24;
      if (rect.bottom > viewBottom) {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  return function destroy() {
    container.removeEventListener('focusin', onFocus);
    container.removeEventListener('focusout', onBlur);
    hideKeyboard();
  };
}
