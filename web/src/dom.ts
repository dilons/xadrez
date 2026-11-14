// Criação de elementos sem innerHTML: todo texto vira nó de texto (textContent), então texto de usuário
// (apelidos, chat) nunca é interpretado como HTML.

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler = (ev: Event) => void;
export interface Props {
  class?: string | (string | false | null | undefined)[];
  style?: Partial<Record<string, string>>;
  dataset?: Record<string, string>;
  [attr: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      else if (k === 'style') for (const [p, val] of Object.entries(v as Record<string, string>)) el.style.setProperty(p, val);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as Handler);
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`elemento não encontrado: ${sel}`);
  return el;
}

/** Aviso rápido no rodapé da tela. */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.appendChild(box);
  }
  const t = h('div', { class: ['toast', kind === 'error' && 'toast-error'], role: kind === 'error' ? 'alert' : 'status' }, text);
  box.appendChild(t);
  setTimeout(() => t.classList.add('toast-out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}
