#!/usr/bin/env bash
# Atualiza o espelho público do código-fonte (AGPL-3.0): github.com/dilons/xadrez recebe a pasta xadrez/ de um
# commit do random (privado). O rodapé do site aponta para lá, então rode isto antes de cada release; o
# scripts/release.sh recusa publicar uma versão que o espelho ainda não tem.
#
#   xadrez/scripts/espelho.sh [ref]          # padrão: origin/main
#   DRY_RUN=1 xadrez/scripts/espelho.sh      # mostra o commit que iria, sem enviar
#
# Cada atualização é UM commit com a árvore de xadrez/ (sem o histórico do random), e autor e committer são o
# endereço noreply do GitHub: nenhum e-mail pessoal nem arquivo de fora da pasta vai para o espelho.
set -euo pipefail

REF="${1:-origin/main}"
MIRROR_URL="${MIRROR_URL:-git@github.com:dilons/xadrez.git}"
IDENT_NAME="${MIRROR_NAME:-dilons}"
IDENT_EMAIL="${MIRROR_EMAIL:-92060252+dilons@users.noreply.github.com}"
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO"

git fetch -q origin
FULL_SHA="$(git rev-parse "$REF^{commit}")"
SHA="${FULL_SHA:0:7}"
SUBJECT="$(git log -1 --format=%s "$FULL_SHA")"
TREE="$(git rev-parse "$FULL_SHA:xadrez")"
echo "random@$SHA ($SUBJECT): xadrez/ = árvore $TREE"

PARENT=""
if git fetch -q "$MIRROR_URL" main 2>/dev/null; then
  PARENT="$(git rev-parse FETCH_HEAD)"
  if [[ "$(git rev-parse "$PARENT^{tree}")" == "$TREE" ]]; then
    echo "o espelho já está nesta versão ($PARENT)"
    exit 0
  fi
else
  echo "o espelho ainda não tem a branch main: este será o primeiro commit"
fi

COMMIT="$(
  GIT_AUTHOR_NAME="$IDENT_NAME" GIT_AUTHOR_EMAIL="$IDENT_EMAIL" \
  GIT_COMMITTER_NAME="$IDENT_NAME" GIT_COMMITTER_EMAIL="$IDENT_EMAIL" \
  git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "xadrez de random@$SHA" -m "$SUBJECT"
)"
git --no-pager log -1 --format='%h %an <%ae>%n%B' "$COMMIT"

if [[ "${DRY_RUN:-}" == 1 ]]; then
  echo "DRY_RUN: não enviei"
  exit 0
fi
git push -q "$MIRROR_URL" "$COMMIT:refs/heads/main"
echo "espelho atualizado: https://github.com/dilons/xadrez/tree/$COMMIT"
