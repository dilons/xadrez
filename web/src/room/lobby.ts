// Lobby da sala: presença, abrir mesa (tempo e cor), desafios, mesas abertas, partidas em andamento
// (com miniatura) e partidas terminadas.
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { ClientMessage, ColorChoice, TableView, TimeControl } from '../../../shared/protocol.ts';
import { LIMITS, TIME_PRESETS } from '../../../shared/protocol.ts';
import { cgColor, lastMoveOf } from '../board.ts';
import { h, replace } from '../dom.ts';
import { fmtDate, fmtTc, resultText } from '../format.ts';
import { ChatBox } from './chat.ts';
import type { RoomState } from './state.ts';

export interface LobbyActions {
  send(m: ClientMessage): void;
  watch(tableId: string): void;
}

const COLOR_LABEL: Record<ColorChoice, string> = { white: 'Brancas', black: 'Pretas', random: 'Sorteio' };

class Mini {
  readonly el: HTMLElement;
  private api: Api | null = null;
  private fen = '';

  constructor() {
    this.el = h('div', { class: 'mini-board' }, h('div', { class: 'cg-wrap' }));
  }

  update(fen: string, last?: string): void {
    if (fen === this.fen) return;
    this.fen = fen;
    const cfg = { fen, lastMove: lastMoveOf(last) };
    if (this.api) this.api.set(cfg);
    else
      requestAnimationFrame(() => {
        this.api = Chessground(this.el.firstElementChild as HTMLElement, {
          ...cfg,
          orientation: cgColor('w'),
          viewOnly: true,
          coordinates: false,
          animation: { enabled: true, duration: 150 },
          drawable: { enabled: false, visible: false },
        });
      });
  }

  destroy(): void {
    this.api?.destroy();
  }
}

export class Lobby {
  readonly el: HTMLElement;
  readonly chat: ChatBox;
  private s: RoomState;
  private a: LobbyActions;
  private challenges = h('div', { class: 'challenges' });
  private people = h('ul', { class: 'people' });
  private open = h('div', { class: 'table-list' });
  private playing = h('div', { class: 'game-grid' });
  private finished = h('ol', { class: 'finished-list' });
  private minis = new Map<string, Mini>();
  private tc: TimeControl | null = TIME_PRESETS[2]!.tc;
  private color: ColorChoice = 'random';

  constructor(s: RoomState, a: LobbyActions) {
    this.s = s;
    this.a = a;
    this.chat = new ChatBox({
      channel: 'room',
      title: 'Chat da sala',
      send: (text) => a.send({ t: 'chat', channel: 'room', text }),
      react: (emoji) => a.send({ t: 'react', channel: 'room', emoji }),
    });
    this.el = h(
      'div',
      { class: 'lobby' },
      this.challenges,
      h(
        'div',
        { class: 'lobby-main' },
        this.openForm(),
        h('section', { class: 'card' }, h('h2', null, 'Mesas abertas'), this.open),
        h('section', { class: 'card' }, h('h2', null, 'Partidas em andamento'), this.playing),
        h('section', { class: 'card' }, h('h2', null, 'Partidas terminadas'), this.finished),
      ),
      h(
        'aside',
        { class: 'lobby-side' },
        h('section', { class: 'card' }, h('h2', null, 'Na sala'), this.people),
        this.chat.el,
        h(
          'p',
          { class: 'muted small' },
          'Quer treinar sozinho? ',
          h('a', { href: '/bot', target: '_blank', rel: 'noopener' }, 'Jogue contra o computador'),
          '.',
        ),
      ),
    );
  }

