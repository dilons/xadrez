#!/usr/bin/env bash
# Publica uma versão do xadrez: gera a imagem a partir de um commit do random, confere, envia ao registry
# e prepara no kamino a branch com o digest novo (o PR e o merge, que é o deploy, ficam com você).
#
#   xadrez/scripts/release.sh [--sem-ci] [--sem-espelho] [--sem-trivy] [--sem-kamino] [ref]   # padrão: origin/main
#   DRY_RUN=1 xadrez/scripts/release.sh          # gera e testa a imagem, sem push e sem kamino
#
# Antes de gerar a imagem, confere no GitHub que os checks do workflow xadrez passaram nesse commit
# (--sem-ci pula, de propósito), que o espelho público do código-fonte (AGPL, scripts/espelho.sh) já tem a pasta
# xadrez/ desse commit (--sem-espelho pula) e recusa uma tag que já exista no registry. O container é testado como roda no
# pod (uid 1000, raiz somente leitura, /tmp em tmpfs): /healthz, a página, o Stockfish e a criação de sala.
# Antes do push, roda o trivy (CRITICAL/HIGH com correção): o instalado ou, sem ele, a imagem oficial pelo docker.
# --sem-trivy pula, de propósito. --sem-kamino para depois do push e só imprime o digest.
# KAMINO_BRANCH=<branch> grava o digest numa branch do kamino que já existe (primeiro deploy: o manifesto ainda
# só está na branch do PR, feat/xadrez), em vez de criar feat/xadrez-<sha> a partir da main.
#
# Precisa de: docker (buildx), gh autenticado, acesso ao registry.internal.dilon.me e SSH no Forgejo
# (agente do Bitwarden destravado).
set -euo pipefail

SEM_CI=0
SEM_TRIVY=0
SEM_KAMINO=0
SEM_ESPELHO=0
REF=""
for arg in "$@"; do
  case "$arg" in
    --sem-ci) SEM_CI=1 ;;
    --sem-trivy) SEM_TRIVY=1 ;;
    --sem-kamino) SEM_KAMINO=1 ;;
    --sem-espelho) SEM_ESPELHO=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "opção desconhecida: $arg" >&2; exit 2 ;;
    *) [[ -z "$REF" ]] || { echo "só um ref, por favor" >&2; exit 2; }; REF="$arg" ;;
  esac
