# Xadrez com os amigos

Xadrez online para jogar com amigos, sem cadastro, no modelo dos apps de planning poker: alguém cria uma sala, manda o link para o grupo, e cada pessoa entra só digitando um apelido. Não há contas, e-mail, senha, rating nem pareamento com desconhecidos.

- **Salas:** cada sala tem várias mesas ao mesmo tempo. Quem quiser abre uma mesa (tempo e cor) ou desafia alguém da lista; quem não está jogando assiste a qualquer partida em tempo real.
- **Regras completas no servidor:** roque, en passant, promoção com escolha da peça, xeque-mate, afogamento, tripla repetição, regra dos 50 lances e material insuficiente. O servidor valida todo lance e controla o relógio; o navegador nunca decide o resultado.
- **Partida:** relógio (1+0, 3+2, 5+0, 10+0, 15+10, sem tempo ou personalizado), desistir, propor empate, pedir para voltar o lance, revanche com as cores trocadas e vitória por abandono quando o adversário some.
- **Chat e reações** por sala e por partida.
- **Contra o computador:** Stockfish rodando no navegador, em 8 níveis, sem passar pelo servidor.
- **Revisão:** toda partida terminada ganha um link permanente `/p/<id>` para navegar pelos lances, copiar o FEN e baixar o PGN.

```bash
cd xadrez
npm install
npm run build        # front (Vite) em web/dist, com o Stockfish
npm start            # http://localhost:3000
npm test             # unidade e integração (node:test)
```

Requer Node.js 22.18 ou mais novo: o servidor é TypeScript rodando direto no Node, sem passo de compilação.

---

## Como funciona

### Sala

1. **Criar sala** (`POST /api/rooms`) gera um código de 10 caracteres (~49 bits, sem letras ambíguas) e uma chave de criador de uso único. A URL `/s/<código>` é o convite.
2. Quem abre o link escolhe um apelido. O servidor devolve um id aleatório e um segredo, que ficam no `localStorage` daquela sala: com eles a pessoa volta para o mesmo lugar depois de recarregar a página ou perder a conexão. O segredo só é enviado para a própria pessoa e fica guardado no servidor apenas como hash (sha-256).
3. O lobby mostra quem está na sala (conectado ou não), as mesas abertas, as partidas em andamento com miniatura do tabuleiro e as partidas terminadas.
4. Abrir uma mesa substitui a mesa aberta anterior da mesma pessoa. Uma pessoa joga uma partida por vez.
5. Salas sem ninguém conectado expiram depois de `ROOM_TTL_DAYS` (padrão: 7 dias). As partidas terminadas continuam acessíveis pelo link `/p/<id>`.

### Partida

- Os relógios começam depois do primeiro lance de cada lado. Até lá, qualquer um dos dois pode **abortar**, sem registro.
- **Derrota por tempo** decidida pelo servidor, por um timer e também conferida em cada ação. Se quem ficou não tem material para dar mate, é empate.
- **Empate:** a proposta cai quando o adversário joga. Propor quando o outro já propôs é aceitar.
- **Voltar lance:** se o adversário aceitar, volta o último lance de quem pediu (e a resposta do adversário, se já veio). Ninguém recebe tempo de volta.
- **Desconexão:** o relógio de quem saiu continua correndo. Depois de `DISCONNECT_GRACE_SECONDS` (padrão: 60), quem ficou pode reivindicar a vitória.
- **Revanche:** os dois pedem, a nova partida começa na mesma mesa com as cores trocadas.
- No tabuleiro: arrastar ou clicar, destaque do último lance, do xeque e dos lances legais, pré-lance, tabuleiro virado para quem joga de pretas, lista de lances (com as iniciais em português: R, D, T, B, C), peças capturadas, sons opcionais. Funciona no celular.

### Contra o computador

O Stockfish 19 no build "lite, single-threaded" (WebAssembly, 1,8 MB) roda num Web Worker. Por ser de thread única, não precisa de `SharedArrayBuffer` nem dos cabeçalhos COOP/COEP. A partida fica só no navegador (e no `localStorage`, para continuar depois de recarregar).

---

## Arquitetura

