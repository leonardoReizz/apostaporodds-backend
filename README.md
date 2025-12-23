# Backend - Servidor WebSocket

Servidor Node.js que recebe abertura de jogos via API REST e envia em tempo real para o frontend via WebSocket.

## Instalação

```bash
cd backend
npm install
```

## Execução

```bash
npm start
# ou para desenvolvimento com auto-reload
npm run dev
```

O servidor irá rodar na porta 3000.

## API Endpoints

### POST /api/games
Recebe a abertura de um novo jogo.

**Body:**
```json
{
  "id": "game1",
  "teamA": "São Paulo",
  "teamB": "Corinthians",
  "odds": 2.50
}
```

**Resposta:**
```json
{
  "success": true,
  "message": "Jogo adicionado com sucesso",
  "totalGames": 1
}
```

### GET /api/games
Lista todos os jogos ativos.

### DELETE /api/games/:id
Remove um jogo específico.

## WebSocket

O servidor envia atualizações em tempo real através do evento `games-update` contendo a lista de jogos ativos (máximo 2).

## Limitações

- O sistema mantém apenas 2 jogos ativos
- Quando um terceiro jogo é adicionado, o mais antigo é removido automaticamente