  private openForm(): HTMLElement {
    const presetName = 'tc-preset';
    const custom = h('div', { class: 'custom-tc', hidden: true });
    const baseIn = h('input', { type: 'number', min: '0.25', max: '180', step: '0.25', value: '7', inputmode: 'decimal', 'aria-label': 'Minutos' });
    const incIn = h('input', { type: 'number', min: '0', max: '180', step: '1', value: '3', inputmode: 'numeric', 'aria-label': 'Incremento em segundos' });
    const readCustom = (): TimeControl | null => {
      const base = Math.round(Number(baseIn.value) * 60) * 1000;
      const inc = Math.round(Number(incIn.value)) * 1000;
      if (!Number.isFinite(base) || !Number.isFinite(inc)) return null;
      if (base < LIMITS.baseMinMs || base > LIMITS.baseMaxMs || inc < 0 || inc > LIMITS.incMaxMs) return null;
      return { baseMs: base, incMs: inc };
    };
    custom.append(
      h('label', null, 'Minutos ', baseIn),
      h('label', null, 'Incremento (s) ', incIn),
    );
    const presets = h(
      'div',
      { class: 'chips', role: 'radiogroup', 'aria-label': 'Controle de tempo' },
      [...TIME_PRESETS.map((p) => ({ label: p.label, tc: p.tc, custom: false })), { label: 'Personalizado', tc: null, custom: true }].map(
        (p, i) =>
          h(
            'label',
            { class: 'chip' },
            h('input', {
              type: 'radio',
              name: presetName,
              checked: i === 2,
              onchange: () => {
                custom.hidden = !p.custom;
                if (!p.custom) this.tc = p.tc;
              },
              dataset: { custom: p.custom ? '1' : '0' },
            }),
            h('span', null, p.label),
          ),
      ),
    );
    const colors = h(
      'div',
      { class: 'chips', role: 'radiogroup', 'aria-label': 'Sua cor' },
      (['white', 'random', 'black'] as ColorChoice[]).map((c) =>
        h(
          'label',
          { class: 'chip' },
          h('input', { type: 'radio', name: 'color', checked: c === this.color, onchange: () => (this.color = c) }),
          h('span', null, COLOR_LABEL[c]),
        ),
      ),
    );
    const readTc = (): TimeControl | null | undefined => {
      const isCustom = (presets.querySelector('input:checked') as HTMLInputElement | null)?.dataset.custom === '1';
      if (!isCustom) return this.tc;
      return readCustom() ?? undefined;
    };
    this.readTc = readTc;
    return h(
      'section',
      { class: 'card open-form' },
      h('h2', null, 'Abrir uma mesa'),
      h('p', { class: 'field-label' }, 'Tempo'),
      presets,
      custom,
      h('p', { class: 'field-label' }, 'Você joga de'),
      colors,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.openTable() }, 'Abrir mesa'),
        h('span', { class: 'muted small' }, 'Para desafiar alguém, use o botão ao lado do nome na lista “Na sala”.'),
      ),
    );
  }

  private readTc: () => TimeControl | null | undefined = () => this.tc;

  private openTable(challenged?: string): void {
    const tc = this.readTc();
    if (tc === undefined) {
      alert(`Tempo personalizado inválido: de 15 segundos a 180 minutos, incremento de 0 a 180 s.`);
      return;
    }
    this.a.send({ t: 'table.open', tc, color: this.color, ...(challenged ? { challenged } : {}) });
  }

  private colorLine(t: TableView, forMe: boolean): string {
    const owner = this.s.nick(t.owner);
    if (t.color === 'random') return 'cores sorteadas';
    if (forMe) return t.color === 'white' ? 'você joga de pretas' : 'você joga de brancas';
    return `${owner} de ${t.color === 'white' ? 'brancas' : 'pretas'}`;
  }

  render(): void {
    const s = this.s;
    const room = s.room;
    const me = s.me?.id;
    if (!room || !me) return;
    const busy = new Set<string>();
    for (const t of room.tables) if (t.status === 'playing' && t.game) busy.add(t.game.white).add(t.game.black);

    // Desafios para mim.
    const mine = room.tables.filter((t) => t.status === 'open' && t.challenged === me);
    replace(
      this.challenges,
      mine.map((t) =>
        h(
          'div',
          { class: 'challenge', role: 'alert' },
          h('strong', null, s.nick(t.owner)),
          ` te desafiou: ${fmtTc(t.tc)}, ${this.colorLine(t, true)}.`,
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.a.send({ t: 'table.sit', table: t.id }) }, 'Aceitar'),
          h('button', { type: 'button', class: 'btn', onclick: () => this.a.send({ t: 'table.leave', table: t.id }) }, 'Recusar'),
        ),
      ),
    );

    // Presença: conectados primeiro.
    const people = [...room.players].sort((a, b) => Number(b.online) - Number(a.online) || a.nick.localeCompare(b.nick, 'pt-BR'));
    replace(
      this.people,
      people.map((p) =>
        h(
          'li',
          { class: ['person', !p.online && 'offline'] },
          h('span', { class: ['dot', p.online && 'dot-on'], 'aria-label': p.online ? 'conectado' : 'desconectado' }),
          h('span', { class: 'person-nick' }, p.nick),
          p.id === me ? h('span', { class: 'badge' }, 'você') : null,
          p.creator ? h('span', { class: 'badge badge-alt' }, 'criador') : null,
          busy.has(p.id) ? h('span', { class: 'badge badge-game' }, 'jogando') : null,
          h(
            'span',
            { class: 'person-actions' },
            p.id !== me && p.online
              ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => this.openTable(p.id), title: 'Desafiar com o tempo e a cor escolhidos em “Abrir uma mesa”' }, 'Desafiar')
              : null,
            s.isCreator() && p.id !== me
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-small btn-danger',
                    onclick: () => {
                      if (confirm(`Remover ${p.nick} da sala? Se estiver jogando, perde a partida.`)) this.a.send({ t: 'kick', player: p.id });
                    },
                  },
                  'Remover',
                )
              : null,
          ),
        ),
      ),
    );

    // Mesas abertas.
    const open = room.tables.filter((t) => t.status === 'open');
    replace(
      this.open,
      open.length === 0
        ? h('p', { class: 'muted' }, 'Nenhuma mesa esperando. Abra uma!')
        : open.map((t) => {
            const own = t.owner === me;
            const forOther = t.challenged && t.challenged !== me && !own;
            return h(
              'div',
              { class: ['table-row', own && 'table-own'] },
              h('span', { class: 'table-tc' }, fmtTc(t.tc)),
              h(
                'span',
                { class: 'table-desc' },
                h('strong', null, own ? 'Você' : s.nick(t.owner)),
                ` · ${this.colorLine(t, false)}`,
                t.challenged ? ` · desafio para ${t.challenged === me ? 'você' : s.nick(t.challenged)}` : '',
              ),
              own
                ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => this.a.send({ t: 'table.leave', table: t.id }) }, 'Cancelar')
                : forOther
                  ? h('span', { class: 'muted small' }, 'reservada')
                  : h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => this.a.send({ t: 'table.sit', table: t.id }) }, 'Sentar'),
            );
          }),
    );

    // Em andamento (e as terminadas que ainda estão na mesa, esperando revanche).
    const live = room.tables.filter((t) => t.status !== 'open' && t.game);
    for (const [id, m] of this.minis)
      if (!live.some((t) => t.id === id)) {
        m.destroy();
        this.minis.delete(id);
      }
    replace(
      this.playing,
      live.length === 0
        ? h('p', { class: 'muted' }, 'Nenhuma partida agora.')
        : live.map((t) => {
            const g = t.game!;
            let mini = this.minis.get(t.id);
            if (!mini) this.minis.set(t.id, (mini = new Mini()));
            mini.update(g.fen, g.moves.at(-1));
            const mineGame = g.white === me || g.black === me;
            return h(
              'button',
              { type: 'button', class: 'game-card', onclick: () => this.a.watch(t.id), 'aria-label': `${g.whiteNick} contra ${g.blackNick}` },
              mini.el,
              h('span', { class: 'game-card-names' }, h('span', null, h('span', { class: 'side side-w' }), ` ${g.whiteNick}`), h('span', null, h('span', { class: 'side side-b' }), ` ${g.blackNick}`)),
              h(
                'span',
                { class: 'game-card-meta' },
                t.status === 'finished' && g.result ? `${g.result} · ` : '',
                fmtTc(t.tc),
                ` · ${mineGame ? 'sua partida' : t.status === 'finished' ? 'terminada' : 'assistir'}`,
              ),
            );
          }),
    );

    replace(
      this.finished,
      room.finished.length === 0
        ? h('li', { class: 'muted' }, 'Nenhuma partida terminada ainda.')
        : room.finished.map((f) =>
            h(
              'li',
              null,
              h('a', { href: `/p/${f.id}`, target: '_blank', rel: 'noopener' }, `${f.whiteNick} × ${f.blackNick}`),
              h('span', { class: 'muted small' }, ` ${resultText(f.result, f.reason, f.whiteNick, f.blackNick)} · ${fmtTc(f.tc)} · ${fmtDate(f.endedAt)}`),
            ),
          ),
    );

    this.chat.update(room.chat, me);
  }

  destroy(): void {
    for (const m of this.minis.values()) m.destroy();
    this.minis.clear();
  }
}
