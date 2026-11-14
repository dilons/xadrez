// Início: criar sala, voltar para uma sala recente, jogar contra o computador.
import { h, replace, toast } from './dom.ts';
import { fmtDate } from './format.ts';
import { creatorKey, recentRooms } from './storage.ts';

export function mountHome(root: HTMLElement): void {
  document.title = 'Xadrez com os amigos';
  const createBtn = h('button', { type: 'button', class: 'btn btn-primary btn-big' }, 'Criar sala');
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const r = await fetch('/api/rooms', { method: 'POST' });
      const body = (await r.json()) as { code?: string; creatorKey?: string; error?: string };
      if (!r.ok || !body.code || !body.creatorKey) throw new Error(body.error ?? `erro ${r.status}`);
      creatorKey.set(body.code, body.creatorKey);
      location.assign(`/s/${body.code}`);
    } catch (e) {
      toast(`Não consegui criar a sala: ${(e as Error).message}`, 'error');
      createBtn.disabled = false;
    }
  });
  const recent = recentRooms.get();
  replace(
    root,
    h(
      'main',
      { class: 'home' },
      h(
        'section',
        { class: 'hero' },
        h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, '♞'),
        h('h1', null, 'Xadrez com os amigos'),
        h('p', { class: 'lead' }, 'Crie uma sala, mande o link para o grupo e jogue. Sem cadastro: cada pessoa entra só com um apelido.'),
        createBtn,
        h('p', { class: 'muted small' }, 'Na sala dá para abrir várias mesas, desafiar alguém, assistir às partidas e conversar.'),
      ),
      recent.length
        ? h(
            'section',
            { class: 'card recent' },
            h('h2', null, 'Suas salas recentes'),
            h(
              'ul',
              null,
              recent.map((r) => h('li', null, h('a', { href: `/s/${r.code}` }, `Sala ${r.code}`), h('span', { class: 'muted small' }, ` · ${fmtDate(r.at)}`))),
            ),
          )
        : null,
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'Sozinho?'),
        h('p', null, 'Treine contra o computador (Stockfish), direto no navegador, em oito níveis.'),
        h('a', { class: 'btn', href: '/bot' }, 'Jogar contra o computador'),
      ),
    ),
  );
}
