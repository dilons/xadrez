// Página da sala (/s/<código>): entrada com apelido, conexão, cabeçalho com o convite, e a troca entre o lobby
// e a mesa (#m=<id> no endereço, para o "voltar" do navegador funcionar e o link continuar sendo o convite).
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';
import { LIMITS } from '../../../shared/protocol.ts';
import { copyText, h, replace, toast } from '../dom.ts';
import { Connection, type Status } from '../net.ts';
import { sound } from '../sound.ts';
import { creatorKey, identity, lastNick, recentRooms } from '../storage.ts';
import { GameScreen } from './game.ts';
import { Lobby } from './lobby.ts';
import { RoomState } from './state.ts';

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'conectando…',
  open: 'conectado',
  reconnecting: 'reconectando…',
  closed: 'desconectado',
};

export function mountRoom(root: HTMLElement, code: string): void {
  const s = new RoomState();
  let pendingNick: string | null = null;
  let conn: Connection | null = null;
  let lobby: Lobby | null = null;
  let screen: GameScreen | null = null;
  const statusEl = h('span', { class: 'conn-status', role: 'status' });
  const meEl = h('span', { class: 'me-nick' });
  const main = h('main', { class: 'room-main' });
  const inviteUrl = `${location.origin}/s/${code}`;

  document.title = `Sala ${code} · Xadrez`;
  replace(
    root,
    h(
      'header',
      { class: 'topbar' },
      h('a', { class: 'brand', href: '/' }, '♞ Xadrez'),
      h('span', { class: 'room-code', title: 'Código da sala' }, `Sala ${code}`),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-small btn-primary',
          onclick: async () => toast((await copyText(inviteUrl)) ? 'Link do convite copiado. Mande para o grupo!' : inviteUrl),
        },
        'Copiar convite',
      ),
      h('span', { class: 'spacer' }),
      meEl,
      statusEl,
    ),
    main,
  );

  const send = (m: ClientMessage): boolean => conn?.send(m) ?? false;

  function setStatus(st: Status): void {
    statusEl.textContent = STATUS_TEXT[st];
    statusEl.dataset.status = st;
  }

  // ---------------------------------------------------------- entrada

  function nickForm(error?: string): void {
    conn?.stop();
    conn = null;
    const input = h('input', {
      type: 'text',
      name: 'nick',
      maxlength: String(LIMITS.nickMax),
      required: true,
      autocomplete: 'nickname',
      value: lastNick.get(),
      placeholder: 'Seu apelido',
      'aria-label': 'Seu apelido',
      autofocus: true,
    });
    replace(
      main,
      h(
        'section',
        { class: 'card join-card' },
        h('h1', null, 'Entrar na sala'),
        h('p', { class: 'muted' }, 'Sem cadastro: escolha um apelido. Ele vale só nesta sala.'),
        error ? h('p', { class: 'form-error', role: 'alert' }, error) : null,
        h(
          'form',
          {
            class: 'join-form',
            onsubmit: (e: Event) => {
              e.preventDefault();
              const nick = input.value.trim();
              if (!nick) return;
              lastNick.set(nick);
              pendingNick = nick;
              replace(main, h('p', { class: 'muted center' }, 'Entrando…'));
              connect();
            },
          },
          input,
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'Entrar'),
        ),
      ),
    );
    input.focus();
  }

  function fatal(title: string, text: string): void {
    conn?.stop();
    conn = null;
    replace(
      main,
      h('section', { class: 'card join-card' }, h('h1', null, title), h('p', null, text), h('a', { class: 'btn btn-primary', href: '/' }, 'Ir para o início')),
    );
  }

  function connect(): void {
    conn = new Connection({
      joinMessage: () => {
        const id = identity.get(code);
        if (id) return { t: 'join', room: code, id: id.id, secret: id.secret };
        const key = creatorKey.get(code);
        return { t: 'join', room: code, nick: pendingNick ?? '', ...(key ? { creatorKey: key } : {}) };
      },
      onStatus: setStatus,
      onMessage,
    });
    conn.start();
  }

  // ---------------------------------------------------------- mensagens

  function onMessage(m: ServerMessage): void {
    if (m.t === 'error' && m.ref === 'join') {
      if (m.code === 'room-not-found') {
        recentRooms.remove(code);
        return fatal('Sala não encontrada', 'Essa sala não existe ou expirou por ficar vazia. Crie uma nova no início.');
      }
      if (m.code === 'removed') {
        identity.set(code, null);
        return fatal('Você saiu da sala', 'O criador da sala removeu você.');
      }
      if (m.code === 'bad-identity') identity.set(code, null);
      return nickForm(m.message);
    }
    if (m.t === 'kicked') {
      identity.set(code, null);
      return fatal('Você saiu da sala', 'O criador da sala removeu você.');
    }
    if (m.t === 'error') {
      if (m.ref === 'move') screen?.rejectPending();
      toast(m.message, 'error');
      return;
    }
    if (m.t === 'pong') return;

    const before = m.t === 'table' ? s.table(m.table.id) : undefined;
    const beforeGame = before?.game ? { id: before.game.id, result: before.game.result } : null;
    s.apply(m);
    if (s.desync) {
      // Perdemos algum evento: a reconexão traz a sala inteira de novo.
      s.desync = false;
      conn?.stop();
      connect();
      return;
    }

    if (m.t === 'welcome') {
      if (m.me.secret) identity.set(code, { id: m.me.id, secret: m.me.secret, nick: m.me.nick });
      creatorKey.set(code, null);
      recentRooms.add(code);
      meEl.textContent = m.me.nick;
      if (!lobby) {
        lobby = new Lobby(s, { send, watch: (id) => go(id) });
      }
      route();
      return;
    }

    if (m.t === 'table') {
      const g = m.table.game;
      const me = s.me?.id;
      const mine = !!g && (g.white === me || g.black === me);
      // Partida minha começando (alguém sentou, desafio aceito, revanche): vai para a mesa.
      if (g && mine && m.table.status === 'playing' && beforeGame?.id !== g.id) {
        sound.start();
        if (currentTable() !== m.table.id) go(m.table.id);
      }
      if (g?.result && beforeGame && !beforeGame.result && beforeGame.id === g.id && currentTable() === m.table.id) sound.end();
      if (m.table.status === 'open' && m.table.challenged === me && !before) {
        sound.notify();
        toast(`${s.nick(m.table.owner)} te desafiou!`);
      }
    }
    if (m.t === 'table.closed' && currentTable() === m.id) {
      toast('A mesa foi fechada.');
      go(null);
      return;
    }
    if (m.t === 'react') {
      const nick = s.nick(m.from);
      if (screen && m.channel === screen.tableId) screen.chat.burst(m.emoji, nick);
      else if (m.channel === 'room') lobby?.chat.burst(m.emoji, nick);
      return;
    }
    if (m.t === 'chat' && m.msg.from !== s.me?.id) sound.notify();
    refresh(m);
  }

  function refresh(m?: ServerMessage): void {
    if (screen) {
      if (m?.t === 'move' && m.table === screen.tableId) screen.onMove(m.san, m.seq);
      else screen.update();
    } else lobby?.render();
  }

  // ---------------------------------------------------------- rotas (#m=<mesa>)

  function currentTable(): string | null {
    const m = /^#m=([A-Za-z0-9_-]+)$/.exec(location.hash);
    return m ? m[1]! : null;
  }

  function go(tableId: string | null): void {
    const target = tableId ? `#m=${tableId}` : '';
    if (location.hash !== target) history.pushState(null, '', `${location.pathname}${target}`);
    route();
  }

  function route(): void {
    if (!s.room || !lobby) return;
    const id = currentTable();
    const t = id ? s.table(id) : undefined;
    if (id && !t) {
      history.replaceState(null, '', location.pathname);
      return route();
    }
    if (t) {
      if (screen?.tableId !== t.id) {
        screen?.destroy();
        screen = new GameScreen(s, t.id, { send, back: () => go(null), serverNow: () => conn?.serverNow() ?? Date.now() });
        replace(main, screen.el);
      } else screen.update();
    } else {
      screen?.destroy();
      screen = null;
      replace(main, lobby.el);
      lobby.render();
    }
  }

  window.addEventListener('popstate', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') conn?.nudge();
  });
  window.addEventListener('online', () => conn?.nudge());

  // ---------------------------------------------------------- início

  if (identity.get(code)) {
    replace(main, h('p', { class: 'muted center' }, 'Entrando…'));
    connect();
  } else nickForm();
}
