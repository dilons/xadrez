// Chat de um canal (a sala ou uma mesa) e reações rápidas. Texto de usuário só entra por textContent (h()).
import { LIMITS, REACTIONS, type ChatMessage } from '../../../shared/protocol.ts';
import { h, replace } from '../dom.ts';

export class ChatBox {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private input: HTMLInputElement;
  private shown = 0;
  private channel: string;
  private send: (text: string) => void;
  private react: (emoji: string) => void;

  constructor(o: { channel: string; title: string; send: (text: string) => void; react: (emoji: string) => void }) {
    this.channel = o.channel;
    this.send = o.send;
    this.react = o.react;
    this.list = h('ol', { class: 'chat-list', 'aria-live': 'polite', 'aria-label': `Mensagens: ${o.title}` });
    this.input = h('input', {
      class: 'chat-input',
      type: 'text',
      maxlength: String(LIMITS.chatMax),
      placeholder: 'Escreva uma mensagem…',
      'aria-label': 'Mensagem',
      autocomplete: 'off',
      enterkeyhint: 'send',
    });
    const form = h(
      'form',
      {
        class: 'chat-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const text = this.input.value.trim();
          if (!text) return;
          this.send(text);
          this.input.value = '';
        },
      },
      this.input,
      h('button', { type: 'submit', class: 'btn btn-small' }, 'Enviar'),
    );
    const reactions = h(
      'div',
      { class: 'reactions', role: 'group', 'aria-label': 'Reações rápidas' },
      REACTIONS.map((e) => h('button', { type: 'button', class: 'reaction-btn', 'aria-label': `Reagir ${e}`, onclick: () => this.react(e) }, e)),
    );
    this.el = h('section', { class: 'chat card' }, h('h3', null, o.title), this.list, reactions, form);
  }

  /** Atualiza com todas as mensagens da sala (filtra pelo canal) e rola para a última se houver novas. */
  update(all: ChatMessage[], myId: string | undefined): void {
    const msgs = all.filter((m) => m.channel === this.channel);
    if (msgs.length === this.shown && msgs.length > 0) return;
    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    replace(
      this.list,
      msgs.length === 0
        ? h('li', { class: 'chat-empty' }, 'Nenhuma mensagem ainda.')
        : msgs.map((m) =>
            h(
              'li',
              { class: ['chat-msg', m.from === myId && 'chat-mine'] },
              h('span', { class: 'chat-nick' }, m.nick),
              ' ',
              h('span', { class: 'chat-text' }, m.text),
            ),
          ),
    );
    if (atBottom || msgs.length > this.shown) this.list.scrollTop = this.list.scrollHeight;
    this.shown = msgs.length;
  }

  /** Mostra uma reação flutuando por cima do chat. */
  burst(emoji: string, nick: string): void {
    const b = h('div', { class: 'reaction-burst', 'aria-hidden': 'true' }, h('span', null, emoji), h('small', null, nick));
    b.style.left = `${10 + Math.random() * 70}%`;
    this.el.appendChild(b);
    setTimeout(() => b.remove(), 2200);
  }
}
