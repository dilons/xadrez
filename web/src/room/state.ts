// Estado da sala no navegador: começa pelo `welcome` (sala inteira) e é atualizado por eventos.
import type { RoomView, ServerMessage, TableView } from '../../../shared/protocol.ts';

export interface Me {
  id: string;
  nick: string;
}

export class RoomState {
  me: Me | null = null;
  room: RoomView | null = null;
  /** Instante (relógio do servidor) em que o relógio de cada mesa foi medido. */
  clockAt = new Map<string, number>();
  /** O estado ficou fora de sincronia (lance com seq inesperado): reconectar para receber tudo de novo. */
  desync = false;

  table(id: string): TableView | undefined {
    return this.room?.tables.find((t) => t.id === id);
  }

  nick(id: string): string {
    return this.room?.players.find((p) => p.id === id)?.nick ?? '?';
  }

  online(id: string): boolean {
    return this.room?.players.find((p) => p.id === id)?.online ?? false;
  }

  isCreator(): boolean {
    return !!this.me && this.room?.creator === this.me.id;
  }

  /** Aplica uma mensagem; devolve a mesa afetada (se houver), para quem desenha saber o que atualizar. */
  apply(m: ServerMessage): void {
    if (m.t === 'welcome') {
      this.me = { id: m.me.id, nick: m.me.nick };
      this.room = m.room;
      this.clockAt.clear();
      for (const t of m.room.tables) this.clockAt.set(t.id, m.now);
      this.desync = false;
      return;
    }
    const room = this.room;
    if (!room) return;
    switch (m.t) {
      case 'player': {
        const i = room.players.findIndex((p) => p.id === m.player.id);
        if (i >= 0) room.players[i] = m.player;
        else room.players.push(m.player);
        break;
      }
      case 'player.removed':
        room.players = room.players.filter((p) => p.id !== m.id);
        break;
      case 'table': {
        const i = room.tables.findIndex((t) => t.id === m.table.id);
        if (i >= 0) room.tables[i] = m.table;
        else room.tables.push(m.table);
        this.clockAt.set(m.table.id, m.now);
        break;
      }
      case 'table.closed':
        room.tables = room.tables.filter((t) => t.id !== m.id);
        room.chat = room.chat.filter((c) => c.channel !== m.id);
        this.clockAt.delete(m.id);
        break;
      case 'move': {
        const t = this.table(m.table);
        const g = t?.game;
        if (!g) break;
        if (m.seq !== g.moves.length + 1) {
          this.desync = true;
          break;
        }
        g.moves.push(m.uci);
        g.sans.push(m.san);
        g.fen = m.fen;
        g.clock = m.clock;
        // Lance novo cancela o pedido de volta; a oferta de empate cai se quem jogou não foi quem ofereceu.
        g.takebackRequest = null;
        const mover = m.seq % 2 === 1 ? 'w' : 'b';
        if (g.drawOffer && g.drawOffer !== mover) g.drawOffer = null;
        this.clockAt.set(m.table, m.now);
        break;
      }
      case 'finished':
        room.finished = [m.game, ...room.finished.filter((f) => f.id !== m.game.id)].slice(0, 30);
        break;
      case 'chat':
        room.chat.push(m.msg);
        if (room.chat.length > 500) room.chat.splice(0, room.chat.length - 500);
        break;
      default:
        break;
    }
  }
}
