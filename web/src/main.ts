// Rotas da SPA: / (início), /s/<código> (sala), /p/<id> (partida terminada), /bot (contra o computador).
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './style.css';
import { h, replace } from './dom.ts';
import { mountHome } from './home.ts';
import { mountRoom } from './room/page.ts';

const root = document.getElementById('app')!;
const path = location.pathname.replace(/\/+$/, '') || '/';

let m: RegExpExecArray | null;
if (path === '/') mountHome(root);
else if ((m = /^\/s\/([a-z0-9]{6,16})$/.exec(path))) mountRoom(root, m[1]!);
else if ((m = /^\/p\/([A-Za-z0-9]{6,16})$/.exec(path))) {
  const id = m[1]!;
  void import('./review.ts').then((r) => r.mountReview(root, id));
} else if (path === '/bot') void import('./bot/page.ts').then((b) => b.mountBot(root));
else
  replace(
    root,
    h('main', { class: 'room-main' }, h('section', { class: 'card join-card' }, h('h1', null, 'Página não encontrada'), h('a', { class: 'btn btn-primary', href: '/' }, 'Ir para o início'))),
  );
