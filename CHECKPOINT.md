# CHECKPOINT — Xadrez com os amigos

> **Data:** 14 de novembro de 2026 · **Código:** `main` (PRs #46 e #47); publicação no PR #49 (`feat/xadrez-publicacao`: IP real atrás da Cloudflare, `scripts/release.sh`, `scripts/espelho.sh` e rodapé com o código-fonte) · **Testes:** `npm test` (62), `npm run typecheck` e `npm run test:e2e` verdes, CI verde no #49.
>
> **Ainda não está no ar.** A branch `feat/xadrez` do kamino tem o manifesto, o túnel, o DNS e o backup, mas a imagem é um marcador (`sha256:000…`). O espelho público `github.com/dilons/xadrez` já existe e está com a pasta do PR #49. Falta, em ordem: mesclar o #49, gerar a imagem, abrir o PR no kamino (ver §7).

Este arquivo é o ponto de partida para continuar o desenvolvimento: o estado de cada fase, o que falta e as armadilhas já encontradas. O README descreve o app.

## 1. Fases

| Fase | Estado |
|---|---|
| 1. Sala, presença e reconexão | ✅ servidor, front e testes |
| 2. Mesa, partida com regras completas e espectadores | ✅ servidor, front e testes |
| 3. Relógio, desistência, empate, desconexão e revanche | ✅ servidor, front e testes (o e2e cobre revanche, pré-lance, voltar lance e empate) |
| 4. Chat e reações | ✅ servidor, front e testes (o e2e confere que o chat chega escapado) |
| 5. PGN, link permanente e revisão | ✅ `/p/<id>`: navegar pelos lances (botões, setas, clique na lista), copiar FEN, baixar e copiar PGN |
| 6. Bot (Stockfish no navegador) | ✅ `/bot`: Stockfish 19 lite single-thread num Web Worker, 8 níveis, partida guardada no `localStorage` |
| 7. Docker, CI, README e e2e com Playwright | ✅ escritos; o e2e passa localmente. `docker build` e o workflow `.github/workflows/xadrez.yml` ainda não rodaram (Docker parado nesta máquina, branch sem push) |

O domínio do servidor (`server/domain/`) foi escrito de uma vez para as fases 1 a 4, porque sala, mesa, partida e relógio se encaixam. Os testes e o front foram feitos e conferidos em ordem. Commits: fases 1–4, fases 5–6 e fase 7.

## 2. Como rodar

```bash
cd xadrez
npm install
npm run build          # gera o front em web/dist
npm start              # http://localhost:3000 (DB_PATH=./data/xadrez.db)
npm test               # unidade + integração (HTTP/WS/SQLite reais numa porta livre)
npm run typecheck      # servidor e front
```

Front com recarga automática: `npm run dev` (servidor) e, em outro terminal, `npm run dev:web` (Vite na 5173, repassando `/api` e `/ws`).

Para testar com duas pessoas na mesma máquina, abra uma aba em `localhost` e outra em `127.0.0.1`: são origens diferentes, então cada uma tem o próprio `localStorage` (a identidade da sala fica lá).

## 3. Conferido no navegador (14/11)

- Criar sala, entrar com apelido (criador marcado), segunda pessoa entrando, presença atualizando.
- Abrir mesa com cor escolhida, sentar, tabuleiro virado para as pretas, lances por clique, último lance destacado, relógio parado até o 2º lance e depois correndo só para quem está na vez, "Abortar" sumindo depois do 2º lance.
- Xeque-mate (1.e4 f6 2.Cc3 g5 3.Dh5#): resultado, rei em xeque destacado, botões de revanche e revisão.
- Revanche: pedido aparece para o adversário; aceita, as cores trocam.
- Chat da mesa: `<b>` aparece como texto.
- Recarregar a página volta para a mesma mesa (identidade no `localStorage`, `#m=<mesa>` no endereço).
- Lobby com miniatura da partida em andamento.
- Revisão `/p/<id>`: voltar lance pelo teclado, FEN certo, PGN para baixar com `Content-Disposition`; nenhum erro de CSP no console.
- Bot: 1.e4 respondido com 1...d5 pelo Stockfish no worker, sem erro de CSP (`'wasm-unsafe-eval'`).

- Pelo e2e (Chrome headless, um dos navegadores com tela de celular 390×844): presença de três pessoas, espectador pela miniatura, mate do louco visto pelos três, chat com `<img onerror>` aparecendo como texto, revisão com FEN e PGN, revanche, recarga voltando à mesa, pré-lance, voltar lance, empate por acordo, promoção (a janela com as quatro peças, `bxa8=D` na lista, duas damas no tabuleiro) e derrota por tempo (relógio personalizado de 15 s: fica vermelho com décimos abaixo de 10 s, zera, e o servidor encerra com "Bia venceu (tempo esgotado)", visto pelos dois jogadores e na lista de terminadas do lobby), abandono (Bia fecha o navegador; Ana vê "Bia · desconectado" e a contagem, o botão "Reivindicar vitória" só aparece depois da tolerância, e a vitória fica como abandono) e remoção (só o criador vê "Remover"; o removido vai para "Você saiu da sala", some da lista, e o id e o segredo antigos são recusados mesmo postos de volta no `localStorage`). No e2e a tolerância é de 5 s (`graceMs`), para o teste não esperar o minuto padrão.

- **Bot nos níveis 7 e 8 (14/11),** no Chrome com tela de celular, 6 respostas por nível, CPU normal e desacelerada 6× pelo DevTools:

  | Nível | Resposta | Maior intervalo entre quadros |
  |---|---|---|
  | 7 (profundidade 14 ou 0,9 s) | 0,09 a 0,56 s | 147 ms uma vez; 36 ms com CPU 6× |
  | 8 (profundidade 22 ou 1,5 s) | 1,0 a 1,6 s | 15 ms; 43 ms com CPU 6× |

  A tela não trava: o motor roda no Web Worker, e a thread principal só desenha. A desaceleração de CPU do DevTools vale para a página, não para o worker, então ela não simula um motor mais lento. Não precisa: o tempo por lance tem teto (`movetime`). Num celular fraco, o nível 8 continua respondendo em ~1,5 s, só que pensa menos fundo (no PC chega à profundidade ~22 a 600–850 mil nós/s). Não foi medido num aparelho de verdade.

## 4. Decisões

- **Tabuleiro: chessground (GPL-3.0).** O Stockfish (GPL-3.0) vai para o navegador de qualquer jeito, então a licença MIT do cm-chessboard não ajudaria; o chessground já traz pré-lance, destaques e toque no celular. O projeto é AGPL-3.0-only, como o repositório.
- **TypeScript sem build no servidor:** o Node 22.18+ remove os tipos sozinho. Só vale sintaxe "apagável" (`erasableSyntaxOnly` no tsconfig): nada de `enum`, `namespace` com valor ou parameter properties. Imports com extensão `.ts`.
- **SQLite pelo `node:sqlite`** (sem flag desde o Node 22.13). O aviso de experimental é silenciado em `server/main.ts`.
- **Todos na sala recebem os eventos de todas as mesas.** Não há "assinar mesa": os lances são pequenos e o lobby precisa deles para as miniaturas. Com o limite de 50 pessoas e 20 mesas por sala, cabe.
- **Relógio:** começa depois do primeiro lance de cada lado (como no Lichess); até lá, qualquer um dos dois pode abortar, sem registro. Voltar lance não devolve tempo. Depois de um restart, o tempo fora do ar não conta para ninguém.
- **Tripla repetição e 50 lances encerram sozinhos** (sem reivindicação), como no Lichess.
- **Derrota por tempo com material insuficiente:** aproximação conservadora em `canMate` (`server/domain/game.ts`): só rei, rei e uma peça menor contra rei sozinho, ou só bispos de uma cor de casa contra rei sozinho viram empate. Com qualquer material do outro lado, vale o mate de ajuda e é vitória.
- **Apelidos:** a comparação ignora caixa, acentos, espaços e caracteres invisíveis (`nickKey`), para ninguém se passar por outro. O apelido de quem foi removido continua reservado.
- **Criador:** `POST /api/rooms` devolve uma `creatorKey` de uso único; quem entra com ela vira o criador. O segredo dos jogadores é guardado só como sha-256.
- **Bot:** o Stockfish é copiado de `node_modules/stockfish/bin` para `web/public/stockfish/` pelo plugin do `vite.config.ts` (a pasta fica fora do Git), junto com o `COPYING.txt`. Os níveis combinam `Skill Level`, profundidade e tempo por lance (`web/src/bot/engine.ts`). As buscas vão em fila; voltar lance ou começar outra partida descarta a resposta pendente por um contador de geração.
- **Mini-torneio no futuro:** seria um dono de várias mesas com `challenged` fixo, mais uma tabela de pontos alimentada pelo fim das partidas (`gameEnded` em `room.ts`). Nada depende de mesa avulsa.

## 5. Armadilhas

- **O CSS das peças do chessground só vale dentro de `.cg-wrap`** (`.cg-wrap piece.queen.white`). Peças desenhadas fora do tabuleiro (janela de promoção, capturas) precisam de um container com `cg-wrap`, e de anular o `position: absolute` que o chessground põe nelas. Sem isso, os botões da promoção ficam vazios (achado pelo screenshot do e2e).
- No Playwright, `selectOption('7')` também compara rótulos: no seletor de nível, o rótulo "7" é da opção de valor 6. Use `selectOption({ value: '7' })`.
- As capturas mostram o desequilíbrio de material por tipo de peça (como no Lichess), não a contagem a partir da posição inicial: senão, um peão promovido aparece como "capturado".

- **Nunca use `viewOnly` no tabuleiro da partida.** O chessground só liga os eventos de mouse quando redesenha o tabuleiro. Na revanche as cores trocam, o tabuleiro vira (redesenho) ainda com o `viewOnly` da partida terminada, e fica sem resposta para sempre. Quem não pode mexer fica com `movable.color` indefinido. (Achado pelo e2e.)

- No navegador do app, navegar para a mesma URL só mudando o `#` não recarrega a página (é navegação dentro do documento). Para testar reconexão, use `location.reload()`.
- `Store.close()` acontece antes de os eventos de `close` dos WebSockets rodarem: o hub ignora `detach` depois de `stop()` (senão, "database is not open").
- O hub não reenvia ao próprio cliente as mensagens geradas pela entrada dele (ele já recebeu a sala inteira no `welcome`).
- Posições de teste com FEN: o chess.js recusa peões na 1ª/8ª fileira, e é fácil montar sem querer uma posição que já é afogamento ou xeque.

## 6. O que falta

1. ~~Rodar o CI e a imagem~~ feito: o CI roda em todo PR (Node 22 e 24, typecheck, e2e, `docker build`, container com uid 1000 e raiz somente leitura, trivy).
2. **Deploy:** ver §7.
3. **Bot num celular de verdade:** o tempo por lance tem teto, mas vale olhar aquecimento e bateria num aparelho fraco jogando vários lances no nível 8.
4. **Melhorias possíveis:** limite de partidas terminadas guardadas no banco (hoje cresce sem fim); tela de "sala cheia" mais amigável; acessibilidade do tabuleiro (o chessground não tem navegação por teclado).

## 7. Publicação no cluster (14/11)

**Decisões:** `xadrez.dilon.me` público (pelo túnel da Cloudflare) e `xadrez.internal.dilon.me` na LAN; o código-fonte (AGPL) fica num espelho público, `github.com/dilons/xadrez`, linkado no rodapé de toda página; caso de uso no kamino: partidas com amigos e família, o dilos confere a primeira partida real.

**No random (PR #49):**
- `server/ip.ts`: com `TRUST_PROXY=1`, vale o último salto do `X-Forwarded-For`; se ele estiver em `CF_TRUSTED_PEERS`, vale o `CF-Connecting-IP`. No cluster o traefik troca o `X-Forwarded-For` pelo IP do `cloudflared`; sem isso, todo visitante seria um IP só e os limites de 20 conexões e 20 salas por hora travariam o site. IPv6 conta por /64. Faixa inválida impede a subida.
- `scripts/espelho.sh [ref]`: manda a árvore de `xadrez/` daquele commit para o espelho, num commit só, com o e-mail noreply do GitHub (sem o histórico nem o e-mail pessoal). O espelho leva o que está na pasta, inclusive este arquivo e os nomes internos do `release.sh` (`registry.internal.dilon.me`, `freddy.internal.dilon.me`).
- `scripts/release.sh [ref]`: CI verde, espelho com a mesma árvore (`--sem-espelho` pula), tag nova, build `linux/amd64`, container testado como no pod (`/healthz`, `/`, o `.wasm`, criar sala, SQLite em `/data`), trivy, push e a branch no kamino. `KAMINO_BRANCH=<branch>` grava o digest numa branch existente.

**No kamino (branch `feat/xadrez`, sem PR):** `apps/web/xadrez.yaml` (uma réplica `Recreate`; SQLite em Longhorn, PVC `xadrez-longhorn`, porque banco não vai em NFS; uid 1000, raiz somente leitura, `/tmp` em emptyDir, sem token de service account; `PUBLIC_URL`, `TRUST_PROXY`, `CF_TRUSTED_PEERS=10.42.0.0/16,192.168.1.0/24` como no tarô; NetworkPolicy só com entrada do traefik e sem saída; um Ingress com os dois hosts), `web/xadrez` em `QUIESCE` e `QUIESCE_LONGHORN` do `coletar.sh`, CNAME e regra do túnel em `terraform/cloudflare/`, linha em `docs/pendencias/apps-sem-uso.md`. O `validar-manifests.py` passa.

**WebSocket:** nada a configurar no Ingress. O `readTimeout` de 60 s do Traefik 3 não corta WebSocket aberto: um WebSocket do PairDrop pelo traefik do cluster (3.7.4) ficou 130 s sem cair. Ping do cliente a cada 15 s e do servidor a cada 30 s, abaixo dos 100 s de ociosidade da Cloudflare.

**Para pôr no ar, nesta ordem:**
1. Mesclar o PR #49 no random (CI verde).
2. ~~Criar o repositório público `dilons/xadrez`~~ feito em 14/11, com a pasta do PR #49. Depois do merge, `xadrez/scripts/espelho.sh` (padrão: `origin/main`) só confirma que o espelho já está na versão; rode-o de novo sempre que `xadrez/` mudar. A pasta tem uma cópia do `LICENSE` da raiz, porque o espelho só leva `xadrez/`.
3. Com o Docker de pé (não subiu nesta máquina em 14/11): `KAMINO_BRANCH=feat/xadrez xadrez/scripts/release.sh`. Ele grava o digest e o commit na branch e roda o validador.
4. Abrir o PR `feat/xadrez` no Forgejo. Conferir com `argocd app diff apps --revision feat/xadrez`; o Atlantis faz o plan do `terraform/cloudflare`, e o **apply vem antes do merge** (regra do kamino). O merge é o deploy.
5. Depois do deploy: `curl -sS https://xadrez.internal.dilon.me/healthz`, uma partida entre duas pessoas (uma de fora de casa), e conferir no log ou no limite que o IP de quem vem pelo túnel é o público, não o do conector. A Cloudflare do plano gratuito já usa a única regra de rate limit no tarô; o xadrez conta com os limites do próprio app.