done
REF="${REF:-origin/main}"
REGISTRY="${REGISTRY:-registry.internal.dilon.me/xadrez}"
KAMINO_URL="${KAMINO_URL:-ssh://git@freddy.internal.dilon.me:2223/dilos/kamino.git}"
GH_REPO="${GH_REPO:-dilons/random}"
MIRROR_URL="${MIRROR_URL:-git@github.com:dilons/xadrez.git}"
# Jobs do .github/workflows/xadrez.yml (o nome do check-run é o do job, com a matriz entre parênteses).
CI_JOBS_RE='^(unidade|qualidade|navegador|imagem)( |$)'
MANIFEST="apps/web/xadrez.yaml"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
WORK="$(mktemp -d -t xadrez-release-XXXXXX)"
SMOKE=""
cleanup() {
  # -v: leva junto o volume anônimo de /data do teste.
  [[ -z "$SMOKE" ]] || docker rm -f -v "$SMOKE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
die() { echo "ERRO: $*" >&2; exit 1; }

say "commit"
git -C "$REPO" fetch -q origin
FULL_SHA="$(git -C "$REPO" rev-parse "$REF^{commit}")"
SHA="${FULL_SHA:0:7}"
SUBJECT="$(git -C "$REPO" log -1 --format=%s "$REF")"
# Merge de PR no GitHub: o assunto é "Merge pull request #N…", e o título do PR vem no corpo.
if [[ "$SUBJECT" == "Merge pull request"* ]]; then
  PR="$(sed -E 's/^Merge pull request (#[0-9]+).*/\1/' <<<"$SUBJECT")"
  SUBJECT="$(git -C "$REPO" log -1 --format=%b "$REF" | sed -n '/./{p;q}') ($PR)"
fi
echo "$REF = $SHA ($SUBJECT)"

say "CI"
if [[ "$SEM_CI" == 1 ]]; then
  echo "AVISO: --sem-ci, os checks do GitHub não foram conferidos"
else
  RUNS="$(gh api --paginate "repos/$GH_REPO/commits/$FULL_SHA/check-runs?per_page=100" \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "-")] | @tsv' | grep -E "$CI_JOBS_RE" || true)"
  [[ -n "$RUNS" ]] || die "nenhum check do workflow xadrez em $SHA (o CI rodou nesse commit?). Use --sem-ci para pular."
  printf '%s\n' "$RUNS" | sed 's/^/  /'
  BAD="$(awk -F'\t' '$2 != "completed" || ($3 != "success" && $3 != "skipped" && $3 != "neutral")' <<<"$RUNS")"
  [[ -z "$BAD" ]] || die "o CI de $SHA não passou (ou ainda está rodando). Use --sem-ci para pular."
  echo "CI OK"
fi

say "espelho do código-fonte (AGPL)"
if [[ "$SEM_ESPELHO" == 1 ]]; then
  echo "AVISO: --sem-espelho, o fonte oferecido no rodapé pode não ser o desta versão"
else
  git -C "$REPO" fetch -q "$MIRROR_URL" main || die "não consegui ler $MIRROR_URL (rode scripts/espelho.sh)"
  [[ "$(git -C "$REPO" rev-parse 'FETCH_HEAD^{tree}')" == "$(git -C "$REPO" rev-parse "$FULL_SHA:xadrez")" ]]     || die "o espelho não tem o xadrez/ de $SHA: rode xadrez/scripts/espelho.sh $SHA antes (ou --sem-espelho)"
  echo "espelho OK"
fi

say "tag"
if docker manifest inspect "$REGISTRY:$SHA" >/dev/null 2>&1; then
  die "$REGISTRY:$SHA já existe no registry; tags são imutáveis, não vou sobrescrever"
fi
echo "$REGISTRY:$SHA ainda não existe"

say "build"
mkdir -p "$WORK/src"
git -C "$REPO" archive "$SHA:xadrez" | tar -x -C "$WORK/src"
# O pod roda em node amd64 (nodeSelector no manifesto).
docker build --platform linux/amd64 -t "$REGISTRY:$SHA" "$WORK/src"

say "teste rápido do container"
SMOKE="xadrez-release-smoke-$SHA"
docker rm -f -v "$SMOKE" >/dev/null 2>&1 || true
# Como no pod: uid 1000, raiz somente leitura, /tmp em tmpfs; /data é o volume anônimo da imagem (dono node).
docker run -d --name "$SMOKE" -p 127.0.0.1::3000 \
  --user 1000:1000 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  "$REGISTRY:$SHA" >/dev/null
PORT="$(docker port "$SMOKE" 3000/tcp | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:$PORT"
if ! curl -fsS --retry 15 --retry-all-errors --retry-delay 1 "$BASE/healthz" >/dev/null; then
  docker logs "$SMOKE" >&2 || true
  die "o container não respondeu /healthz"
fi
curl -fsS "$BASE/" | grep -q '<div id="app">' || die "/ não devolveu a página do app"
curl -fsS -o /dev/null "$BASE/stockfish/stockfish-19-lite-single.wasm" || die "o Stockfish não está em /stockfish/"
# Criar sala: a Origin precisa ser a do próprio Host (a mesma conferência do navegador).
curl -fsS -X POST -H "Origin: $BASE" "$BASE/api/rooms" | grep -q '"creatorKey"' || die "POST /api/rooms falhou"
docker exec "$SMOKE" test -s /data/xadrez.db || die "o SQLite não foi criado em /data"
docker rm -f -v "$SMOKE" >/dev/null
SMOKE=""
echo "/healthz, página, Stockfish, sala e SQLite em /data OK"

say "trivy"
TRIVY_ARGS=(image --quiet --exit-code 1 --severity "CRITICAL,HIGH" --ignore-unfixed "$REGISTRY:$SHA")
if [[ "$SEM_TRIVY" == 1 ]]; then
  echo "AVISO: --sem-trivy, a imagem vai sem varredura de vulnerabilidades"
elif command -v trivy >/dev/null 2>&1; then
  trivy "${TRIVY_ARGS[@]}"
  echo "trivy OK"
else
  # Sem o binário, a imagem oficial (versão fixa) lê a imagem local pelo socket do docker.
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.69.3 "${TRIVY_ARGS[@]}"
  echo "trivy OK (via docker)"
fi

if [[ "${DRY_RUN:-}" == 1 ]]; then
  say "DRY_RUN: parando antes do push"
  exit 0
fi

say "push"
docker push -q "$REGISTRY:$SHA" >/dev/null
# O digest fixado é o do ÍNDICE (o mesmo formato dos outros pins do kamino), não o da plataforma.
DIGEST="$(docker buildx imagetools inspect "$REGISTRY:$SHA" | awk '/^Digest:/ {print $2; exit}')"
[[ "$DIGEST" == sha256:* ]] || die "não consegui ler o digest do índice"
echo "$REGISTRY@$DIGEST"

if [[ "$SEM_KAMINO" == 1 ]]; then
  say "pronto (--sem-kamino)"
  echo "Comentário e imagem para o $MANIFEST:"
  echo "  # random@$SHA: $SUBJECT"
  echo "  image: $REGISTRY@$DIGEST"
  exit 0
fi

say "kamino"
if [[ -n "${KAMINO_BRANCH:-}" ]]; then
  BRANCH="$KAMINO_BRANCH"
  git clone -q -b "$BRANCH" "$KAMINO_URL" "$WORK/kamino"
  cd "$WORK/kamino"
else
  git clone -q "$KAMINO_URL" "$WORK/kamino"
  cd "$WORK/kamino"
  BRANCH="feat/xadrez-$SHA"
  git switch -q -c "$BRANCH"
fi
[[ -f "$MANIFEST" ]] || die "$MANIFEST não existe em $BRANCH do kamino (primeiro deploy? KAMINO_BRANCH=feat/xadrez)"
grep -q "image: $REGISTRY@sha256:" "$MANIFEST" || die "não achei a linha image: em $MANIFEST"
sed -i -E "s|(image: $REGISTRY@)sha256:[0-9a-f]+|\1$DIGEST|" "$MANIFEST"
# O comentário logo acima da imagem diz de qual commit ela veio.
# O assunto do commit entra na expressão do sed: |, & e \ escapados (senão quebravam o comando ou viravam flags).
SUBJECT_SED="$(printf '%s' "$SUBJECT" | sed -e 's/[|&\\]/\\&/g')"
sed -i -E "s|^(\s*)# random@[0-9a-f]+:.*$|\1# random@$SHA: $SUBJECT_SED|" "$MANIFEST"
git --no-pager diff --stat
python3 scripts/ci/validar-manifests.py --base origin/main
git commit -q -am "feat(xadrez): imagem de random@$SHA" -m "$SUBJECT. linux/amd64; o digest é o do índice."
git push -q -u origin "$BRANCH"

say "pronto"
echo "Branch $BRANCH no kamino. Abra (ou atualize) o PR; o merge é o deploy:"
echo "  https://freddy.internal.dilon.me/dilos/kamino/compare/main...$BRANCH"