```
xadrez/
├── server/                 # Node 22, TypeScript direto (sem build)
│   ├── main.ts             # sobe tudo e trata SIGTERM
│   ├── app.ts              # HTTP + WebSocket + hub + banco (usado também nos testes)
│   ├── config.ts           # variáveis de ambiente
│   ├── http.ts             # estáticos do front, API e cabeçalhos de segurança (CSP etc.)
│   ├── ws.ts               # WebSocket: Origin, conexões por IP, tamanho máximo, ping
│   ├── ip.ts               # IP do visitante (X-Forwarded-For, CF-Connecting-IP), IPv6 por /64
│   ├── hub.ts              # conexões ↔ salas, limite de taxa, relógios, expiração
│   ├── validate.ts         # validação das mensagens do cliente
│   ├── store.ts            # SQLite (node:sqlite)
│   └── domain/             # lógica pura, sem rede (testada com node:test)
│       ├── room.ts         # sala: presença, mesas, partidas, chat, remoção
│       ├── game.ts         # partida sobre o chess.js, PGN
│       ├── clock.ts        # relógio
│       ├── limits.ts       # balde de fichas (limite de taxa)
│       └── text.ts         # limpeza de apelidos e chat
├── shared/protocol.ts      # tipos e constantes do protocolo (servidor e front)
├── web/                    # front: Vite + TypeScript, sem framework, tabuleiro chessground
│   └── src/  main.ts  home.ts  review.ts  board.ts  net.ts  room/  bot/
└── test/                   # node:test (unidade e integração) e e2e/ (Playwright)
```

**Estado:** salas e partidas ao vivo ficam na memória. A cada lance (e a cada mudança de mesa), um snapshot vai para o SQLite. Depois de um restart, o servidor recarrega salas, pessoas e partidas em andamento; o tempo em que ficou fora do ar não conta no relógio de ninguém.

### Tabelas do SQLite

| Tabela | Conteúdo |
|---|---|
| `rooms` | código, criador, hash da chave de criador, criada em, última atividade |
| `players` | sala, id, apelido, chave de comparação do apelido, hash do segredo, removido |
| `tables` | sala, id, snapshot JSON da mesa (com a partida: lances, relógio, ofertas, ausências) |
| `games` | partidas terminadas: apelidos, controle de tempo, resultado, motivo, PGN, FEN final, datas |
| `meta` | versão do esquema |

### Protocolo (WebSocket em `/ws`)

Mensagens JSON com `v` (versão, hoje 1) e `t` (tipo), validadas no servidor. Ao entrar, o cliente recebe a sala inteira (`welcome`); depois, só eventos. Cada lance leva o número de sequência (`seq`, o número de lances que o cliente já viu), e o servidor recusa repetidos e fora de ordem.

| Cliente → servidor | Servidor → cliente |
|---|---|
| `join` (apelido, ou id + segredo; chave de criador) | `welcome` (sala inteira; o segredo só na primeira vez) |
| `ping` | `pong` (hora do servidor, para o relógio local) |
| `table.open` (tempo, cor, desafiado), `table.sit`, `table.leave` | `table` (estado da mesa), `table.closed` |
| `move` (`seq`, UCI), `abort`, `resign` | `move` (SAN, FEN, relógio) |
| `draw` / `takeback` (`offer`/`request`, `accept`, `decline`) | `finished` (partida terminada, com o id do link) |
| `claim` (vitória por abandono), `rematch` | `player` (presença), `player.removed`, `kicked` |
| `chat`, `react` | `chat`, `react`, `error` (código e mensagem em português) |
| `kick` (só o criador) | |

Os tipos estão em `shared/protocol.ts`.

### API HTTP

| Rota | |
|---|---|
| `POST /api/rooms` | cria uma sala → `{ code, creatorKey }` (só da própria origem; limite por IP) |
| `GET /api/games/<id>` | partida terminada, com o PGN |
| `GET /api/games/<id>/pgn` | o PGN para baixar |
| `GET /healthz` | `{ ok, rooms, connections }` |

## Proteções

Como não há login, o servidor se defende sozinho:

- limite de salas criadas por IP por hora, de conexões simultâneas por IP (IPv6 por /64) e de mensagens por conexão (balde de fichas), além de limites próprios para chat e reações;
- limite de pessoas e de mesas por sala, e de salas no servidor;
- tamanho máximo de mensagem no WebSocket (`MAX_MESSAGE_BYTES`) e verificação de `Origin` no WebSocket e na criação de salas;
- apelidos de 1 a 20 caracteres, sem duplicata na sala: a comparação ignora maiúsculas, acentos, espaços e caracteres invisíveis;
- o segredo do jogador nunca vai para os outros clientes e fica guardado só como hash;
- o criador da sala pode remover alguém. A pessoa perde as partidas em andamento, e o segredo dela deixa de valer;
- todo texto de usuário vai para a tela por `textContent`, nunca como HTML. A CSP não permite script de fora nem inline (`'wasm-unsafe-eval'` só para o Stockfish), e não há Referer para outros sites, para o link da sala não vazar.

## Configuração

| Variável | Padrão | |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DB_PATH` | `./data/xadrez.db` (imagem: `/data/xadrez.db`) | arquivo do SQLite |
| `WEB_DIR` | `./web/dist` | front gerado |
| `PUBLIC_URL` | — | URL pública, usada no campo `Site` do PGN |
| `ALLOWED_ORIGINS` | — (só a do próprio `Host`) | origens aceitas no WebSocket, separadas por vírgula |
| `TRUST_PROXY` | `0` | `1`: o IP do cliente vem do último item de `X-Forwarded-For` |
| `CF_TRUSTED_PEERS` | — | com `TRUST_PROXY=1`: faixas CIDR (ou `cloudflare`) de quem entrega o tráfego da Cloudflare; vindo delas, o IP do cliente é o `CF-Connecting-IP` |
| `ROOM_TTL_DAYS` | `7` | sala sem ninguém conectado expira |
| `DISCONNECT_GRACE_SECONDS` | `60` | tolerância antes de poder reivindicar a vitória |
| `MAX_PLAYERS_PER_ROOM` / `MAX_TABLES_PER_ROOM` | `50` / `20` | |
| `ROOMS_PER_IP_PER_HOUR` | `20` | |
| `CONNECTIONS_PER_IP` | `20` | |
| `MESSAGES_PER_SECOND` / `MESSAGE_BURST` | `10` / `30` | por conexão |
| `MAX_MESSAGE_BYTES` | `4096` | |
| `MAX_ROOMS` | `5000` | salas na memória |

## Docker

```bash
docker build -t xadrez .
docker run -p 3000:3000 -v xadrez-data:/data xadrez
# ou
docker compose up -d --build
```

Imagem multi-stage (front gerado num estágio, dependências de produção em outro), base `node:22-bookworm-slim` fixada por digest, sem npm na imagem final, usuário `node`, `tini` como init, `HEALTHCHECK` em `/healthz` e volume em `/data`. É uma réplica só: o estado ao vivo está na memória do processo, então não escale horizontalmente.

### Atrás de um proxy reverso

O proxy precisa repassar o WebSocket em `/ws` (cabeçalhos `Upgrade` e `Connection`) sem cortar conexões ociosas cedo (o servidor manda ping a cada 30 s). Use `TRUST_PROXY=1` para os limites por IP valerem pelo IP real. Exemplo com nginx:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

**Pela Cloudflare** (proxy ou túnel), o último salto do `X-Forwarded-For` é a Cloudflare ou o `cloudflared`, igual para todo mundo, e os limites por IP bloqueariam o site inteiro. Defina `CF_TRUSTED_PEERS` com as faixas de quem entrega esse tráfego (por exemplo, a rede dos pods do `cloudflared`, ou `cloudflare` para as faixas públicas dela): vindo de lá, vale o `CF-Connecting-IP`. Sem `CF_TRUSTED_PEERS` o cabeçalho é ignorado, porque quem alcançasse a origem direto trocaria de IP a cada pedido. IPv6 conta por /64 nos limites.

No Traefik e no Caddy, o WebSocket passa sem configuração extra. O `Host` original precisa chegar ao app, porque a verificação de `Origin` o compara com ele; se o proxy trocar o `Host`, defina `ALLOWED_ORIGINS`.

## Testes

```bash
npm test               # unidade (sala, mesa, partida, relógio, chat) e integração (HTTP, WebSocket e SQLite reais)
npm run typecheck      # servidor, testes e front
npm run build && npm install --no-save playwright-core@1.65.1 && npx playwright-core install chromium
npm run test:e2e -- /tmp/shots   # três navegadores: sala, mesa, mate, espectador, chat, revisão, revanche, recarga
```

`BROWSER_CHANNEL=chrome` (ou `msedge`) usa o navegador instalado na máquina em vez de baixar o Chromium. No GitHub, `.github/workflows/xadrez.yml` roda tudo isso, gera a imagem, confere que o container sobe e passa o trivy.

## Licenças

O projeto é **AGPL-3.0-only**, como o resto do repositório. Dependências:

| Pacote | Uso | Licença |
|---|---|---|
| `chess.js` | regras (servidor e navegador) | BSD-2-Clause |
| `ws` | WebSocket | MIT |
| `chessground` | tabuleiro (inclui as peças cburnett) | GPL-3.0-or-later |
| `stockfish` (stockfish.js) | motor do bot, no navegador | GPL-3.0 |
| `vite`, `typescript` | build | MIT, Apache-2.0 |
| `playwright-core` | só nos testes, fora do `package.json` | Apache-2.0 |

O Stockfish é servido em `/stockfish/` junto com a licença (`COPYING.txt`); o código-fonte está em [github.com/nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js) e [github.com/official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish). Para atender à AGPL, o rodapé de toda página aponta para o código-fonte no espelho público [github.com/dilons/xadrez](https://github.com/dilons/xadrez), que só tem a pasta `xadrez/` deste repositório (privado). `scripts/espelho.sh` atualiza o espelho: rode antes de cada release. Quem publicar outra cópia do site precisa trocar esse link pelo próprio fonte (`web/index.html`).

O comportamento foi inspirado no "Jogar com um amigo" do Lichess e no PyChess, sem copiar código.
